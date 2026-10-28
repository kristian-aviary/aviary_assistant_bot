import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryIdempotencyStore } from '../src/idempotency.js';
import { SendService } from '../src/sendService.js';
import { DEFAULT_SERVICE_URL_HOSTS } from '../src/serviceUrl.js';
import { ALLOWED_SERVICE_URL, CONVERSATION_ID, SEND_TOKEN, sampleCard, sendBody } from './helpers/constants.js';
import { FakeTeamsSender } from './helpers/fakeSender.js';
import { captureLogs, expectCleanLogs } from './helpers/logs.js';

/** The real policy (no loopback escape hatch), no HTTP: the point is that Teams is never reached. */
function setup() {
  const sender = new FakeTeamsSender();
  const idempotency = new InMemoryIdempotencyStore();
  const logs = captureLogs();
  const service = new SendService({
    token: SEND_TOKEN,
    idempotency,
    serviceUrlPolicy: { allowedHosts: DEFAULT_SERVICE_URL_HOSTS },
    sender,
    logger: logs.logger,
  });
  const send = (body: unknown, over: { authorization?: string | undefined; key?: string | undefined } = {}) =>
    service.handle({
      authorization: 'authorization' in over ? over.authorization : `Bearer ${SEND_TOKEN}`,
      idempotencyKey: 'key' in over ? over.key : randomUUID(),
      body,
    });
  return { sender, idempotency, logs, service, send };
}

describe('service_url is re-validated on every send (same policy as install)', () => {
  it.each([
    ['http scheme', 'http://smba.trafficmanager.net/emea/'],
    ['other host', 'https://evil.example.com/emea/'],
    ['lookalike suffix', 'https://smba.trafficmanager.net.evil.com/emea/'],
    ['lookalike prefix', 'https://evil-smba.trafficmanager.net/emea/'],
    ['sub-domain of the allowed host', 'https://x.smba.trafficmanager.net/emea/'],
    ['userinfo trick', 'https://smba.trafficmanager.net@evil.com/emea/'],
    ['credentials', 'https://user:pw@smba.trafficmanager.net/emea/'],
    ['password only', 'https://:pw@smba.trafficmanager.net/emea/'],
    ['other port', 'https://smba.trafficmanager.net:8443/emea/'],
    ['port 80', 'https://smba.trafficmanager.net:80/emea/'],
    ['trailing-dot host', 'https://smba.trafficmanager.net./emea/'],
    ['trailing-dot lookalike', 'https://smba.trafficmanager.net.evil.com./emea/'],
    ['query string', 'https://smba.trafficmanager.net/emea/?x=1'],
    ['fragment', 'https://smba.trafficmanager.net/emea/#x'],
    ['loopback http (only a test flag allows it)', 'http://127.0.0.1:3000/emea/'],
    ['localhost', 'https://localhost/emea/'],
    ['ip literal', 'https://127.0.0.1/emea/'],
    ['file scheme', 'file:///etc/passwd'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['ftp scheme', 'ftp://smba.trafficmanager.net/emea/'],
    ['scheme-relative', '//smba.trafficmanager.net/emea/'],
    ['no scheme', 'smba.trafficmanager.net/emea/'],
    ['empty', ''],
    ['whitespace', '   '],
    ['not a URL', 'not a url'],
    ['longer than 512 characters', `https://smba.trafficmanager.net/${'a'.repeat(520)}`],
    ['null', null],
    ['number', 42],
    ['array holding an allowed url', [ALLOWED_SERVICE_URL]],
    ['object', { href: ALLOWED_SERVICE_URL }],
  ])('%s: 400 invalid_request, Teams is never called, the key is not claimed', async (_name, serviceUrl) => {
    const { sender, idempotency, send, logs } = setup();
    const r = await send(sendBody({ service_url: serviceUrl }));
    expect(r.status).toBe(400);
    expect(r.body.status).toBe('invalid_request');
    expect(JSON.stringify(r.body)).not.toContain('evil');
    expect(sender.calls).toHaveLength(0);
    expect(idempotency.size).toBe(0);
    expectCleanLogs(logs.lines);
  });

  it.each([
    ['canonical', 'https://smba.trafficmanager.net/emea/', 'https://smba.trafficmanager.net/emea'],
    ['upper-case host and extra slashes', 'https://SMBA.TrafficManager.net/amer///', 'https://smba.trafficmanager.net/amer'],
  ])('an allow-listed url is accepted and handed to Teams normalized (%s)', async (_name, serviceUrl, normalized) => {
    const { sender, send } = setup();
    const r = await send(sendBody({ service_url: serviceUrl }));
    expect(r.status).toBe(200);
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]!.target).toEqual({ conversationId: CONVERSATION_ID, serviceUrl: normalized });
  });

  it('hosts added through SERVICE_URL_ALLOWED_HOSTS are honoured, and only those', async () => {
    const sender = new FakeTeamsSender();
    const service = new SendService({
      token: SEND_TOKEN,
      idempotency: new InMemoryIdempotencyStore(),
      serviceUrlPolicy: { allowedHosts: [...DEFAULT_SERVICE_URL_HOSTS, 'smba.infra.gcc.teams.microsoft.com'] },
      sender,
      logger: captureLogs().logger,
    });
    const call = (service_url: string) =>
      service.handle({ authorization: `Bearer ${SEND_TOKEN}`, idempotencyKey: randomUUID(), body: sendBody({ service_url }) });
    expect((await call('https://smba.infra.gcc.teams.microsoft.com/teams/')).status).toBe(200);
    expect((await call('https://smba.infra.gcc.teams.microsoft.com.evil.com/teams/')).status).toBe(400);
    expect(sender.calls).toHaveLength(1);
  });
});

