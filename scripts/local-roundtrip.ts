/**
 * Local proof of the install -> send round trip. No database is needed: the bot service is stateless.
 *
 *   npm run local:roundtrip
 *
 * Real: the bot service (Express, the SDK's /api/messages with its own JWT validation switched on, the
 * inbound install/link path, /v1/send with the service URL allowlist and idempotency). Fake and local:
 * Gertrude (scripts/fake-gertrude.ts, which stores the conversation reference the bot sends it), the
 * Microsoft identity provider (a JWKS server that signs test tokens), the Teams roster and reply calls,
 * and the Teams sender. Real Teams is NOT involved.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PUBLIC } from '@microsoft/teams.api';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { MESSAGES } from '../src/inbound.js';
import { createLogger } from '../src/logger.js';
import { startService } from '../src/server.js';
import type { TeamsMessage, TeamsSender, TeamsTarget } from '../src/teamsSender.js';
import { FAKE_VERIFY_TOKEN, startFakeGertrudeServer } from './fake-gertrude.js';

const SEND_TOKEN = 'local-fake-send-token-not-a-secret';
const CLIENT_ID = '11111111-2222-4333-8444-555555555555';
const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const AAD = 'f0f0f0f0-1111-4222-8333-444444444444';
const STRANGER_AAD = '0a0a0a0a-1111-4222-8333-555555555555';
const SERVICE_URL = 'https://smba.trafficmanager.net/emea/';
const NORMALIZED_SERVICE_URL = 'https://smba.trafficmanager.net/emea';
const CONVERSATION = 'a:local-conversation';
const USER_ID = 'samlp|aviary|alex.example@example.com';
const CARD = { type: 'AdaptiveCard', version: '1.5', body: [{ type: 'TextBlock', text: 'Local demo report' }] };
const FALLBACK_TEXT = 'Local demo report (plain text)';

const say = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};

/** Polls until `ok` holds or the timeout passes. The SDK may answer before a handler has finished. */
async function eventually<T>(read: () => T, ok: (value: T) => boolean, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (!ok(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    value = read();
  }
  return value;
}

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'local-key', alg: 'RS256', use: 'sig' };
const idp = createServer((req, res) => {
  res.writeHead(req.url === '/v1/.well-known/keys' ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
const idpUrl = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
const signToken = () =>
  new SignJWT({ serviceurl: SERVICE_URL })
    .setProtectedHeader({ alg: 'RS256', kid: 'local-key' })
    .setIssuer('https://api.botframework.com')
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);

const gertrudeRequests: { route: string; status: number }[] = [];
const gertrude = await startFakeGertrudeServer({
  allowedTenantIds: [TENANT],
  onRequest: (info) => gertrudeRequests.push(info),
});

const teamsCalls: { target: TeamsTarget; message: TeamsMessage }[] = [];
const fakeSender: TeamsSender = {
  async send(target, message, hooks) {
    hooks.onDispatched();
    teamsCalls.push({ target, message });
    return { activityId: `fake-activity-${teamsCalls.length}` };
  },
};

/** The roster the fake Teams returns for the sender of the next inbound activity. */
const roster = { aadObjectId: AAD, email: 'Alex.Example@example.com', tenantId: TENANT };
const replies: string[] = [];

const logger = createLogger();
const botToken = await signToken();
const service = await startService(
  {
    gertrudeUrl: gertrude.url,
    gertrudeVerifyToken: FAKE_VERIFY_TOKEN,
    sendServiceToken: SEND_TOKEN,
    clientId: CLIENT_ID,
    clientSecret: 'unused-in-local-run',
    tenantId: '99999999-8888-4777-8666-555555555555',
    port: 0,
    extraServiceUrlHosts: [],
  },
  logger,
  {
    sender: fakeSender,
    ports: {
      async getRosterMember() {
        return { aadObjectId: roster.aadObjectId, email: roster.email, tenantId: roster.tenantId };
      },
      async reply(_u, _c, text) {
        replies.push(text);
      },
    },
    testOverrides: { cloud: { ...PUBLIC, openIdMetadataUrl: `${idpUrl}/v1/.well-known/openidconfiguration`, tokenIssuer: 'https://api.botframework.com' }, token: () => botToken },
    listenPort: 0,
  },
);
const base = `http://127.0.0.1:${service.port}`;

const activity = (extra: Record<string, unknown> = {}, aadObjectId = AAD) => ({
  type: 'message',
  id: randomUUID(),
  channelId: 'msteams',
  serviceUrl: SERVICE_URL,
  from: { id: '29:local-teams-user', aadObjectId },
  recipient: { id: `28:${CLIENT_ID}` },
  conversation: { id: CONVERSATION, conversationType: 'personal', isGroup: false, tenantId: TENANT },
  channelData: { tenant: { id: TENANT } },
  text: 'hello',
  ...extra,
});
const postActivity = async (body: unknown, token?: string) =>
  fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const send = async (key: string, conversationId: string, serviceUrl: string) =>
  fetch(`${base}/v1/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SEND_TOKEN}`, 'idempotency-key': key },
    body: JSON.stringify({ conversation_id: conversationId, service_url: serviceUrl, card: CARD, fallback_text: FALLBACK_TEXT }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

try {
  say(`bot on ${base}, fake Gertrude on ${gertrude.url}`);

  const health = await fetch(`${base}/healthz`);
  check('GET /healthz is 200 {"ok":true}', health.status === 200 && (await health.text()) === '{"ok":true}');

  const evil = await send(randomUUID(), CONVERSATION, 'https://evil.example.com/emea/');
  check('send to a non-allowlisted service_url: 400 invalid_request, Teams not called', evil.status === 400 && evil.body.status === 'invalid_request' && teamsCalls.length === 0, evil);

  const unsigned = await postActivity(activity());
  check('inbound activity without a token is rejected by the SDK: 401', unsigned.status === 401);
  check('an unsigned request stores nothing in Gertrude', gertrude.links().length === 0);

  const linked = await postActivity(activity(), await signToken());
  check('inbound personal message with a validly signed token: 200', linked.status === 200);
  await eventually(() => replies.length, (n) => n >= 1);
  check('the user was told they are linked', replies.at(-1) === 'You will receive Aviary Assistant reports here.', replies);

  const links = await eventually(() => gertrude.links(), (l) => l.length > 0);
  const [link] = links;
  check(
    'Gertrude stores exactly one reference, for the user_id it knows, with the normalized service URL',
    links.length === 1 &&
      link?.userId === USER_ID &&
      link.conversationId === CONVERSATION &&
      link.serviceUrl === NORMALIZED_SERVICE_URL &&
      link.tenantId === TENANT &&
      link.aadObjectId === AAD,
    links,
  );
  if (!link) throw new Error('no reference was stored; cannot continue the round trip');

  // From here on the bot is given only what Gertrude stored: the conversation and service URL from the link.
  const key1 = randomUUID();
  const first = await send(key1, link.conversationId, link.serviceUrl);
  check('send with the stored conversation and service URL: 200 sent', first.status === 200 && first.body.status === 'sent' && first.body.activity_id === 'fake-activity-1', first);
  const sent = teamsCalls[0];
  check(
    'the fake Teams sender received the card and fallback text once',
    teamsCalls.length === 1 &&
      sent?.message.text === FALLBACK_TEXT &&
      JSON.stringify(sent.message.card) === JSON.stringify(CARD) &&
      sent.target.conversationId === CONVERSATION &&
      sent.target.serviceUrl === NORMALIZED_SERVICE_URL,
    teamsCalls.length,
  );

  const replay = await send(key1, link.conversationId, link.serviceUrl);
  check('same Idempotency-Key again: 200 replayed, Teams not called again', replay.status === 200 && replay.body.replayed === true && teamsCalls.length === 1, replay);

  const key2 = randomUUID();
  const second = await send(key2, link.conversationId, link.serviceUrl);
  check('a new Idempotency-Key sends again', second.status === 200 && second.body.status === 'sent' && teamsCalls.length === 2, second);

  const clash = await send(key2, 'a:other-conversation', link.serviceUrl);
  check('same key with a different conversation_id: 400, Teams not called', clash.status === 400 && clash.body.status === 'invalid_request' && teamsCalls.length === 2, clash);

  // An email Gertrude does not know: the bot says so and Gertrude stores nothing new.
  roster.email = 'stranger.example@example.com';
  roster.aadObjectId = STRANGER_AAD;
  const stranger = await postActivity(activity({}, STRANGER_AAD), await signToken());
  check('inbound from an unknown email: 200', stranger.status === 200);
  await eventually(() => replies.length, (n) => n >= 2);
  check('unknown email: the user gets the not-set-up reply', replies.at(-1) === MESSAGES.notSetUp, replies.at(-1));
  check('unknown email: no reference is stored for it', gertrude.links().length === 1 && gertrude.links()[0]?.userId === USER_ID);

  const removed = await postActivity(activity({ type: 'installationUpdate', action: 'remove' }), await signToken());
  check('installationUpdate remove: 200', removed.status === 200);
  const afterRemove = await eventually(() => gertrude.links(), (l) => l.length === 0);
  check(
    'after remove the bot called the remove route and Gertrude dropped the reference',
    afterRemove.length === 0 && gertrudeRequests.some((r) => r.route === 'remove' && r.status === 200),
    gertrudeRequests,
  );
} finally {
  await service.stop();
  await new Promise<void>((r) => idp.close(() => r()));
  await gertrude.close();
}

say(failures === 0 ? 'ROUND TRIP OK (fake Gertrude, fake Teams sender; real Teams not run)' : `ROUND TRIP FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
