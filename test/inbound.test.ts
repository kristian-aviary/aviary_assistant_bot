import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/inbound.js';
import { CLIENT_ID, CONVERSATION_ID, TEAMS_USER_ID, USER_AAD_ID, USER_EMAIL, USER_TENANT_ID, VERIFY_TOKEN } from './helpers/constants.js';
import { LINK_URL, REMOVE_URL } from './helpers/fakeGertrude.js';
import { activity, createHarness, type Harness } from './helpers/harness.js';
import { assertCleanLogsAfterAll, captureLogs } from './helpers/logs.js';

const logs = captureLogs();
assertCleanLogsAfterAll(logs);
let h: Harness;
let logStart = 0;

beforeAll(async () => {
  h = await createHarness({ logs, gertrudeTimeoutMs: 300 });
});
afterAll(async () => {
  await h.stop();
});
beforeEach(() => {
  h.gertrude.requests.length = 0;
  h.gertrude.behavior = { type: 'ok' };
  h.connector.requests.length = 0;
  h.connector.activityBehavior = { type: 'ok' };
  h.connector.memberStatus = 200;
  h.connector.member = { id: TEAMS_USER_ID, name: 'Some One', aadObjectId: USER_AAD_ID, email: USER_EMAIL, tenantId: USER_TENANT_ID };
  logStart = logs.lines.length;
});

const replies = () => h.connector.activities().map((r) => (r.body as { text: string }).text);
const post = (over: Parameters<typeof activity>[0] extends infer T ? Partial<T> : never = {}) =>
  h.signedActivityPost(activity({ serviceUrl: h.serviceUrl, ...over }));
const rosterCalls = () => h.connector.requests.filter((r) => r.method === 'GET').length;
const links = () => h.gertrude.linkCalls();
const removes = () => h.gertrude.removeCalls();
const normalizedServiceUrl = () => h.serviceUrl.replace(/\/$/, '');
const recent = () => logs.records().slice(logStart);
const logged = (code: string) => recent().filter((l) => l.code === code);

describe('linking on a personal-scope message or install', () => {
  it('message: PUTs once to Gertrude with the exact contract body, then replies once', async () => {
    const res = await post();
    expect(res.status).toBe(200);

    expect(links()).toHaveLength(1);
    expect(removes()).toHaveLength(0);
    const call = links()[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(LINK_URL);
    expect(call.headers.authorization).toBe(`Bearer ${VERIFY_TOKEN}`);
    expect(call.body).toEqual({
      tenant_id: USER_TENANT_ID,
      aad_object_id: USER_AAD_ID,
      email: USER_EMAIL,
      conversation_id: CONVERSATION_ID,
      service_url: normalizedServiceUrl(),
      reference: {
        channelId: 'msteams',
        serviceUrl: normalizedServiceUrl(),
        conversation: { id: CONVERSATION_ID, conversationType: 'personal', tenantId: USER_TENANT_ID },
        bot: { id: `28:${CLIENT_ID}` },
        user: { id: TEAMS_USER_ID, aadObjectId: USER_AAD_ID },
      },
    });
    expect(Object.keys(call.body as object).sort()).toEqual(['aad_object_id', 'conversation_id', 'email', 'reference', 'service_url', 'tenant_id']);
    expect(JSON.stringify((call.body as { reference: unknown }).reference)).not.toContain(USER_EMAIL);
    expect(JSON.stringify(call.body)).not.toContain('user_id');
    expect(replies()).toEqual([MESSAGES.linked]);
  });

  it('the bot never asks about an Assistant user: no verify call, no user id anywhere in what it sends', async () => {
    await post();
    expect(h.gertrude.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`PUT ${LINK_URL}`]);
    expect(JSON.stringify(h.gertrude.requests.map((r) => r.body))).not.toMatch(/user_id|samlp/);
  });

  it('install.add behaves the same as a first message', async () => {
    await post({ type: 'installationUpdate', action: 'add' });
    expect(links()).toHaveLength(1);
    expect(replies()).toEqual([MESSAGES.linked]);
  });

  it('anything else a user types gets the same one-line answer; each is a (harmless) refresh', async () => {
    h.gertrude.behavior = { type: 'ok', status: 'refreshed' };
    await post({ text: 'what were last quarter numbers?' });
    await post({ text: 'help' });
    expect(replies()).toEqual([MESSAGES.linked, MESSAGES.linked]);
    expect(links()).toHaveLength(2);
  });

  it('created and refreshed are told apart in the log, both reply "reports will arrive here"', async () => {
    await post();
    h.gertrude.behavior = { type: 'ok', status: 'refreshed' };
    await post({ conversationId: 'a:2-new-conversation' });
    expect(replies()).toEqual([MESSAGES.linked, MESSAGES.linked]);
    expect(recent().filter((l) => l.event === 'reference_stored').map((l) => l.status)).toEqual(['created', 'refreshed']);
    expect((links()[1]!.body as { conversation_id: string }).conversation_id).toBe('a:2-new-conversation');
  });

  it('lower-cases and trims the roster email, and lower-cases the ids, before calling Gertrude', async () => {
    h.connector.member = { ...h.connector.member, email: '  Someone@Example.COM ', aadObjectId: USER_AAD_ID.toUpperCase(), tenantId: USER_TENANT_ID.toUpperCase() };
    await post({ aadObjectId: USER_AAD_ID.toUpperCase(), tenantId: USER_TENANT_ID.toUpperCase() });
    expect(links()).toHaveLength(1);
    expect(links()[0]!.body).toMatchObject({ email: 'someone@example.com', aad_object_id: USER_AAD_ID, tenant_id: USER_TENANT_ID });
    expect(replies()).toEqual([MESSAGES.linked]);
  });

  it('omits bot from the reference when the activity names no recipient (nothing invented)', async () => {
    const act = activity({ serviceUrl: h.serviceUrl }) as Record<string, any>;
    delete act.recipient;
    const token = await h.idp.signToken({ serviceurl: h.serviceUrl });
    await h.postActivity(act, token);
    expect((links()[0]!.body as { reference: Record<string, unknown> }).reference).not.toHaveProperty('bot');
  });
});

