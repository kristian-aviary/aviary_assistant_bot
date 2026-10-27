import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_ID } from './helpers/constants.js';
import { activity, createHarness, type Harness } from './helpers/harness.js';
import { assertCleanLogsAfterAll, captureLogs } from './helpers/logs.js';

const logs = captureLogs();
assertCleanLogsAfterAll(logs);
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ logs });
});
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  h.gertrude.requests.length = 0;
  h.connector.requests.length = 0;
  await h.db.pool.query('truncate conversation_reference');
});

const nothingHappened = async () => {
  expect(h.gertrude.verifyCalls()).toBe(0);
  expect(h.connector.requests).toHaveLength(0);
  expect((await h.db.pool.query('select count(*)::int as n from conversation_reference')).rows[0].n).toBe(0);
};

describe('the SDK validates every inbound token on /api/messages (validation is never bypassed)', () => {
  it('a correctly signed token for our app runs the handler', async () => {
    const res = await h.signedActivityPost(activity({ serviceUrl: h.serviceUrl }));
    expect(res.status).toBe(200);
    expect(h.gertrude.verifyCalls()).toBe(1);
  });

  it('no Authorization header: 401', async () => {
    const res = await h.postActivity(activity({ serviceUrl: h.serviceUrl }));
    expect(res.status).toBe(401);
    await nothingHappened();
  });

  it.each([
    ['not a JWT', 'garbage'],
    ['empty bearer value', ''],
    ['a JWT with a bogus payload', 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln'],
  ])('%s: 401', async (_n, token) => {
    const res = await h.postActivity(activity({ serviceUrl: h.serviceUrl }), token || undefined);
    expect(res.status).toBe(401);
    await nothingHappened();
  });

  it('a token signed by a key that is not in the JWKS: 401', async () => {
    const token = await h.idp.signWithUnknownKey({ serviceurl: h.serviceUrl });
    expect((await h.postActivity(activity({ serviceUrl: h.serviceUrl }), token)).status).toBe(401);
    await nothingHappened();
  });

  it('wrong audience (a token for some other bot): 401', async () => {
    const token = await h.idp.signToken({ serviceurl: h.serviceUrl, aud: '00000000-0000-4000-8000-000000000000' });
    expect((await h.postActivity(activity({ serviceUrl: h.serviceUrl }), token)).status).toBe(401);
    await nothingHappened();
  });

  it('wrong issuer: 401', async () => {
    const token = await h.idp.signToken({ serviceurl: h.serviceUrl, iss: 'https://evil.example.com' });
    expect((await h.postActivity(activity({ serviceUrl: h.serviceUrl }), token)).status).toBe(401);
    await nothingHappened();
  });

  it('serviceurl claim that does not match the activity serviceUrl: 401 (blocks redirecting our bot token to an attacker URL)', async () => {
    const token = await h.idp.signToken({ serviceurl: 'https://smba.trafficmanager.net/emea/' });
    expect((await h.postActivity(activity({ serviceUrl: h.serviceUrl }), token)).status).toBe(401);
    await nothingHappened();
  });

  it('a token without a serviceurl claim: 401', async () => {
    const token = await h.idp.signToken({});
    expect((await h.postActivity(activity({ serviceUrl: h.serviceUrl }), token)).status).toBe(401);
    await nothingHappened();
  });

  it('an expired token: 401', async () => {
    const token = await h.idp.signToken({ serviceurl: h.serviceUrl, expiresInSeconds: -3600 });
    expect((await h.postActivity(activity({ serviceUrl: h.serviceUrl }), token)).status).toBe(401);
    await nothingHappened();
  });

  it('the Authorization header scheme is irrelevant to the answer: a valid token in a malformed header is still validated', async () => {
    const res = await fetch(`${h.baseUrl}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic abc' },
      body: JSON.stringify(activity({ serviceUrl: h.serviceUrl })),
    });
    expect(res.status).toBe(401);
    await nothingHappened();
  });

  it('GET on /api/messages is not served', async () => {
    expect((await fetch(`${h.baseUrl}/api/messages`)).status).toBe(404);
  });

  it('the app is built with the SDK flags that disable auth turned off, and our credentials present', () => {
    const opts = h.service.app.options as Record<string, unknown>;
    expect(opts.dangerouslyAllowUnauthenticatedRequests).toBeUndefined();
    expect(opts.skipAuth).toBeUndefined();
    expect(h.service.app.id).toBe(CLIENT_ID);
  });

  it('no source file mentions the SDK switches that disable inbound validation', () => {
    const dir = path.resolve(import.meta.dirname, '..');
    const files = [...walk(path.join(dir, 'src')), ...walk(path.join(dir, 'scripts'))];
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const banned of ['dangerouslyAllowUnauthenticatedRequests', 'skipAuth']) {
        const code = text.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
        expect(code.some((l) => l.includes(banned)), `${path.relative(dir, f)} mentions ${banned}`).toBe(false);
      }
    }
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}
