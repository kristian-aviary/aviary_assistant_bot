/**
 * Local proof of the link -> send round trip. Needs a local Postgres only.
 *
 *   LOCAL_PG_ADMIN_URL=postgres://user:pass@127.0.0.1:5432/postgres npm run local:roundtrip
 *
 * Real: the bot service (Express, SDK /api/messages with its own JWT validation switched on,
 * Postgres, migrations, /v1/send, idempotency). Fake and local: Gertrude (scripts/fake-gertrude.ts),
 * the Microsoft identity provider (a JWKS server that signs test tokens), the Teams roster and
 * reply calls, and the Teams sender. Real Teams is NOT involved.
 */
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { PUBLIC } from '@microsoft/teams.api';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPool } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { startService } from '../src/server.js';
import type { TeamsMessage, TeamsSender, TeamsTarget } from '../src/teamsSender.js';
import { FAKE_VERIFY_TOKEN, startFakeGertrudeServer } from './fake-gertrude.js';

const ADMIN_URL = process.env.LOCAL_PG_ADMIN_URL ?? 'postgres://bot_test:bot_test@127.0.0.1:5432/postgres';
const SEND_TOKEN = 'local-fake-send-token-not-a-secret';
const CLIENT_ID = '11111111-2222-4333-8444-555555555555';
const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const AAD = 'f0f0f0f0-1111-4222-8333-444444444444';
const SERVICE_URL = 'https://smba.trafficmanager.net/emea/';

const say = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};

const dbName = `aviary_bot_local_${randomUUID().slice(0, 8)}`;
const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
await admin.query(`create database ${dbName}`);
const dbUrl = (() => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
})();

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'local-key', alg: 'RS256', use: 'sig' };
const idp = createServer((req, res) => {
  res.writeHead(req.url === '/v1/.well-known/keys' ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
const idpUrl = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
const signToken = (claims: { serviceurl: string; aud?: string }) =>
  new SignJWT({ serviceurl: claims.serviceurl })
    .setProtectedHeader({ alg: 'RS256', kid: 'local-key' })
    .setIssuer('https://api.botframework.com')
    .setAudience(claims.aud ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);

const gertrude = await startFakeGertrudeServer({ allowedTenantIds: [TENANT] });

const teamsCalls: { target: TeamsTarget; message: TeamsMessage }[] = [];
const fakeSender: TeamsSender = {
  async send(target, message, hooks) {
    hooks.onDispatched();
    teamsCalls.push({ target, message });
    return { activityId: `fake-activity-${teamsCalls.length}` };
  },
};
const replies: string[] = [];

const logger = createLogger();
const botToken = await signToken({ serviceurl: SERVICE_URL });
const pool = createPool(dbUrl);
const service = await startService(
  {
    databaseUrl: dbUrl,
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
    pool,
    sender: fakeSender,
    ports: {
      async getRosterMember() {
        return { aadObjectId: AAD, email: 'Alex.Example@example.com', tenantId: TENANT };
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

const activity = (extra: Record<string, unknown> = {}) => ({
  type: 'message',
  id: randomUUID(),
  channelId: 'msteams',
  serviceUrl: SERVICE_URL,
  from: { id: '29:local-teams-user', aadObjectId: AAD },
  recipient: { id: `28:${CLIENT_ID}` },
  conversation: { id: 'a:local-conversation', conversationType: 'personal', isGroup: false, tenantId: TENANT },
  channelData: { tenant: { id: TENANT } },
  text: 'hello',
  ...extra,
});
const postActivity = async (body: unknown, token?: string) =>
  fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const send = async (key: string, userId = 'samlp|aviary|alex.example@example.com') =>
  fetch(`${base}/v1/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SEND_TOKEN}`, 'idempotency-key': key },
    body: JSON.stringify({
      user_id: userId,
      card: { type: 'AdaptiveCard', version: '1.5', body: [{ type: 'TextBlock', text: 'Local demo report' }] },
      fallback_text: 'Local demo report (plain text)',
    }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

try {
  say(`bot on ${base}, fake Gertrude on ${gertrude.url}, database ${dbName}`);
  const health = await fetch(`${base}/healthz`);
  check('GET /healthz is 200 {"ok":true}', health.status === 200 && (await health.text()) === '{"ok":true}');

  const key1 = randomUUID();
  const before = await send(key1);
  check('send before the user linked: 404 no_reference, nothing sent', before.status === 404 && teamsCalls.length === 0, before);

  const unsigned = await postActivity(activity());
  check('inbound activity without a token is rejected by the SDK: 401', unsigned.status === 401);

  const linked = await postActivity(activity(), await signToken({ serviceurl: SERVICE_URL }));
  check('inbound personal message with a validly signed token: 200', linked.status === 200);
  check('the user was told they are linked', replies.at(-1) === 'You will receive Aviary Assistant reports here.', replies);
  const stored = await pool.query('select user_id, tenant_id, service_url from conversation_reference');
  check('reference stored for the user_id Gertrude returned', stored.rowCount === 1 && stored.rows[0].user_id === 'samlp|aviary|alex.example@example.com', stored.rows);

  const first = await send(key1);
  check('send after linking: 200 sent', first.status === 200 && first.body.status === 'sent' && first.body.activity_id === 'fake-activity-1', first);
  check('the fake Teams sender received the card and fallback text once', teamsCalls.length === 1 && teamsCalls[0]!.message.text === 'Local demo report (plain text)');

  const replay = await send(key1);
  check('same Idempotency-Key again: 200 replayed, Teams not called again', replay.status === 200 && replay.body.replayed === true && teamsCalls.length === 1, replay);

  const key2 = randomUUID();
  const second = await send(key2);
  check('a new key sends again', second.status === 200 && teamsCalls.length === 2, second);

  await postActivity(activity({ type: 'installationUpdate', action: 'remove' }), await signToken({ serviceurl: SERVICE_URL }));
  const afterRemove = await send(randomUUID());
  check('after install.remove the reference is gone: 404 no_reference', afterRemove.status === 404, afterRemove);
} finally {
  await service.stop();
  await new Promise<void>((r) => idp.close(() => r()));
  await gertrude.close();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
}

say(failures === 0 ? 'ROUND TRIP OK (fake Gertrude, fake Teams sender; real Teams not run)' : `ROUND TRIP FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
