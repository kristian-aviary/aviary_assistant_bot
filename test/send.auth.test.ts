import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({ calls: [] as { aLen: number; bLen: number; equal: boolean }[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      const equal = actual.timingSafeEqual(a, b);
      spies.calls.push({ aLen: a.byteLength, bLen: b.byteLength, equal });
      return equal;
    },
  };
});

import { bearerMatches } from '../src/sendService.js';
import { SEND_TOKEN } from './helpers/constants.js';
import { FakeTeamsSender } from './helpers/fakeSender.js';
import { createHarness, type Harness } from './helpers/harness.js';
import { assertCleanLogsAfterAll, captureLogs } from './helpers/logs.js';

const logs = captureLogs();
assertCleanLogsAfterAll(logs);
let h: Harness;
const sender = new FakeTeamsSender();

beforeAll(async () => {
  h = await createHarness({ sender, logs });
});
afterAll(async () => {
  await h.stop();
});
beforeEach(() => {
  sender.reset();
  spies.calls.length = 0;
});

describe('bearer check on /v1/send', () => {
  it('missing Authorization header: 401, nothing sent, no idempotency entry', async () => {
    const r = await h.send(h.body(), { token: null });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ status: 'unauthorized' });
    expect(sender.calls).toHaveLength(0);
    expect(h.idempotency.size).toBe(0);
  });

  it.each([
    ['wrong token', 'Bearer not-the-token'],
    ['token of the other direction', 'Bearer verify-token-BBBBBBBBBBBBBBBBBBBBBB'],
    ['prefix of the right token', `Bearer ${SEND_TOKEN.slice(0, -1)}`],
    ['right token plus a suffix', `Bearer ${SEND_TOKEN}x`],
    ['right token without the Bearer scheme', SEND_TOKEN],
    ['wrong scheme', `Basic ${SEND_TOKEN}`],
    ['lower-case scheme', `bearer ${SEND_TOKEN}`],
    ['empty bearer', 'Bearer '],
  ])('%s: 401', async (_name, header) => {
    const r = await h.send(h.body(), { token: null, headers: { authorization: header } });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ status: 'unauthorized' });
    expect(sender.calls).toHaveLength(0);
  });

  it('401 is answered before the body is parsed: garbage body with no token is 401, not 400', async () => {
    const r = await h.send('{not json', { token: null });
    expect(r.status).toBe(401);
  });

  it('right token: reaches the handler and sends', async () => {
    const r = await h.send();
    expect(r.status).toBe(200);
    expect(sender.calls).toHaveLength(1);
  });

  it('the 401 body never contains the expected token', async () => {
    const r = await h.send(h.body(), { token: 'wrong' });
    expect(JSON.stringify(r.body)).not.toContain(SEND_TOKEN);
  });
});

describe('constant-time comparison', () => {
  it('compares through crypto.timingSafeEqual on equal-length digests for right, wrong, empty and different-length input', async () => {
    const inputs = [`Bearer ${SEND_TOKEN}`, 'Bearer nope', 'Bearer ', undefined, `Bearer ${'x'.repeat(5000)}`];
    const expected = [true, false, false, false, false];
    inputs.forEach((input, i) => {
      spies.calls.length = 0;
      expect(bearerMatches(input, SEND_TOKEN)).toBe(expected[i]);
      expect(spies.calls).toHaveLength(1);
      expect(spies.calls[0]!.aLen).toBe(32);
      expect(spies.calls[0]!.bLen).toBe(32);
      expect(spies.calls[0]!.equal).toBe(expected[i]);
    });
  });

  it('does not throw on length mismatch (the raw-buffer pitfall of timingSafeEqual)', () => {
    expect(() => bearerMatches('Bearer a', 'a-much-longer-expected-token-value')).not.toThrow();
  });

  it('the HTTP guard also goes through timingSafeEqual', async () => {
    spies.calls.length = 0;
    await h.send(h.body(), { token: 'wrong' });
    expect(spies.calls.length).toBeGreaterThanOrEqual(1);
  });
});
