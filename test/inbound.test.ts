import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/inbound.js';
import { CONVERSATION_ID, TEAMS_USER_ID, USER_AAD_ID, USER_EMAIL, USER_ID, USER_TENANT_ID, VERIFY_TOKEN } from './helpers/constants.js';
import { activity, createHarness, type Harness } from './helpers/harness.js';
import { assertCleanLogsAfterAll, captureLogs } from './helpers/logs.js';
import { seedReference } from './helpers/seed.js';

const logs = captureLogs();
assertCleanLogsAfterAll(logs);
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ logs, gertrudeTimeoutMs: 300 });
});
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  h.gertrude.requests.length = 0;
  h.gertrude.behavior = { type: 'ok' };
  h.connector.requests.length = 0;
  h.connector.activityBehavior = { type: 'ok' };
  h.connector.memberStatus = 200;
  h.connector.member = { id: TEAMS_USER_ID, name: 'Some One', aadObjectId: USER_AAD_ID, email: USER_EMAIL, tenantId: USER_TENANT_ID };
  await h.db.pool.query('truncate conversation_reference, send_idempotency');
});

const rows = async () => (await h.db.pool.query('select * from conversation_reference order by user_id')).rows;
const replies = () => h.connector.activities().map((r) => (r.body as { text: string }).text);
const post = (over: Parameters<typeof activity>[0] extends infer T ? Partial<T> : never = {}) =>
  h.signedActivityPost(activity({ serviceUrl: h.serviceUrl, ...over }));
const rosterCalls = () => h.connector.requests.filter((r) => r.method === 'GET').length;

describe('linking on a personal-scope message or install', () => {
  it('message: asks Gertrude with the roster email, stores the reference for the returned user_id, replies once', async () => {
    const res = await post();
    expect(res.status).toBe(200);

    expect(h.gertrude.verifyCalls()).toBe(1);
    const call = h.gertrude.requests[0]!;
    expect(call.headers.authorization).toBe(`Bearer ${VERIFY_TOKEN}`);
    expect(call.body).toEqual({ tenant_id: USER_TENANT_ID, aad_object_id: USER_AAD_ID, email: USER_EMAIL });

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      user_id: USER_ID,
      tenant_id: USER_TENANT_ID,
      aad_object_id: USER_AAD_ID,
      conversation_id: CONVERSATION_ID,
      service_url: h.serviceUrl.replace(/\/$/, ''),
    });
    expect(JSON.stringify(stored[0].reference)).not.toContain(USER_EMAIL);
    expect(replies()).toEqual([MESSAGES.linked]);
  });

  it('install.add behaves the same as a first message', async () => {
    await post({ type: 'installationUpdate', action: 'add' });
    expect(await rows()).toHaveLength(1);
    expect(replies()).toEqual([MESSAGES.linked]);
  });

  it('anything else a user types gets the same one-line answer; no chat features', async () => {
    await post({ text: 'what were last quarter numbers?' });
    await post({ text: 'help' });
    expect(replies()).toEqual([MESSAGES.linked, MESSAGES.linked]);
    expect(await rows()).toHaveLength(1);
  });

  it('reinstalling refreshes the row (new conversation id) instead of adding another', async () => {
    await post({ type: 'installationUpdate', action: 'add' });
    await h.db.pool.query(`update conversation_reference set updated_at = now() - interval '1 hour'`);
    const before = (await rows())[0];
    await post({ type: 'installationUpdate', action: 'add', conversationId: 'a:2-new-conversation' });
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ conversation_id: 'a:2-new-conversation', user_id: USER_ID });
    expect(after[0].created_at).toEqual(before.created_at);
    expect(after[0].updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it('lower-cases and trims the roster email before asking Gertrude', async () => {
    h.connector.member = { ...h.connector.member, email: '  Someone@Example.COM ' };
    await post();
    expect((h.gertrude.requests[0]!.body as { email: string }).email).toBe('someone@example.com');
  });
});

