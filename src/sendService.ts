import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from './logger.js';
import type { IdempotencyEntry, IdempotencyStore } from './idempotency.js';
import { normalizeServiceUrl, type ServiceUrlPolicy } from './serviceUrl.js';
import { classifyTeamsError, PreDispatchError, type TeamsFailure } from './teamsErrors.js';
import type { TeamsSender } from './teamsSender.js';

export const MAX_CARD_BYTES = 25 * 1024;

export type SendResponse = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

export type SendRequest = {
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  body: unknown;
};

export type SendServiceDeps = {
  token: string;
  idempotency: IdempotencyStore;
  /** Same policy as at install. The bot attaches a bearer token when it calls this URL, so it is checked on every send. */
  serviceUrlPolicy: ServiceUrlPolicy;
  sender: TeamsSender;
  logger: Logger;
  /** Total budget for one send, including token acquisition. Gertrude waits 10 s; Teams gets 8 s of it. */
  deadlineMs?: number;
  isDraining?: () => boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z
  .object({
    // The id becomes a path segment of the Teams URL (with a bearer token attached), so anything that could
    // change the path or query is refused. Real Teams ids (a:..., 19:...@thread.v2) never contain these.
    conversation_id: z
      .string()
      .min(1)
      .max(512)
      .refine((v) => !/[\/?#\\%\s\u0000-\u001f\u007f]/.test(v), 'conversation_id has characters that are not allowed'),
    service_url: z.string(),
    card: z.looseObject({ type: z.literal('AdaptiveCard') }),
    fallback_text: z.string().min(1).max(20_000),
  })
  .strict();

const unavailable: SendResponse = { status: 503, body: { status: 'unavailable' } };
const unknownResponse: SendResponse = { status: 409, body: { status: 'unknown' } };

export function bearerMatches(header: string | undefined, expected: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  // An empty expected or presented token never authenticates, even if both are empty.
  const nonEmpty = presented.length > 0 && expected.length > 0;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b) && nonEmpty;
}

export class SendService {
  private readonly deadlineMs: number;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly deps: SendServiceDeps) {
    this.deadlineMs = deps.deadlineMs ?? 9000;
  }

  /** Resolves when every send that has started has finished (shutdown). */
  async drain(timeoutMs: number): Promise<boolean> {
    if (this.inFlight.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const done = Promise.allSettled([...this.inFlight]).then(() => true as const);
    try {
      return await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  handle(req: SendRequest): Promise<SendResponse> {
    const p = this.process(req).catch((): SendResponse => {
      this.deps.logger.error('send_internal_error', { code: 'INTERNAL' });
      return unavailable;
    });
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
    return p;
  }

  private async process(req: SendRequest): Promise<SendResponse> {
    const { logger } = this.deps;
    if (this.deps.isDraining?.()) return unavailable;

    if (!bearerMatches(req.authorization, this.deps.token)) {
      return { status: 401, body: { status: 'unauthorized' } };
    }

    if (!req.idempotencyKey || !UUID.test(req.idempotencyKey)) {
      return invalid('Idempotency-Key header must be a UUID');
    }
    const key = req.idempotencyKey.toLowerCase();

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return invalid(describeIssues(parsed.error));
    const body = parsed.data;
    if (Buffer.byteLength(JSON.stringify(body.card), 'utf8') > MAX_CARD_BYTES) {
      return invalid('card exceeds 25 KB');
    }

    const serviceUrl = normalizeServiceUrl(body.service_url, this.deps.serviceUrlPolicy);
    if (!serviceUrl) return invalid('service_url is not allowed');

    const claim = this.deps.idempotency.claim(key, body.conversation_id);
    if (!claim.claimed) return this.replay(key, claim.entry, body.conversation_id);

    return this.deliver(key, { conversationId: body.conversation_id, serviceUrl }, body);
  }

  private async deliver(
    key: string,
    target: { conversationId: string; serviceUrl: string },
    body: z.infer<typeof bodySchema>,
  ): Promise<SendResponse> {
    const { logger, idempotency } = this.deps;
    let dispatched = false;
    let abandoned = false;
    let timer: NodeJS.Timeout | undefined;

    const attempt = this.deps.sender
      .send(
        target,
        { text: body.fallback_text, card: body.card },
        {
          onDispatched: () => {
            // The deadline already answered "not sent" and released the key: the request must not go out late.
            if (abandoned) throw new PreDispatchError('abandoned_before_dispatch');
            dispatched = true;
          },
        },
      )
      .then(
        (ok) => ({ ok: true as const, activityId: ok.activityId }),
        (err: unknown) => ({ ok: false as const, failure: classifyTeamsError(err, dispatched) }),
      );
    const deadline = new Promise<{ ok: false; failure: TeamsFailure }>((resolve) => {
      timer = setTimeout(() => {
        if (!dispatched) abandoned = true;
        resolve({
          ok: false,
          failure: dispatched
            ? { kind: 'unknown', code: 'deadline_after_dispatch' }
            : { kind: 'unavailable', code: 'deadline_before_dispatch' },
        });
      }, this.deadlineMs);
    });

    const result = await Promise.race([attempt, deadline]);
    clearTimeout(timer);
    // A response arriving after the deadline is ignored: the outcome below is final.

    if (result.ok) {
      idempotency.markSent(key, result.activityId);
      logger.info('send_sent', { delivery_id: key, status: 'sent' });
      return { status: 200, body: { status: 'sent', activity_id: result.activityId } };
    }

    return this.recordFailure(key, result.failure);
  }

  private recordFailure(key: string, failure: TeamsFailure): SendResponse {
    const { logger, idempotency } = this.deps;
    const log = { delivery_id: key, code: failure.code };
    switch (failure.kind) {
      case 'blocked':
        idempotency.markFailedPermanent(key, 'blocked_or_uninstalled');
        logger.warn('send_failed', { ...log, status: 'blocked_or_uninstalled' });
        return { status: 403, body: { status: 'blocked_or_uninstalled' } };
      case 'rejected':
        idempotency.markFailedPermanent(key, 'invalid_request');
        logger.error('send_failed', { ...log, status: 'invalid_request' });
        return { status: 400, body: { status: 'invalid_request', detail: 'Teams rejected the activity' } };
      case 'rate_limited': {
        idempotency.release(key);
        logger.warn('send_failed', { ...log, status: 'rate_limited' });
        const headers = failure.retryAfterSeconds === undefined ? undefined : { 'Retry-After': String(failure.retryAfterSeconds) };
        return { status: 429, body: { status: 'rate_limited' }, ...(headers ? { headers } : {}) };
      }
      case 'unavailable':
        idempotency.release(key);
        if (failure.code === 'teams_401_credentials' || failure.code === 'no_credentials') {
          logger.critical('send_failed', { ...log, status: 'unavailable' });
        } else {
          logger.warn('send_failed', { ...log, status: 'unavailable' });
        }
        return unavailable;
      case 'unknown':
        idempotency.markUnknown(key);
        logger.warn('send_failed', { ...log, status: 'unknown' });
        return unknownResponse;
    }
  }

  private replay(key: string, entry: IdempotencyEntry, conversationId: string): SendResponse {
    const { logger } = this.deps;
    if (entry.conversationId !== conversationId) return invalid('Idempotency-Key was already used for a different conversation');
    switch (entry.status) {
      case 'sent':
        logger.info('send_replayed', { delivery_id: key, status: 'sent' });
        return { status: 200, body: { status: 'sent', activity_id: entry.activityId, replayed: true } };
      case 'failed_permanent':
        logger.info('send_replayed', { delivery_id: key, status: entry.outcome ?? 'failed_permanent' });
        return entry.outcome === 'invalid_request'
          ? { status: 400, body: { status: 'invalid_request', detail: 'Teams rejected the activity' } }
          : { status: 403, body: { status: 'blocked_or_uninstalled' } };
      case 'unknown':
      case 'in_progress':
        logger.info('send_replayed', { delivery_id: key, status: 'unknown' });
        return unknownResponse;
    }
  }
}

function invalid(detail: string): SendResponse {
  return { status: 400, body: { status: 'invalid_request', detail } };
}

function describeIssues(err: z.ZodError): string {
  const fields = new Set<string>();
  let unknownKeys = false;
  for (const issue of err.issues) {
    if (issue.code === 'unrecognized_keys') unknownKeys = true;
    else fields.add(issue.path.join('.') || 'body');
  }
  const parts: string[] = [];
  if (fields.size) parts.push(`invalid field(s): ${[...fields].join(', ')}`);
  if (unknownKeys) parts.push('unknown field(s) not allowed');
  return parts.join('; ') || 'invalid body';
}