describe('Gertrude answers the link call', () => {
  it('404: polite refusal with no detail', async () => {
    h.gertrude.behavior = { type: 'status', status: 404, body: { error: 'NOT_FOUND' } };
    await post();
    expect(replies()).toEqual([MESSAGES.notSetUp]);
    expect(MESSAGES.notSetUp).not.toMatch(/tenant|email|user|not found|404/i);
    expect(links()).toHaveLength(1);
  });

  it('409 CONFLICT: the same reply as 404, and REFERENCE_CONFLICT is logged with no identifiers', async () => {
    h.gertrude.behavior = { type: 'status', status: 409, body: { error: 'CONFLICT' } };
    await post();
    expect(replies()).toEqual([MESSAGES.notSetUp]);
    const conflict = logged('REFERENCE_CONFLICT');
    expect(conflict).toHaveLength(1);
    expect(Object.keys(conflict[0]!).sort()).toEqual(['code', 'event', 'level', 'ts']);
    expect(conflict[0]!.level).toBe('error');
  });

  it('401: critical configuration log and the generic temporary-failure reply', async () => {
    h.gertrude.behavior = { type: 'status', status: 401, body: { error: 'UNAUTHORIZED' } };
    await post();
    expect(replies()).toEqual([MESSAGES.temporary]);
    expect(recent().some((l) => l.level === 'critical' && l.code === 'GERTRUDE_UNAUTHORIZED')).toBe(true);
  });

  it('400: error log (a bug on our side) and the generic temporary-failure reply', async () => {
    h.gertrude.behavior = { type: 'status', status: 400, body: { error: 'INVALID_REQUEST' } };
    await post();
    expect(replies()).toEqual([MESSAGES.temporary]);
    expect(recent().some((l) => l.level === 'error' && l.code === 'GERTRUDE_BAD_REQUEST')).toBe(true);
  });

  it.each([500, 502, 503, 504, 429])('%i: temporary-failure reply and no retry loop', async (status) => {
    h.gertrude.behavior = { type: 'status', status };
    await post();
    expect(replies()).toEqual([MESSAGES.temporary]);
    expect(links()).toHaveLength(1);
    expect(logged(`http_${status}`)).toHaveLength(1);
  });

  it('timeout: temporary-failure reply, asked once', async () => {
    h.gertrude.behavior = { type: 'timeout' };
    await post();
    expect(replies()).toEqual([MESSAGES.temporary]);
    expect(links()).toHaveLength(1);
    expect(logged('timeout')).toHaveLength(1);
  });

  it('connection reset: temporary-failure reply', async () => {
    h.gertrude.behavior = { type: 'reset' };
    await post();
    expect(replies()).toEqual([MESSAGES.temporary]);
    expect(links()).toHaveLength(1);
  });

  it.each([
    ['no status', {}],
    ['unknown status word', { status: 'maybe' }],
    ['status not a string', { status: 5 }],
  ])('200 with a malformed body (%s): temporary failure', async (_n, body) => {
    h.gertrude.behavior = { type: 'ok', body };
    await post();
    expect(replies()).toEqual([MESSAGES.temporary]);
    expect(logged('bad_body')).toHaveLength(1);
  });

  it('200 with extra fields is accepted (additive fields are allowed)', async () => {
    h.gertrude.behavior = { type: 'ok', body: { status: 'created', display: 'x' } };
    await post();
    expect(replies()).toEqual([MESSAGES.linked]);
  });
});