describe('Gertrude answers', () => {
  it('404: polite refusal with no detail, nothing stored', async () => {
    h.gertrude.behavior = { type: 'status', status: 404, body: { error: 'NOT_FOUND' } };
    await post();
    expect(replies()).toEqual([MESSAGES.notSetUp]);
    expect(MESSAGES.notSetUp).not.toMatch(/tenant|email|user|not found|404/i);
    expect(await rows()).toHaveLength(0);
  });

  it('401: critical configuration log, generic temporary-failure reply, nothing stored', async () => {
    h.gertrude.behavior = { type: 'status', status: 401, body: { error: 'UNAUTHORIZED' } };
    await post();
    expect(replies()).toEqual([MESSAGES.temporary]);
    expect(await rows()).toHaveLength(0);
    expect(logs.records().some((l) => l.level === 'critical' && l.code === 'GERTRUDE_UNAUTHORIZED')).toBe(true);
  });

  it.each([500, 502, 503, 429])('%i: temporary-failure reply, nothing stored, no retry loop', async (status) => {
    h.gertrude.behavior = { type: 'status', status };
    await post();
    expect(replies()).toEqual([MESSAGES.temporary]);
    expect(await rows()).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(1);
  });

  it('timeout: temporary-failure reply, nothing stored, asked once', async () => {
    h.gertrude.behavior = { type: 'timeout' };
    await post();
    expect(replies()).toEqual([MESSAGES.temporary]);
    expect(await rows()).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(1);
  });

  it('connection reset: temporary-failure reply, nothing stored', async () => {
    h.gertrude.behavior = { type: 'reset' };
    await post();
    expect(replies()).toEqual([MESSAGES.temporary]);
    expect(await rows()).toHaveLength(0);
  });

  it.each([
    ['missing user_id', { other: 1 }],
    ['empty user_id', { user_id: '' }],
    ['user_id not a string', { user_id: 5 }],
  ])('200 with a malformed body (%s): treated as a temporary failure, nothing stored', async (_n, body) => {
    h.gertrude.behavior = { type: 'ok', body };
    await post();
    expect(replies()).toEqual([MESSAGES.temporary]);
    expect(await rows()).toHaveLength(0);
  });

  it('200 with extra fields is accepted (additive fields are allowed)', async () => {
    h.gertrude.behavior = { type: 'ok', body: { user_id: USER_ID, display: 'x' } };
    await post();
    expect(replies()).toEqual([MESSAGES.linked]);
  });
});

describe('only personal one-to-one conversations are linked', () => {
  it.each(['groupChat', 'channel'] as const)('%s message: says so, stores nothing, asks nobody', async (conversationType) => {
    await post({ conversationType });
    expect(replies()).toEqual([MESSAGES.personalOnly]);
    expect(await rows()).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(0);
    expect(rosterCalls()).toBe(0);
  });

  it.each(['groupChat', 'channel'] as const)('install.add into a %s (team install): says so, stores nothing', async (conversationType) => {
    await post({ type: 'installationUpdate', action: 'add', conversationType });
    expect(replies()).toEqual([MESSAGES.personalOnly]);
    expect(await rows()).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(0);
  });
});

describe('the roster must agree with the activity', () => {
  it('aadObjectId mismatch: stores nothing, does not ask Gertrude, polite refusal', async () => {
    h.connector.member = { ...h.connector.member, aadObjectId: 'deadbeef-0000-4000-8000-000000000000' };
    await post();
    expect(await rows()).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(0);
    expect(replies()).toEqual([MESSAGES.notSetUp]);
    expect(logs.records().some((l) => l.code === 'ROSTER_MISMATCH')).toBe(true);
  });

  it('roster entry with no aadObjectId: refused', async () => {
    h.connector.member = { id: TEAMS_USER_ID, name: 'x', email: USER_EMAIL };
    await post();
    expect(await rows()).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(0);
  });

  it('no email on the roster: asks nothing of Gertrude, stores nothing', async () => {
    h.connector.member = { id: TEAMS_USER_ID, name: 'x', aadObjectId: USER_AAD_ID, tenantId: USER_TENANT_ID, userPrincipalName: USER_EMAIL };
    await post();
    expect(await rows()).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(0);
    expect(replies()).toEqual([MESSAGES.notSetUp]);
    expect(logs.records().some((l) => l.code === 'EMAIL_UNAVAILABLE')).toBe(true);
  });

  it('roster call failing: temporary-failure reply, nothing asked or stored', async () => {
    h.connector.memberStatus = 500;
    await post();
    expect(await rows()).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(0);
    expect(replies()).toEqual([MESSAGES.temporary]);
  });

  it('roster tenant differing from the activity tenant: refused', async () => {
    h.connector.member = { ...h.connector.member, tenantId: 'bbbbbbbb-0000-4000-8000-000000000000' };
    await post();
    expect(await rows()).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(0);
  });

  it('conversation tenant differing from channelData tenant: refused', async () => {
    await post({ tenantId: USER_TENANT_ID, channelDataTenantId: 'bbbbbbbb-0000-4000-8000-000000000000' });
    expect(await rows()).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(0);
  });

  it('an activity with no aadObjectId (for example a non-Entra user): refused', async () => {
    await post({ aadObjectId: null });
    expect(await rows()).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(0);
    expect(rosterCalls()).toBe(0);
  });

  it('a channel other than msteams: refused', async () => {
    await post({ channelId: 'slack' });
    expect(await rows()).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(0);
  });
});

