import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CARD_TEXT, CLIENT_ID, CONVERSATION_ID, FALLBACK_TEXT, sampleCard, sendBody } from './helpers/constants.js';
import { createHarness, type Harness } from './helpers/harness.js';
import { assertCleanLogsAfterAll, captureLogs } from './helpers/logs.js';
import { seedReference } from './helpers/seed.js';

const logs = captureLogs();
assertCleanLogsAfterAll(logs);
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ logs, sendDeadlineMs: 3000, teamsTimeoutMs: 400 });
});
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  h.connector.requests.length = 0;
  h.connector.activityBehavior = { type: 'ok' };
  await h.db.pool.query('truncate send_idempotency, conversation_reference');
  await seedReference(h.db.pool, h.serviceUrl);
});

const rowFor = async (key: string) => (await h.db.pool.query('select status, outcome, activity_id from send_idempotency where key = $1', [key])).rows[0];

describe('/v1/send through the real SDK client against a fake Bot Connector', () => {
  it('posts one Adaptive Card message to the stored conversation on the stored service URL, with the bot token', async () => {
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
    expect(await rowFor(r.key)).toMatchObject({ status: 'sent', activity_id: 'connector-id-9' });
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
    expect((await rowFor(r.key))?.status).toBe(stored);
  });

  it('connection reset after the request was written -> 409 unknown', async () => {
    h.connector.activityBehavior = { type: 'reset' };
    const r = await h.send();
    expect(r.status).toBe(409);
    expect((await rowFor(r.key)).status).toBe('unknown');
  });

  it('connector never answers: the SDK client timeout fires after dispatch -> 409 unknown (proves the dispatch hook fires)', async () => {
    h.connector.activityBehavior = { type: 'hang' };
    const started = Date.now();
    const r = await h.send();
    expect(r.status).toBe(409);
    expect(Date.now() - started).toBeLessThan(2500);
    expect((await rowFor(r.key)).status).toBe('unknown');
    expect(h.connector.activities()).toHaveLength(1);
  });

  it('connection refused (nothing written) -> 503 and the key is released', async () => {
    await h.db.pool.query('truncate conversation_reference');
    await seedReference(h.db.pool, 'http://127.0.0.1:1/emea/');
    const r = await h.send();
    expect(r.status).toBe(503);
    expect(await rowFor(r.key)).toBeUndefined();
  });

  it('a stored service URL that no longer passes the allowlist is never contacted: 503, released', async () => {
    await h.db.pool.query('truncate conversation_reference');
    await seedReference(h.db.pool, `${h.connector.url.replace('127.0.0.1', 'localhost')}/emea/`.replace('http://', 'https://'));
    const r = await h.send();
    expect(r.status).toBe(503);
    expect(h.connector.requests).toHaveLength(0);
    expect(await rowFor(r.key)).toBeUndefined();
    expect(logs.records().some((l) => l.code === 'service_url_rejected')).toBe(true);
  });
});