describe('only personal one-to-one conversations are linked', () => {
  it.each(['groupChat', 'channel'] as const)('%s message: says so, makes no PUT, asks nobody', async (conversationType) => {
    await post({ conversationType });
    expect(replies()).toEqual([MESSAGES.personalOnly]);
    expect(h.gertrude.requests).toHaveLength(0);
    expect(rosterCalls()).toBe(0);
  });

  it.each(['groupChat', 'channel'] as const)('install.add into a %s (team install): says so, makes no PUT', async (conversationType) => {
    await post({ type: 'installationUpdate', action: 'add', conversationType });
    expect(replies()).toEqual([MESSAGES.personalOnly]);
    expect(h.gertrude.requests).toHaveLength(0);
  });
});

describe('no PUT unless the roster agrees with the activity', () => {
  it('roster aadObjectId differing from the activity: no PUT, polite refusal', async () => {
    h.connector.member = { ...h.connector.member, aadObjectId: 'deadbeef-0000-4000-8000-000000000000' };
    await post();
    expect(h.gertrude.requests).toHaveLength(0);
    expect(replies()).toEqual([MESSAGES.notSetUp]);
    expect(logged('ROSTER_MISMATCH')).toHaveLength(1);
  });

  it('roster entry with no aadObjectId: no PUT', async () => {
    h.connector.member = { id: TEAMS_USER_ID, name: 'x', email: USER_EMAIL };
    await post();
    expect(h.gertrude.requests).toHaveLength(0);
    expect(replies()).toEqual([MESSAGES.notSetUp]);
  });

  it('no email on the roster: no PUT', async () => {
    h.connector.member = { id: TEAMS_USER_ID, name: 'x', aadObjectId: USER_AAD_ID, tenantId: USER_TENANT_ID, userPrincipalName: USER_EMAIL };
    await post();
    expect(h.gertrude.requests).toHaveLength(0);
    expect(replies()).toEqual([MESSAGES.notSetUp]);
    expect(logged('EMAIL_UNAVAILABLE')).toHaveLength(1);
  });

  it.each([['blank', '   '], ['not an address', 'someone']])('a %s roster email: no PUT', async (_n, email) => {
    h.connector.member = { ...h.connector.member, email };
    await post();
    expect(h.gertrude.requests).toHaveLength(0);
    expect(replies()).toEqual([MESSAGES.notSetUp]);
  });

  it('roster call failing: temporary-failure reply, no PUT', async () => {
    h.connector.memberStatus = 500;
    await post();
    expect(h.gertrude.requests).toHaveLength(0);
    expect(replies()).toEqual([MESSAGES.temporary]);
  });

  it('roster tenant differing from the activity tenant: no PUT', async () => {
    h.connector.member = { ...h.connector.member, tenantId: 'bbbbbbbb-0000-4000-8000-000000000000' };
    await post();
    expect(h.gertrude.requests).toHaveLength(0);
    expect(logged('ROSTER_TENANT_MISMATCH')).toHaveLength(1);
  });

  it('conversation tenant differing from channelData tenant: no PUT', async () => {
    await post({ tenantId: USER_TENANT_ID, channelDataTenantId: 'bbbbbbbb-0000-4000-8000-000000000000' });
    expect(h.gertrude.requests).toHaveLength(0);
  });

  it('an activity with no aadObjectId (for example a non-Entra user): no PUT, no roster call', async () => {
    await post({ aadObjectId: null });
    expect(h.gertrude.requests).toHaveLength(0);
    expect(rosterCalls()).toBe(0);
  });

  it('a channel other than msteams: no PUT', async () => {
    await post({ channelId: 'slack' });
    expect(h.gertrude.requests).toHaveLength(0);
  });
});

