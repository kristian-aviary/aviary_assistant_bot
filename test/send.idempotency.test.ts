import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDEMPOTENCY_MAX_ENTRIES, IDEMPOTENCY_TTL_MS, InMemoryIdempotencyStore } from '../src/idempotency.js';
import { SendService } from '../src/sendService.js';
import { DEFAULT_SERVICE_URL_HOSTS } from '../src/serviceUrl.js';
import { CONVERSATION_ID, SEND_TOKEN, sendBody } from './helpers/constants.js';
import { FakeTeamsSender, httpError, netError } from './helpers/fakeSender.js';
import { captureLogs, expectCleanLogs } from './helpers/logs.js';

const HOUR = 60 * 60 * 1000;

let clock: { t: number };
let sender: FakeTeamsSender;
let store: InMemoryIdempotencyStore;
let logs: ReturnType<typeof captureLogs>;
let service: SendService;

function build(maxEntries?: number) {
  store = new InMemoryIdempotencyStore({ now: () => clock.t, maxEntries });
  service = new SendService({
    token: SEND_TOKEN,
    idempotency: store,
    serviceUrlPolicy: { allowedHosts: DEFAULT_SERVICE_URL_HOSTS },
    sender,
    logger: logs.logger,
    deadlineMs: 300,
  });
}

beforeEach(() => {
  clock = { t: Date.UTC(2026, 9, 28, 12, 0, 0) };
  sender = new FakeTeamsSender();
  logs = captureLogs();
  build();
});

const send = (key: string, over: Record<string, unknown> = {}) =>
  service.handle({ authorization: `Bearer ${SEND_TOKEN}`, idempotencyKey: key, body: sendBody(over) });