describe('strict body', () => {
  const card = sampleCard();
  it.each([
    ['unknown key', sendBody({ extra: true })],
    ['user_id', sendBody({ user_id: 'samlp|aviary|someone' })],
    ['reference', sendBody({ reference: { channelId: 'msteams' } })],
    ['both user_id and reference', sendBody({ user_id: 'u', reference: {} })],
    ['missing conversation_id', { service_url: ALLOWED_SERVICE_URL, card, fallback_text: 'x' }],
    ['empty conversation_id', sendBody({ conversation_id: '' })],
    ['conversation_id not a string', sendBody({ conversation_id: 7 })],
    ['conversation_id over 512', sendBody({ conversation_id: 'c'.repeat(513) })],
    ['conversation_id with a slash (path change)', sendBody({ conversation_id: 'a:1/../../v3/other' })],
    ['conversation_id with a query', sendBody({ conversation_id: 'a:1?x=1' })],
    ['conversation_id with a fragment', sendBody({ conversation_id: 'a:1#x' })],
    ['conversation_id with a backslash', sendBody({ conversation_id: 'a:1\\2' })],
    ['conversation_id with a percent escape', sendBody({ conversation_id: 'a:1%2f2' })],
    ['conversation_id with whitespace', sendBody({ conversation_id: 'a:1 2' })],
    ['conversation_id with a control character', sendBody({ conversation_id: 'a:1\n2' })],
    ['missing service_url', { conversation_id: CONVERSATION_ID, card, fallback_text: 'x' }],
    ['missing card', { conversation_id: CONVERSATION_ID, service_url: ALLOWED_SERVICE_URL, fallback_text: 'x' }],
    ['card is a string', sendBody({ card: 'AdaptiveCard' })],
    ['card is null', sendBody({ card: null })],
    ['card is an array', sendBody({ card: [card] })],
    ['card of another type', sendBody({ card: { type: 'HeroCard' } })],
    ['card with no type', sendBody({ card: { version: '1.5' } })],
    ['card over 25 KB', sendBody({ card: sampleCard({ body: [{ type: 'TextBlock', text: 'x'.repeat(26 * 1024) }] }) })],
    ['missing fallback_text', { conversation_id: CONVERSATION_ID, service_url: ALLOWED_SERVICE_URL, card }],
    ['empty fallback_text', sendBody({ fallback_text: '' })],
    ['fallback_text not a string', sendBody({ fallback_text: { text: 'x' } })],
    ['body is a string', 'hello'],
    ['body is null', null],
    ['body is an array', [sendBody()]],
    ['body is undefined', undefined],
  ])('%s: 400 invalid_request and nothing sent', async (_name, body) => {
    const { sender, idempotency, send } = setup();
    const r = await send(body);
    expect(r.status).toBe(400);
    expect(r.body.status).toBe('invalid_request');
    expect(sender.calls).toHaveLength(0);
    expect(idempotency.size).toBe(0);
  });

  it.each(['a:1AbC-def_GHI', '19:abc123@thread.v2', '19:abc@thread.tacv2;messageid=1700000000000', '29:1-user.id'])(
    'real-looking Teams conversation id %s is accepted',
    async (conversation_id) => {
      const { send, sender } = setup();
      expect((await send(sendBody({ conversation_id }))).status).toBe(200);
      expect(sender.calls[0]!.target.conversationId).toBe(conversation_id);
    },
  );

  it('conversation_id of exactly 512 characters is accepted', async () => {
    const { send } = setup();
    expect((await send(sendBody({ conversation_id: 'c'.repeat(512) }))).status).toBe(200);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a uuid', 'delivery-1'],
  ])('Idempotency-Key %s: 400', async (_name, key) => {
    const { sender, send } = setup();
    expect((await send(sendBody(), { key })).status).toBe(400);
    expect(sender.calls).toHaveLength(0);
  });
});

describe('authentication comes first', () => {
  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['empty bearer', 'Bearer '],
    ['wrong token', 'Bearer not-the-token'],
    ['wrong scheme', `Basic ${SEND_TOKEN}`],
    ['no scheme', SEND_TOKEN],
  ])('%s: 401 even when the body is also invalid, and nothing is read or sent', async (_name, authorization) => {
    const { sender, idempotency, send } = setup();
    const r = await send({ garbage: true }, { authorization });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ status: 'unauthorized' });
    expect(sender.calls).toHaveLength(0);
    expect(idempotency.size).toBe(0);
  });

  it('a service configured with an empty token authenticates nobody (not even an empty bearer)', async () => {
    const sender = new FakeTeamsSender();
    const service = new SendService({
      token: '',
      idempotency: new InMemoryIdempotencyStore(),
      serviceUrlPolicy: { allowedHosts: DEFAULT_SERVICE_URL_HOSTS },
      sender,
      logger: captureLogs().logger,
    });
    for (const authorization of ['Bearer ', 'Bearer', '', undefined]) {
      const r = await service.handle({ authorization, idempotencyKey: randomUUID(), body: sendBody() });
      expect(r.status).toBe(401);
    }
    expect(sender.calls).toHaveLength(0);
  });
});