describe('install.remove (the user uninstalled the bot)', () => {
  it('POSTs to remove with only tenant_id and aad_object_id and sends nothing to Teams', async () => {
    const res = await post({ type: 'installationUpdate', action: 'remove' });
    expect(res.status).toBe(200);
    expect(removes()).toHaveLength(1);
    expect(links()).toHaveLength(0);
    const call = removes()[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(REMOVE_URL);
    expect(call.headers.authorization).toBe(`Bearer ${VERIFY_TOKEN}`);
    expect(call.body).toEqual({ tenant_id: USER_TENANT_ID, aad_object_id: USER_AAD_ID });
    expect(h.connector.requests).toHaveLength(0);
    expect(rosterCalls()).toBe(0);
  });

  it('lower-cases the ids', async () => {
    await post({ type: 'installationUpdate', action: 'remove', aadObjectId: USER_AAD_ID.toUpperCase(), tenantId: USER_TENANT_ID.toUpperCase() });
    expect(removes()[0]!.body).toEqual({ tenant_id: USER_TENANT_ID, aad_object_id: USER_AAD_ID });
  });

  it('logs only the result class (removed / none)', async () => {
    h.gertrude.behavior = { type: 'ok', removed: true };
    await post({ type: 'installationUpdate', action: 'remove' });
    h.gertrude.behavior = { type: 'ok', removed: false };
    await post({ type: 'installationUpdate', action: 'remove' });
    expect(recent().filter((l) => l.event === 'reference_removed').map((l) => l.status)).toEqual(['removed', 'none']);
  });

  it.each([
    ['401', { type: 'status', status: 401 } as const, 'critical', 'GERTRUDE_UNAUTHORIZED'],
    ['400', { type: 'status', status: 400 } as const, 'error', 'GERTRUDE_BAD_REQUEST'],
    ['500', { type: 'status', status: 500 } as const, 'warn', 'http_500'],
    ['429', { type: 'status', status: 429 } as const, 'warn', 'http_429'],
    ['timeout', { type: 'timeout' } as const, 'warn', 'timeout'],
    ['reset', { type: 'reset' } as const, 'warn', 'network'],
    ['bad body', { type: 'ok', body: { removed: 'maybe' } } as const, 'warn', 'bad_body'],
  ])('a failing remove (%s) never throws out of the handler, is not retried, and is logged by class', async (_n, behavior, level, code) => {
    h.gertrude.behavior = behavior;
    const res = await post({ type: 'installationUpdate', action: 'remove' });
    expect(res.status).toBe(200);
    expect(removes()).toHaveLength(1);
    expect(recent().some((l) => l.event === 'reference_remove_failed' && l.level === level && l.code === code)).toBe(true);
    expect(h.connector.requests).toHaveLength(0);
  });

  it('does not call Gertrude for a non-personal conversation, or without an aadObjectId', async () => {
    await post({ type: 'installationUpdate', action: 'remove', conversationType: 'channel' });
    await post({ type: 'installationUpdate', action: 'remove', conversationType: 'groupChat' });
    await post({ type: 'installationUpdate', action: 'remove', aadObjectId: null });
    expect(h.gertrude.requests).toHaveLength(0);
  });

  it('a send after uninstall is not special: the bot looks nothing up (Gertrude decides eligibility)', async () => {
    await post({ type: 'installationUpdate', action: 'remove' });
    const r = await h.send();
    expect(r.status).toBe(200);
  });
});

describe('other traffic', () => {
  it.each(['typing', 'conversationUpdate', 'messageReaction', 'event'])('%s activities are ignored', async (type) => {
    const res = await post({ type });
    expect(res.status).toBe(200);
    expect(h.gertrude.requests).toHaveLength(0);
    expect(h.connector.requests).toHaveLength(0);
  });

  it('a service URL outside the allowlist is never contacted or sent to Gertrude, even with a validly signed token', async () => {
    const evil = 'https://evil.example.com/emea/';
    const token = await h.idp.signToken({ serviceurl: evil });
    const res = await h.postActivity(activity({ serviceUrl: evil }), token);
    expect(res.status).toBe(200);
    expect(h.connector.requests).toHaveLength(0);
    expect(h.gertrude.requests).toHaveLength(0);
    expect(logged('SERVICE_URL_REJECTED')).toHaveLength(1);
  });

  it('a failing reply does not undo the link and does not crash the handler', async () => {
    h.connector.activityBehavior = { type: 'status', status: 500 };
    const res = await post();
    expect(res.status).toBe(200);
    expect(links()).toHaveLength(1);
    expect(logged('REPLY_FAILED')).toHaveLength(1);
  });
});