describe('idempotency (in memory, injected clock)', () => {
  it('first call sends once; the second with the same key replays sent and does not call Teams', async () => {
    const key = randomUUID();
    sender.enqueue({ type: 'ok', activityId: 'act-1' });
    const first = await send(key);
    expect(first).toMatchObject({ status: 200, body: { status: 'sent', activity_id: 'act-1' } });
    expect(first.body.replayed).toBeUndefined();

    const second = await send(key);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: 'sent', activity_id: 'act-1', replayed: true });
    expect(sender.calls).toHaveLength(1);
  });

  it('the key is case-insensitive (a UUID is the same UUID in upper case)', async () => {
    const key = randomUUID();
    await send(key);
    const again = await send(key.toUpperCase());
    expect(again.body.replayed).toBe(true);
    expect(sender.calls).toHaveLength(1);
  });

  it('concurrent same-key calls send exactly once; the loser gets 409 unknown while the first is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    sender.enqueue({ type: 'gate', gate, then: { type: 'ok', activityId: 'act-race' } });
    const key = randomUUID();
    const winner = send(key);
    const losers = await Promise.all([send(key), send(key), send(key)]);
    for (const l of losers) expect(l).toMatchObject({ status: 409, body: { status: 'unknown' } });
    release();
    expect(await winner).toMatchObject({ status: 200, body: { status: 'sent', activity_id: 'act-race' } });
    expect(sender.calls).toHaveLength(1);
    expect((await send(key)).body).toMatchObject({ replayed: true });
  });

  it('many concurrent same-key calls: exactly one Teams call and exactly one fresh 200', async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 25 }, () => send(key)));
    expect(sender.calls).toHaveLength(1);
    expect(results.filter((r) => r.status === 200 && !r.body.replayed)).toHaveLength(1);
    for (const r of results) expect([200, 409]).toContain(r.status);
  });

  describe.each([
    ['Teams 429', httpError(429, { 'retry-after': '4' }), true, 429],
    ['Teams 503', httpError(503), true, 503],
    ['DNS failure before the request was written', netError('ENOTFOUND'), false, 503],
    ['connection refused', netError('ECONNREFUSED'), false, 503],
  ])('a clean transient failure (%s)', (_name, error, dispatched, status) => {
    it('releases the key so the retry sends', async () => {
      const key = randomUUID();
      sender.enqueue({ type: 'fail', error, dispatched });
      const first = await send(key);
      expect(first.status).toBe(status);
      expect(store.find(key)).toBeNull();

      sender.enqueue({ type: 'ok', activityId: 'act-retry' });
      const retry = await send(key);
      expect(retry).toMatchObject({ status: 200, body: { status: 'sent', activity_id: 'act-retry' } });
      expect(retry.body.replayed).toBeUndefined();
      expect(sender.calls).toHaveLength(2);
    });
  });

  it('429 carries Retry-After when Teams sent one', async () => {
    sender.enqueue({ type: 'fail', error: httpError(429, { 'retry-after': '7' }), dispatched: true });
    const r = await send(randomUUID());
    expect(r.headers).toEqual({ 'Retry-After': '7' });
  });

  describe.each([
    ['connection reset after the request was written', netError('ECONNRESET')],
    ['timeout after dispatch', netError('ECONNABORTED')],
    ['Teams 500', httpError(500)],
    ['Teams 504', httpError(504)],
  ])('an ambiguous failure (%s)', (_name, error) => {
    it('stores unknown; every later call with that key is 409 unknown and Teams is not called again', async () => {
      const key = randomUUID();
      sender.enqueue({ type: 'fail', error, dispatched: true });
      expect((await send(key)).status).toBe(409);
      expect(store.find(key)?.status).toBe('unknown');
      for (let i = 0; i < 3; i++) {
        const again = await send(key);
        expect(again).toMatchObject({ status: 409, body: { status: 'unknown' } });
      }
      expect(sender.calls).toHaveLength(1);
    });
  });

  it('the deadline firing after dispatch is unknown, and a late success never upgrades it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    sender.enqueue({ type: 'gate', gate });
    const key = randomUUID();
    expect((await send(key)).status).toBe(409);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(store.find(key)).toMatchObject({ status: 'unknown', activityId: null });
    expect((await send(key)).status).toBe(409);
    expect(sender.calls).toHaveLength(1);
  });

  it.each([
    [403, 403, { status: 'blocked_or_uninstalled' }],
    [404, 403, { status: 'blocked_or_uninstalled' }],
    [400, 400, { status: 'invalid_request', detail: 'Teams rejected the activity' }],
  ])('a permanent Teams %i is stored and replayed as %i without calling Teams', async (teams, status, body) => {
    const key = randomUUID();
    sender.enqueue({ type: 'fail', error: httpError(teams), dispatched: true });
    expect(await send(key)).toMatchObject({ status, body });
    expect(store.find(key)?.status).toBe('failed_permanent');
    for (let i = 0; i < 2; i++) expect(await send(key)).toMatchObject({ status, body });
    expect(sender.calls).toHaveLength(1);
  });

  describe('the same key with a different conversation_id', () => {
    it('after sent: 400 invalid_request, nothing sent, the stored result is untouched', async () => {
      const key = randomUUID();
      await send(key);
      const other = await send(key, { conversation_id: 'a:another-conversation' });
      expect(other.status).toBe(400);
      expect(other.body.status).toBe('invalid_request');
      expect(JSON.stringify(other.body)).not.toContain('another-conversation');
      expect(sender.calls).toHaveLength(1);
      expect((await send(key)).body).toMatchObject({ status: 'sent', replayed: true });
    });

    it('while the first is in flight: 400, not a second send', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      sender.enqueue({ type: 'gate', gate });
      const key = randomUUID();
      const first = send(key);
      expect((await send(key, { conversation_id: 'a:another-conversation' })).status).toBe(400);
      release();
      expect((await first).status).toBe(200);
      expect(sender.calls).toHaveLength(1);
    });

    it('after a permanent failure and after unknown: still 400', async () => {
      const k1 = randomUUID();
      const k2 = randomUUID();
      sender.enqueue({ type: 'fail', error: httpError(403), dispatched: true }, { type: 'fail', error: netError('ECONNRESET'), dispatched: true });
      await send(k1);
      await send(k2);
      expect((await send(k1, { conversation_id: 'a:x' })).status).toBe(400);
      expect((await send(k2, { conversation_id: 'a:x' })).status).toBe(400);
    });

    it('after a released transient failure the key is free again, for any conversation', async () => {
      const key = randomUUID();
      sender.enqueue({ type: 'fail', error: httpError(503), dispatched: true });
      expect((await send(key)).status).toBe(503);
      expect((await send(key, { conversation_id: 'a:x' })).status).toBe(200);
      expect(sender.calls.map((c) => c.target.conversationId)).toEqual([CONVERSATION_ID, 'a:x']);
    });
  });

  describe('24 hour expiry', () => {
    it('a key is replayed until 24 h have passed, then it is free again', async () => {
      const key = randomUUID();
      await send(key);
      clock.t += IDEMPOTENCY_TTL_MS - 1;
      expect((await send(key)).body).toMatchObject({ replayed: true });
      expect(sender.calls).toHaveLength(1);

      clock.t += 1; // exactly 24 h after the claim
      const later = await send(key);
      expect(later.status).toBe(200);
      expect(later.body.replayed).toBeUndefined();
      expect(sender.calls).toHaveLength(2);
    });

    it('expiry applies to every stored outcome (unknown, permanent failure)', async () => {
      const k1 = randomUUID();
      const k2 = randomUUID();
      sender.enqueue({ type: 'fail', error: netError('ECONNRESET'), dispatched: true }, { type: 'fail', error: httpError(403), dispatched: true });
      await send(k1);
      await send(k2);
      expect(store.size).toBe(2);
      clock.t += 25 * HOUR;
      expect(store.size).toBe(0);
      expect((await send(k1)).status).toBe(200);
      expect((await send(k2)).status).toBe(200);
    });

    it('only old entries go; younger ones stay', async () => {
      const old = randomUUID();
      const young = randomUUID();
      await send(old);
      clock.t += 12 * HOUR;
      await send(young);
      clock.t += 13 * HOUR; // old is 25 h, young is 13 h
      expect(store.find(old)).toBeNull();
      expect(store.find(young)?.status).toBe('sent');
    });
  });

  describe('hard cap', () => {
    it('defaults to 50 000 entries and 24 h', () => {
      expect(IDEMPOTENCY_MAX_ENTRIES).toBe(50_000);
      expect(IDEMPOTENCY_TTL_MS).toBe(24 * HOUR);
    });

    it('evicts the oldest entry first, never throws, and never grows past the cap', async () => {
      build(3);
      const keys = Array.from({ length: 6 }, () => randomUUID());
      for (const k of keys) {
        const r = await send(k);
        expect(r.status).toBe(200);
        expect(store.size).toBeLessThanOrEqual(3);
      }
      expect(store.size).toBe(3);
      expect(keys.slice(0, 3).map((k) => store.find(k))).toEqual([null, null, null]);
      expect(keys.slice(3).map((k) => store.find(k)?.status)).toEqual(['sent', 'sent', 'sent']);
      // The newest are still replayed; an evicted one is simply new again.
      expect((await send(keys[5]!)).body).toMatchObject({ replayed: true });
      expect((await send(keys[0]!)).body.replayed).toBeUndefined();
    });

    it('a released key frees its slot, and the cap holds under heavy use', () => {
      const small = new InMemoryIdempotencyStore({ now: () => clock.t, maxEntries: 2 });
      expect(small.claim('a', 'c')).toEqual({ claimed: true });
      expect(small.release('a')).toBe(true);
      expect(small.size).toBe(0);
      for (let i = 0; i < 1000; i++) small.claim(`k${i}`, 'c');
      expect(small.size).toBe(2);
      expect(small.find('k999')?.status).toBe('in_progress');
      expect(small.find('k998')?.status).toBe('in_progress');
      expect(small.find('k997')).toBeNull();
    });

    it('eviction passes over a send that is still in flight while a finished entry can go instead', async () => {
      build(2);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      sender.enqueue({ type: 'gate', gate });
      const slowKey = randomUUID();
      const slow = send(slowKey); // oldest, in flight
      const doneKey = randomUUID();
      await send(doneKey); // finished
      await send(randomUUID()); // cap reached: the finished one goes, not the in-flight one
      expect(store.find(slowKey)?.status).toBe('in_progress');
      expect(store.find(doneKey)).toBeNull();
      expect((await send(slowKey)).status).toBe(409); // still claimed: no duplicate send
      release();
      expect((await slow).status).toBe(200);
      expect(store.find(slowKey)?.status).toBe('sent');
    });

    it('an evicted in-flight send (only possible when every entry is in flight) finishes normally (its state writes are no-ops, nothing throws)', async () => {
      build(1);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      sender.enqueue({ type: 'gate', gate });
      const slow = send(randomUUID());
      await send(randomUUID()); // claims a slot; with only an in-flight entry to evict, that one goes
      release();
      expect((await slow).status).toBe(200);
      expect(store.size).toBe(1);
    });
  });

  describe('store transitions', () => {
    it('only an in-progress entry can be marked or released', () => {
      expect(store.markSent('nope', 'x')).toBe(false);
      expect(store.release('nope')).toBe(false);
      store.claim('k', 'c');
      expect(store.markSent('k', 'act')).toBe(true);
      expect(store.markUnknown('k')).toBe(false);
      expect(store.markFailedPermanent('k', 'invalid_request')).toBe(false);
      expect(store.release('k')).toBe(false);
      expect(store.find('k')).toMatchObject({ status: 'sent', activityId: 'act' });
    });

    it('the loser of a claim gets the winner entry', () => {
      expect(store.claim('k', 'conv-1')).toEqual({ claimed: true });
      expect(store.claim('k', 'conv-2')).toMatchObject({ claimed: false, entry: { conversationId: 'conv-1', status: 'in_progress' } });
    });
  });

  it('logs delivery ids and status words only', async () => {
    sender.enqueue({ type: 'ok' }, { type: 'fail', error: httpError(403), dispatched: true }, { type: 'fail', error: netError('ECONNRESET'), dispatched: true });
    await send(randomUUID());
    await send(randomUUID());
    await send(randomUUID());
    await send('not-a-uuid');
    expect(logs.lines.length).toBeGreaterThan(0);
    expectCleanLogs(logs.lines);
  });
});
