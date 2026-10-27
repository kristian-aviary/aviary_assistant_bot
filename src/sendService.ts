import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from './logger.js';
import type { ConversationReferenceStore, IdempotencyRow, IdempotencyStore } from './repositories.js';
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
  references: ConversationReferenceStore;
  idempotency: IdempotencyStore;
  sender: TeamsSender;
  logger: Logger;
  /** Total budget for one send, including token acquisition. Gertrude waits 10 s; Teams gets 8 s of it. */
  deadlineMs?: number;
  isDraining?: () => boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z
  .object({
    user_id: z.string().min(1).max(512),
    card: z.looseObject({ type: z.literal('AdaptiveCard') }),
    fallback_text: z.string().min(1).max(20_000),
  })
  .strict();

const unavailable: SendResponse = { status: 503, body: { status: 'unavailable' } };
const unknownResponse: SendResponse = { status: 409, body: { status: 'unknown' } };

export function bearerMatches(header: string | undefined, expected: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
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

    const existing = await this.deps.idempotency.find(key);
    if (existing) return this.replay(key, existing, body.user_id);

    const ref = await this.deps.references.get(body.user_id);
    if (!ref) {
      logger.info('send_no_reference', { delivery_id: key, status: 'no_reference' });
      return { status: 404, body: { status: 'no_reference' } };
    }

    const claim = await this.deps.idempotency.claim(key, body.user_id);
    if (!claim.claimed) return this.replay(key, claim.row, body.user_id);

    return this.deliver(key, ref, body);
  }

  private async deliver(
    key: string,
    ref: { conversationId: string; serviceUrl: string },
    body: z.infer<typeof bodySchema>,
  ): Promise<SendResponse> {
    const { logger, idempotency } = this.deps;
    let dispatched = false;
    let abandoned = false;
    let timer: NodeJS.Timeout | undefined;

    const attempt = this.deps.sender
      .send(
        { conversationId: ref.conversationId, serviceUrl: ref.serviceUrl },
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
      try {
        await idempotency.markSent(key, result.activityId);
      } catch {
        // Teams accepted it. The row stays in_progress, which replays as unknown: safe, never a duplicate.
        logger.error('send_state_write_failed', { delivery_id: key, code: 'STATE_WRITE_AFTER_SENT' });
      }
      logger.info('send_sent', { delivery_id: key, status: 'sent' });
      return { status: 200, body: { status: 'sent', activity_id: result.activityId } };
    }

    return this.recordFailure(key, result.failure);
  }

  private async recordFailure(key: string, failure: TeamsFailure): Promise<SendResponse> {
    const { logger, idempotency } = this.deps;
    const log = { delivery_id: key, code: failure.code };
    try {
      switch (failure.kind) {
        case 'blocked':
          await idempotency.markFailedPermanent(key, 'blocked_or_uninstalled');
          logger.warn('send_failed', { ...log, status: 'blocked_or_uninstalled' });
          return { status: 403, body: { status: 'blocked_or_uninstalled' } };
        case 'rejected':
          await idempotency.markFailedPermanent(key, 'invalid_request');
          logger.error('send_failed', { ...log, status: 'invalid_request' });
          return { status: 400, body: { status: 'invalid_request', detail: 'Teams rejected the activity' } };
        case 'rate_limited': {
          await idempotency.release(key);
          logger.warn('send_failed', { ...log, status: 'rate_limited' });
          const headers = failure.retryAfterSeconds === undefined ? undefined : { 'Retry-After': String(failure.retryAfterSeconds) };
          return { status: 429, body: { status: 'rate_limited' }, ...(headers ? { headers } : {}) };
        }
        case 'unavailable':
          await idempotency.release(key);
          if (failure.code === 'teams_401_credentials' || failure.code === 'no_credentials') {
            logger.critical('send_failed', { ...log, status: 'unavailable' });
          } else {
            logger.warn('send_failed', { ...log, status: 'unavailable' });
          }
          return unavailable;
        case 'unknown':
          await idempotency.markUnknown(key);
          logger.warn('send_failed', { ...log, status: 'unknown' });
          return unknownResponse;
      }
    } catch {
      // State could not be written. The key stays in_progress (replays as unknown), so the
      // answer must not claim a clean failure: ambiguous is the only safe thing to say.
      logger.error('send_state_write_failed', { delivery_id: key, code: 'STATE_WRITE_AFTER_FAILURE' });
      return unknownResponse;
    }
  }

  private replay(key: string, row: IdempotencyRow, userId: string): SendResponse {
    const { logger } = this.deps;
    if (row.userId !== userId) return invalid('Idempotency-Key was already used for a different user');
    switch (row.status) {
      case 'sent':
        logger.info('send_replayed', { delivery_id: key, status: 'sent' });
        return { status: 200, body: { status: 'sent', activity_id: row.activityId, replayed: true } };
      case 'failed_permanent':
        logger.info('send_replayed', { delivery_id: key, status: row.outcome ?? 'failed_permanent' });
        return row.outcome === 'invalid_request'
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
