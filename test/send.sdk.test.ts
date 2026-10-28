import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CARD_TEXT, CLIENT_ID, CONVERSATION_ID, FALLBACK_TEXT, sampleCard } from './helpers/constants.js';
import { createHarness, type Harness } from './helpers/harness.js';
import { assertCleanLogsAfterAll, captureLogs } from './helpers/logs.js';

const logs = captureLogs();
assertCleanLogsAfterAll(logs);
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ logs, sendDeadlineMs: 3000, teamsTimeoutMs: 400 });
});
afterAll(async () => {
  await h.stop();
});
beforeEach(() => {
  h.connector.requests.length = 0;
  h.connector.activityBehavior = { type: 'ok' };
});

const sendBody = (overrides: Record<string, unknown> = {}) => h.body(overrides);
const rowFor = (key: string) => {
  const e = h.idempotency.find(key);
  return e ? { status: e.status, outcome: e.outcome, activity_id: e.activityId } : undefined;
};

describe('/v1/send through the real SDK client against a fake Bot Connector', () => {
  it('posts one Adaptive Card message to the requested conversation on the requested service URL, with the bot token', async () => {
    h.connector.activityBehavior = { type: 'ok', id: 'connector-id-9' };
    const card = sampleCard();
    const r = await h.send(sendBody({ card }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'sent', activity_id: 'connector-id-9' });

    const posts = h.connector.activities();
    expect(posts).toHaveLength(1);
    const req = posts[0]!;
    expect(req.url).toBe(`/emea/v3/conversations/${CONVERSATION_ID}/activities`);
    expect(req.headers.authorization).toMatch(/^Bearer ey/);
    expect(req.body).toMatchObject({
      type: 'message',
      text: FALLBACK_TEXT,
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
      from: { id: CLIENT_ID },
      conversation: { id: CONVERSATION_ID },
    });
    expect(JSON.stringify(req.body)).toContain(CARD_TEXT);
    expect(rowFor(r.key)).toMatchObject({ status: 'sent', activity_id: 'connector-id-9' });
  });

  it('does not retry on its own: a failing connector sees exactly one request', async () => {
    h.connector.activityBehavior = { type: 'status', status: 500 };
    const r = await h.send();
    expect(r.status).toBe(409);
    expect(h.connector.activities()).toHaveLength(1);
  });

  it.each([
    [403, 403, { status: 'blocked_or_uninstalled' }, 'failed_permanent'],
    [404, 403, { status: 'blocked_or_uninstalled' }, 'failed_permanent'],
    [400, 400, { status: 'invalid_request', detail: 'Teams rejected the activity' }, 'failed_permanent'],
    [500, 409, { status: 'unknown' }, 'unknown'],
    [502, 409, { status: 'unknown' }, 'unknown'],
    [504, 409, { status: 'unknown' }, 'unknown'],
    [503, 503, { status: 'unavailable' }, undefined],
    [429, 429, { status: 'rate_limited' }, undefined],
  ])('connector answers %i -> %i %j (stored: %s)', async (teams, status, body, stored) => {
    h.connector.activityBehavior = { type: 'status', status: teams, headers: teams === 429 ? { 'retry-after': '3' } : undefined };
    const r = await h.send();
    expect(r.status).toBe(status);
    expect(r.body).toEqual(body);
    if (teams === 429) expect(r.headers.get('retry-after')).toBe('3');
    expect((rowFor(r.key))?.status).toBe(stored);
  });

  it('connection reset after the request was written -> 409 unknown', async () => {
    h.connector.activityBehavior = { type: 'reset' };
    const r = await h.send();
    expect(r.status).toBe(409);
    expect(rowFor(r.key)?.status).toBe('unknown');
  });

  it('connector never answers: the SDK client timeout fires after dispatch -> 409 unknown (proves the dispatch hook fires)', async () => {
    h.connector.activityBehavior = { type: 'hang' };
    const started = Date.now();
    const r = await h.send();
    expect(r.status).toBe(409);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(rowFor(r.key)?.status).toBe('unknown');
    expect(h.connector.activities()).toHaveLength(1);
  });

  it('connection refused (nothing written) -> 503 and the key is released', async () => {
    const r = await h.send(sendBody({ service_url: 'http://127.0.0.1:1/emea/' }));
    expect(r.status).toBe(503);
    expect(rowFor(r.key)).toBeUndefined();
  });

  it('a service URL that is not on the allowlist is never contacted: 400, the key is not claimed, the connector sees nothing', async () => {
    // Same machine, but not the one allowed loopback form: https with a host name that is not allow-listed.
    const lookalike = `${h.connector.url.replace('127.0.0.1', 'localhost')}/emea/`.replace('http://', 'https://');
    const r = await h.send(sendBody({ service_url: lookalike }));
    expect(r.status).toBe(400);
    expect(r.body.status).toBe('invalid_request');
    expect(h.connector.requests).toHaveLength(0);
    expect(rowFor(r.key)).toBeUndefined();
  });

  it('the bot token is never attached to a request for a rejected service URL (lookalike hosts)', async () => {
    for (const service_url of ['https://smba.trafficmanager.net.evil.com/emea/', 'https://smba.trafficmanager.net@evil.com/emea/', 'http://smba.trafficmanager.net/emea/']) {
      expect((await h.send(sendBody({ service_url }))).status).toBe(400);
    }
    expect(h.connector.requests).toHaveLength(0);
  });
});
