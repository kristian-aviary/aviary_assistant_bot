import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpGertrudeClient, LINK_PATH, REMOVE_PATH, type LinkInput } from '../src/gertrude.js';
import { VERIFY_TOKEN } from './helpers/constants.js';
import { json, startFake, type FakeServer } from './helpers/httpFake.js';

const link: LinkInput = {
  tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  aadObjectId: 'f0f0f0f0-1111-4222-8333-444444444444',
  email: 'someone@example.com',
  conversationId: 'a:1-conversation',
  serviceUrl: 'https://smba.trafficmanager.net/emea',
  reference: {
    channelId: 'msteams',
    serviceUrl: 'https://smba.trafficmanager.net/emea',
    conversation: { id: 'a:1-conversation', conversationType: 'personal', tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    bot: { id: '28:bot' },
    user: { id: '29:user', aadObjectId: 'f0f0f0f0-1111-4222-8333-444444444444' },
  },
};

let fake: FakeServer | undefined;
let respond: (res: import('node:http').ServerResponse) => unknown;
const written: string[] = [];
const spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  respond = (res) => json(res, 200, { status: 'created', removed: true });
  written.length = 0;
  const capture = (chunk: unknown) => (written.push(String(chunk)), true);
  spies.push(vi.spyOn(process.stdout, 'write').mockImplementation(capture as never));
  spies.push(vi.spyOn(process.stderr, 'write').mockImplementation(capture as never));
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void written.push(a.map(String).join(' '))));
  }
});
afterEach(async () => {
  spies.splice(0).forEach((s) => s.mockRestore());
  await fake?.close();
  fake = undefined;
});

async function client(timeoutMs?: number, token = VERIFY_TOKEN) {
  fake = await startFake((_req, res) => respond(res));
  return new HttpGertrudeClient(fake.url, token, timeoutMs);
}

