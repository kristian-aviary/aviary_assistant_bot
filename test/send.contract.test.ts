import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALLOWED_SERVICE_URL, CONVERSATION_ID, FALLBACK_TEXT, sampleCard, sendBody as staticBody } from './helpers/constants.js';
import { FakeTeamsSender, httpError, netError } from './helpers/fakeSender.js';
import { createHarness, type Harness } from './helpers/harness.js';
import { assertCleanLogsAfterAll, captureLogs } from './helpers/logs.js';

const logs = captureLogs();
assertCleanLogsAfterAll(logs);

let h: Harness;
const sender = new FakeTeamsSender();

beforeAll(async () => {
  h = await createHarness({ sender, logs, sendDeadlineMs: 400 });
});
afterAll(async () => {
  await h.stop();
});
beforeEach(() => {
  sender.reset();
});

const sendBody = (overrides: Record<string, unknown> = {}) => h.body(overrides);
/** The stored idempotency state for a key, in the shape these tests assert on (undefined when the key is free). */
const rowFor = (key: string) => {
  const e = h.idempotency.find(key);
  return e ? { status: e.status, outcome: e.outcome, activity_id: e.activityId } : undefined;
};

describe('POST /v1/send: contract section 2 result table', () => {
  it('200 sent: passes the card through unchanged with fallback_text as the message text', async () => {
    const card = sampleCard({ extra: { nested: [1, 2, 3] } });
    sender.enqueue({ type: 'ok', activityId: 'act-xyz' });
    const r = await h.send(sendBody({ card }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'sent', activity_id: 'act-xyz' });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]!.message).toEqual({ text: FALLBACK_TEXT, card });
    expect(sender.calls[0]!.target).toEqual({ conversationId: CONVERSATION_ID, serviceUrl: h.serviceUrl.replace(/\/$/, '') });
    expect(rowFor(r.key)).toMatchObject({ status: 'sent', activity_id: 'act-xyz' });
  });

  it('200 replayed: a key that was already sent answers the stored result and never calls Teams again', async () => {
    sender.enqueue({ type: 'ok', activityId: 'act-1' });
    const first = await h.send();
    const second = await h.send(sendBody(), { key: first.key });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: 'sent', activity_id: 'act-1', replayed: true });
    expect(sender.calls).toHaveLength(1);
  });

  it('200 sent with no activity id from Teams still answers sent', async () => {
    sender.enqueue({ type: 'ok', activityId: null });
    const r = await h.send();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'sent', activity_id: null });
  });

  describe.each([403, 404])('Teams %i (not installed / blocked / conversation gone)', (status) => {
    it('403 blocked_or_uninstalled, stored as failed_permanent, replayed without calling Teams', async () => {
      sender.enqueue({ type: 'fail', error: httpError(status), dispatched: true });
      const r = await h.send();
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ status: 'blocked_or_uninstalled' });
      expect(rowFor(r.key)).toMatchObject({ status: 'failed_permanent', outcome: 'blocked_or_uninstalled' });

      const replay = await h.send(sendBody(), { key: r.key });
      expect(replay.status).toBe(403);
      expect(replay.body).toEqual({ status: 'blocked_or_uninstalled' });
      expect(sender.calls).toHaveLength(1);
    });
  });

  describe('400 invalid_request', () => {
    it.each([
      ['not JSON', 'not json at all'],
      ['empty object', {}],
      ['missing conversation_id', { service_url: ALLOWED_SERVICE_URL, card: sampleCard(), fallback_text: 'x' }],
      ['missing service_url', { conversation_id: CONVERSATION_ID, card: sampleCard(), fallback_text: 'x' }],
      ['missing card', { conversation_id: CONVERSATION_ID, service_url: ALLOWED_SERVICE_URL, fallback_text: 'x' }],
      ['missing fallback_text', { conversation_id: CONVERSATION_ID, service_url: ALLOWED_SERVICE_URL, card: sampleCard() }],
      ['card is a string', staticBody({ card: 'AdaptiveCard' })],
      ['card is an array', staticBody({ card: [sampleCard()] })],
      ['card type is wrong', staticBody({ card: { type: 'HeroCard' } })],
      ['unknown top-level key', staticBody({ extra: true })],
      ['user_id is rejected (the bot never learns an Assistant user)', staticBody({ user_id: 'samlp|aviary|someone' })],
      ['reference is rejected (Gertrude owns it)', staticBody({ reference: { channelId: 'msteams' } })],
      ['conversation_id is a number', staticBody({ conversation_id: 42 })],
      ['empty conversation_id', staticBody({ conversation_id: '' })],
      ['conversation_id longer than 512', staticBody({ conversation_id: 'a'.repeat(513) })],
      ['service_url is a number', staticBody({ service_url: 42 })],
      ['service_url not on the allowlist', staticBody({ service_url: 'https://evil.example.com/emea/' })],
      ['empty fallback_text', staticBody({ fallback_text: '' })],
    ])('%s', async (_name, body) => {
      const r = await h.send(body);
      expect(r.status).toBe(400);
      expect(r.body.status).toBe('invalid_request');
      expect(typeof r.body.detail).toBe('string');
      expect(sender.calls).toHaveLength(0);
      expect(rowFor(r.key)).toBeUndefined();
    });

    it('card larger than 25 KB', async () => {
      const card = sampleCard({ body: [{ type: 'TextBlock', text: 'x'.repeat(26 * 1024) }] });
      const r = await h.send(sendBody({ card }));
      expect(r.status).toBe(400);
      expect(r.body.detail).toContain('25 KB');
      expect(sender.calls).toHaveLength(0);
    });

    it('card just under 25 KB is accepted', async () => {
      const card = sampleCard({ body: [{ type: 'TextBlock', text: 'x'.repeat(24 * 1024) }] });
      const r = await h.send(sendBody({ card }));
      expect(r.status).toBe(200);
    });

    it('missing or malformed Idempotency-Key', async () => {
      expect((await h.send(sendBody(), { key: null })).status).toBe(400);
      const bad = await h.send(sendBody(), { key: 'not-a-uuid' });
      expect(bad.status).toBe(400);
      expect(bad.body.detail).toContain('Idempotency-Key');
      expect(sender.calls).toHaveLength(0);
    });

    it('conversation_id at exactly 512 characters is accepted', async () => {
      const r = await h.send(sendBody({ conversation_id: 'a'.repeat(512) }));
      expect(r.status).toBe(200);
    });

    it('the same key reused for a different conversation is refused, without calling Teams', async () => {
      const first = await h.send();
      const other = await h.send(sendBody({ conversation_id: 'a:2-someone-else' }), { key: first.key });
      expect(other.status).toBe(400);
      expect(other.body.status).toBe('invalid_request');
      expect(sender.calls).toHaveLength(1);
    });

    it('never echoes request content in the error detail', async () => {
      const r = await h.send(sendBody({ card: { type: 'HeroCard', secret: 'SECRET-CARD-TEXT-quarterly-numbers' } }));
      expect(JSON.stringify(r.body)).not.toContain('SECRET');
    });

    it('Teams answering another 4xx (for example 400 or 413) is a permanent invalid_request, replayed without calling Teams', async () => {
      sender.enqueue({ type: 'fail', error: httpError(400), dispatched: true });
      const r = await h.send();
      expect(r.status).toBe(400);
      expect(r.body.status).toBe('invalid_request');
      expect(rowFor(r.key)).toMatchObject({ status: 'failed_permanent', outcome: 'invalid_request' });
      const replay = await h.send(sendBody(), { key: r.key });
      expect(replay.status).toBe(400);
      expect(sender.calls).toHaveLength(1);
    });
  });

  describe('retryable: the key is released so Gertrude can send again', () => {
    it('429 rate_limited with Retry-After', async () => {
      sender.enqueue({ type: 'fail', error: httpError(429, { 'retry-after': '7' }), dispatched: true });
      const r = await h.send();
      expect(r.status).toBe(429);
      expect(r.body).toEqual({ status: 'rate_limited' });
      expect(r.headers.get('retry-after')).toBe('7');
      expect(rowFor(r.key)).toBeUndefined();

      sender.enqueue({ type: 'ok', activityId: 'act-after-429' });
      const retry = await h.send(sendBody(), { key: r.key });
      expect(retry.status).toBe(200);
      expect(retry.body.replayed).toBeUndefined();
      expect(sender.calls).toHaveLength(2);
    });

    it('429 without Retry-After omits the header', async () => {
      sender.enqueue({ type: 'fail', error: httpError(429), dispatched: true });
      const r = await h.send();
      expect(r.status).toBe(429);
      expect(r.headers.get('retry-after')).toBeNull();
    });

    it.each([
      ['Teams 503', httpError(503), true],
      ['Teams 401 (our own bot credentials are wrong)', httpError(401), true],
      ['DNS failure', netError('ENOTFOUND'), false],
      ['connection refused', netError('ECONNREFUSED'), false],
      ['TLS handshake failure', netError('ERR_TLS_CERT_ALTNAME_INVALID'), false],
      ['token acquisition failed before the request', new Error('msal failure'), false],
    ])('503 unavailable: %s', async (_name, error, dispatched) => {
      sender.enqueue({ type: 'fail', error, dispatched });
      const r = await h.send();
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ status: 'unavailable' });
      expect(rowFor(r.key)).toBeUndefined();
      const retry = await h.send(sendBody(), { key: r.key });
      expect(retry.status).toBe(200);
    });

    it('503 and release when the deadline passes before the request was dispatched (slow token), and the late request is blocked', async () => {
      sender.enqueue({ type: 'hang', dispatched: false });
      const r = await h.send();
      expect(r.status).toBe(503);
      expect(rowFor(r.key)).toBeUndefined();
    });
  });

  it('a request that only reaches the transport after the deadline is blocked, so the released key cannot cause a duplicate', async () => {
    const outcome: { dispatchBlocked?: boolean; dispatched?: boolean } = {};
    sender.enqueue({ type: 'late', ms: 700, outcome });
    const r = await h.send();
    expect(r.status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(outcome).toEqual({ dispatchBlocked: true });
    expect(rowFor(r.key)).toBeUndefined();
  });

  describe('409 unknown: Teams may have accepted it', () => {
    it.each([
      ['timeout after the request was written', netError('ECONNABORTED')],
      ['connection reset', netError('ECONNRESET')],
      ['socket timeout', netError('ETIMEDOUT')],
      ['Teams 500', httpError(500)],
      ['Teams 502', httpError(502)],
      ['Teams 504', httpError(504)],
      ['Teams 408', httpError(408)],
      ['an unmapped 3xx', httpError(302)],
      ['an error with no code after dispatch', new Error('boom')],
    ])('%s', async (_name, error) => {
      sender.enqueue({ type: 'fail', error, dispatched: true });
      const r = await h.send();
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ status: 'unknown' });
      expect(rowFor(r.key)).toMatchObject({ status: 'unknown' });
    });

    it('the deadline firing after dispatch is unknown, and a late success never upgrades it', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      sender.enqueue({ type: 'gate', gate });
      const r = await h.send();
      expect(r.status).toBe(409);
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rowFor(r.key)).toMatchObject({ status: 'unknown', activity_id: null });
    });

    it('replay of a stored unknown answers 409 and never calls the sender again', async () => {
      sender.enqueue({ type: 'fail', error: netError('ECONNRESET'), dispatched: true });
      const first = await h.send();
      expect(first.status).toBe(409);
      for (let i = 0; i < 3; i++) {
        const again = await h.send(sendBody(), { key: first.key });
        expect(again.status).toBe(409);
        expect(again.body).toEqual({ status: 'unknown' });
      }
      expect(sender.calls).toHaveLength(1);
    });

    it('a key left in_progress (for example a send cut off at shutdown) replays as 409 unknown', async () => {
      const key = randomUUID();
      expect(h.idempotency.claim(key, CONVERSATION_ID)).toEqual({ claimed: true });
      const r = await h.send(sendBody(), { key });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ status: 'unknown' });
      expect(sender.calls).toHaveLength(0);
    });
  });

  describe('concurrency', () => {
    it('two simultaneous requests with the same key produce one Teams call (loser sees 409 while in flight)', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      sender.enqueue({ type: 'gate', gate, then: { type: 'ok', activityId: 'act-race' } });
      const key = randomUUID();
      const first = h.send(sendBody(), { key });
      await waitFor(() => sender.calls.length === 1);
      const second = await h.send(sendBody(), { key });
      expect(second.status).toBe(409);
      expect(second.body).toEqual({ status: 'unknown' });
      release();
      const firstResult = await first;
      expect(firstResult.status).toBe(200);
      expect(firstResult.body).toEqual({ status: 'sent', activity_id: 'act-race' });
      expect(sender.calls).toHaveLength(1);
    });

    it('ten simultaneous requests with the same key: exactly one Teams call, one fresh 200, the rest 409 or replayed', async () => {
      const key = randomUUID();
      const results = await Promise.all(Array.from({ length: 10 }, () => h.send(sendBody(), { key })));
      expect(sender.calls).toHaveLength(1);
      const fresh = results.filter((r) => r.status === 200 && !r.body.replayed);
      expect(fresh).toHaveLength(1);
      for (const r of results) {
        expect([200, 409]).toContain(r.status);
        if (r.status === 409) expect(r.body).toEqual({ status: 'unknown' });
      }
    });

    it('different keys do not block each other', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => h.send()));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(sender.calls).toHaveLength(5);
    });
  });

  it('unknown routes answer 404 JSON and wrong methods on /v1/send are not sends', async () => {
    const res = await fetch(`${h.baseUrl}/v1/nope`);
    expect(res.status).toBe(404);
    const get = await fetch(`${h.baseUrl}/v1/send`);
    expect(get.status).toBe(404);
    expect(sender.calls).toHaveLength(0);
  });
});

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