describe('REFERENCE_CONFLICT', () => {
  it('an existing reference for that user_id with a different aad_object_id is kept; nothing is overwritten', async () => {
    await seedReference(h.db.pool, h.serviceUrl, { aadObjectId: 'aaaaaaaa-0000-4000-8000-000000000001', conversationId: 'conv-original' });
    await post();
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ conversation_id: 'conv-original', aad_object_id: 'aaaaaaaa-0000-4000-8000-000000000001' });
    expect(replies()).toEqual([MESSAGES.notSetUp]);
    const conflict = logs.records().filter((l) => l.code === 'REFERENCE_CONFLICT');
    expect(conflict.length).toBeGreaterThan(0);
    expect(Object.keys(conflict[0]!).sort()).toEqual(['code', 'event', 'level', 'reason', 'ts']);
  });

  it('the same Teams identity already linked to another user_id keeps both rows (the user changed email)', async () => {
    await seedReference(h.db.pool, h.serviceUrl, { userId: 'samlp|aviary|old@example.com', conversationId: 'conv-old' });
    await post();
    const stored = await rows();
    expect(stored.map((r) => r.user_id)).toEqual(['samlp|aviary|old@example.com']);
    expect(replies()).toEqual([MESSAGES.notSetUp]);
  });
});

describe('install.remove', () => {
  it('deletes the reference for that Teams identity and sends nothing', async () => {
    await post();
    h.connector.requests.length = 0;
    const res = await post({ type: 'installationUpdate', action: 'remove' });
    expect(res.status).toBe(200);
    expect(await rows()).toHaveLength(0);
    expect(h.connector.requests).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(1);
  });

  it('removing something never installed is harmless', async () => {
    const res = await post({ type: 'installationUpdate', action: 'remove' });
    expect(res.status).toBe(200);
  });

  it('does not delete another user, nor on a non-personal conversation, nor from another tenant', async () => {
    await post();
    await post({ type: 'installationUpdate', action: 'remove', aadObjectId: 'bbbbbbbb-0000-4000-8000-000000000002' });
    await post({ type: 'installationUpdate', action: 'remove', conversationType: 'channel' });
    await post({ type: 'installationUpdate', action: 'remove', tenantId: 'cccccccc-0000-4000-8000-000000000003' });
    expect(await rows()).toHaveLength(1);
  });

  it('a send after uninstall answers 404 no_reference (the reference is gone)', async () => {
    await post();
    await post({ type: 'installationUpdate', action: 'remove' });
    const r = await h.send();
    expect(r.status).toBe(404);
  });
});

describe('other traffic', () => {
  it.each(['typing', 'conversationUpdate', 'messageReaction', 'event'])('%s activities are ignored', async (type) => {
    const res = await post({ type });
    expect(res.status).toBe(200);
    expect(h.gertrude.verifyCalls()).toBe(0);
    expect(h.connector.requests).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it('a service URL outside the allowlist is never contacted or stored, even with a validly signed token', async () => {
    const evil = 'https://evil.example.com/emea/';
    const token = await h.idp.signToken({ serviceurl: evil });
    const res = await h.postActivity(activity({ serviceUrl: evil }), token);
    expect(res.status).toBe(200);
    expect(h.connector.requests).toHaveLength(0);
    expect(h.gertrude.verifyCalls()).toBe(0);
    expect(await rows()).toHaveLength(0);
    expect(logs.records().some((l) => l.code === 'SERVICE_URL_REJECTED')).toBe(true);
  });

  it('a failing reply does not undo the link and does not crash the handler', async () => {
    h.connector.activityBehavior = { type: 'status', status: 500 };
    const res = await post();
    expect(res.status).toBe(200);
    expect(await rows()).toHaveLength(1);
    expect(logs.records().some((l) => l.code === 'REPLY_FAILED')).toBe(true);
  });
});