describe('linkReference: PUT /api/internal/teams/reference', () => {
  it('sends the bearer, a PUT, and exactly the contract body', async () => {
    const c = await client();
    await c.linkReference(link);
    expect(fake!.requests).toHaveLength(1);
    const req = fake!.requests[0]!;
    expect(req.method).toBe('PUT');
    expect(req.url).toBe(LINK_PATH);
    expect(req.headers.authorization).toBe(`Bearer ${VERIFY_TOKEN}`);
    expect(req.headers['content-type']).toContain('application/json');
    expect(req.body).toEqual({
      tenant_id: link.tenantId,
      aad_object_id: link.aadObjectId,
      email: link.email,
      conversation_id: link.conversationId,
      service_url: link.serviceUrl,
      reference: link.reference,
    });
    expect(Object.keys(req.body as object).sort()).toEqual(['aad_object_id', 'conversation_id', 'email', 'reference', 'service_url', 'tenant_id']);
  });

  it('a trailing slash is not in the config value, so the path is exact', async () => {
    const c = await client();
    await c.linkReference(link);
    expect(fake!.requests[0]!.url).toBe('/api/internal/teams/reference');
  });

  it.each([
    [200, { status: 'created' }, { kind: 'created' }],
    [200, { status: 'refreshed' }, { kind: 'refreshed' }],
    [200, { status: 'refreshed', extra: 'additive fields are ignored' }, { kind: 'refreshed' }],
    [404, { error: 'NOT_FOUND' }, { kind: 'not_found' }],
    [409, { error: 'CONFLICT' }, { kind: 'conflict' }],
    [401, { error: 'UNAUTHORIZED' }, { kind: 'unauthorized' }],
    [400, { error: 'INVALID_REQUEST' }, { kind: 'bad_request' }],
    [429, { error: 'X' }, { kind: 'unavailable', code: 'http_429' }],
    [500, { error: 'X' }, { kind: 'unavailable', code: 'http_500' }],
    [502, 'bad gateway', { kind: 'unavailable', code: 'http_502' }],
    [503, {}, { kind: 'unavailable', code: 'http_503' }],
    [204, undefined, { kind: 'unavailable', code: 'http_204' }],
  ])('%i %j -> %j (a value, never a throw)', async (status, body, expected) => {
    respond = (res) => (body === undefined ? res.writeHead(status).end() : json(res, status, body));
    const c = await client();
    await expect(c.linkReference(link)).resolves.toEqual(expected);
    expect(fake!.requests).toHaveLength(1); // no retry loop
  });

  it.each([
    ['a status that is not created/refreshed', { status: 'weird' }],
    ['no status', {}],
    ['a non-object', 'created'],
    ['an array', ['created']],
  ])('200 with %s: unavailable bad_body', async (_n, body) => {
    respond = (res) => json(res, 200, body);
    const c = await client();
    await expect(c.linkReference(link)).resolves.toEqual({ kind: 'unavailable', code: 'bad_body' });
  });

  it('200 that is not JSON: unavailable bad_body', async () => {
    respond = (res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('created');
    const c = await client();
    await expect(c.linkReference(link)).resolves.toEqual({ kind: 'unavailable', code: 'bad_body' });
  });

  it('timeout is classified, after about the configured time', async () => {
    respond = () => undefined; // never answers
    const c = await client(150);
    const started = Date.now();
    await expect(c.linkReference(link)).resolves.toEqual({ kind: 'unavailable', code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a reset connection is unavailable network', async () => {
    respond = (res) => res.destroy();
    const c = await client();
    await expect(c.linkReference(link)).resolves.toEqual({ kind: 'unavailable', code: 'network' });
  });

  it('nothing listening is unavailable network', async () => {
    const c = new HttpGertrudeClient('http://127.0.0.1:1', VERIFY_TOKEN);
    await expect(c.linkReference(link)).resolves.toEqual({ kind: 'unavailable', code: 'network' });
  });

  it('redirects are refused (the bearer is never replayed to another URL)', async () => {
    const target = await startFake((_req, res) => json(res, 200, { status: 'created' }));
    try {
      respond = (res) => res.writeHead(307, { location: `${target.url}${LINK_PATH}` }).end();
      const c = await client();
      await expect(c.linkReference(link)).resolves.toEqual({ kind: 'unavailable', code: 'network' });
      expect(target.requests).toHaveLength(0);
    } finally {
      await target.close();
    }
  });
});

describe('removeReference: POST /api/internal/teams/reference/remove', () => {
  const input = { tenantId: link.tenantId, aadObjectId: link.aadObjectId };

  it('sends the bearer, a POST, and only tenant_id and aad_object_id', async () => {
    const c = await client();
    await c.removeReference(input);
    const req = fake!.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(REMOVE_PATH);
    expect(req.headers.authorization).toBe(`Bearer ${VERIFY_TOKEN}`);
    expect(req.body).toEqual({ tenant_id: link.tenantId, aad_object_id: link.aadObjectId });
  });

  it.each([
    [200, { removed: true }, { kind: 'removed', removed: true }],
    [200, { removed: false }, { kind: 'removed', removed: false }],
    [200, { removed: true, extra: 1 }, { kind: 'removed', removed: true }],
    [401, { error: 'UNAUTHORIZED' }, { kind: 'unauthorized' }],
    [400, { error: 'INVALID_REQUEST' }, { kind: 'bad_request' }],
    [404, { error: 'NOT_FOUND' }, { kind: 'unavailable', code: 'http_404' }],
    [429, {}, { kind: 'unavailable', code: 'http_429' }],
    [500, {}, { kind: 'unavailable', code: 'http_500' }],
    [200, { removed: 'yes' }, { kind: 'unavailable', code: 'bad_body' }],
    [200, {}, { kind: 'unavailable', code: 'bad_body' }],
  ])('%i %j -> %j', async (status, body, expected) => {
    respond = (res) => json(res, status, body);
    const c = await client();
    await expect(c.removeReference(input)).resolves.toEqual(expected);
    expect(fake!.requests).toHaveLength(1);
  });

  it('timeout and reset are unavailable, never a throw', async () => {
    respond = () => undefined;
    const c = await client(100);
    await expect(c.removeReference(input)).resolves.toEqual({ kind: 'unavailable', code: 'timeout' });
    respond = (res) => res.destroy();
    await expect(c.removeReference(input)).resolves.toEqual({ kind: 'unavailable', code: 'network' });
  });

  it('redirects are refused', async () => {
    respond = (res) => res.writeHead(302, { location: 'http://127.0.0.1:1/x' }).end();
    const c = await client();
    await expect(c.removeReference(input)).resolves.toEqual({ kind: 'unavailable', code: 'network' });
  });
});

describe('the client is silent', () => {
  it('writes nothing to stdout, stderr or console on any outcome', async () => {
    const c = await client(100);
    for (const behavior of [
      (res: import('node:http').ServerResponse) => json(res, 200, { status: 'created', removed: true }),
      (res: import('node:http').ServerResponse) => json(res, 401, { error: 'UNAUTHORIZED' }),
      (res: import('node:http').ServerResponse) => json(res, 500, {}),
      (res: import('node:http').ServerResponse) => res.destroy(),
      () => undefined,
    ]) {
      respond = behavior;
      await c.linkReference(link);
      await c.removeReference({ tenantId: link.tenantId, aadObjectId: link.aadObjectId });
    }
    expect(written.join('')).toBe('');
  });

  it('a failure result carries a short code, never the request or the token', async () => {
    respond = (res) => res.destroy();
    const c = await client();
    const r = await c.linkReference(link);
    const text = JSON.stringify(r);
    for (const secret of [VERIFY_TOKEN, link.email, link.tenantId, link.aadObjectId, link.conversationId, link.serviceUrl]) {
      expect(text).not.toContain(secret);
    }
  });
});
