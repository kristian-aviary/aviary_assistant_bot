/**
 * A stand-in for Gertrude's POST /api/internal/teams/verify, for local runs only.
 * Everything here is fake and committed on purpose: the token, the people, the ids.
 *
 *   FAKE_GERTRUDE_PORT=4010 npm run fake:gertrude
 *
 * Mirrors contract section 3: 401 on a bad bearer, 400 on a body with unknown keys,
 * 404 {"error":"NOT_FOUND"} for an unknown email or a tenant that is not allowed, else 200 {"user_id"}.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_VERIFY_TOKEN = 'local-fake-verify-token-not-a-secret';

export type FakeGertrudeOptions = {
  port?: number;
  token?: string;
  /** lower-cased email -> assistant user_id */
  users?: Record<string, string>;
  allowedTenantIds?: string[];
  onVerify?: (info: { status: number }) => void;
};

export const DEFAULT_FAKE_USERS: Record<string, string> = {
  'alex.example@example.com': 'samlp|aviary|alex.example@example.com',
};

export async function startFakeGertrudeServer(opts: FakeGertrudeOptions = {}): Promise<{ url: string; server: Server; close(): Promise<void> }> {
  const token = opts.token ?? FAKE_VERIFY_TOKEN;
  const users = opts.users ?? DEFAULT_FAKE_USERS;
  const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    opts.onVerify?.({ status });
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/internal/teams/verify') return send(res, 404, { error: 'NOT_FOUND' });
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'UNAUTHORIZED' });
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        return send(res, 400, { error: 'BAD_REQUEST' });
      }
      const keys = Object.keys(body).sort().join(',');
      if (keys !== 'aad_object_id,email,tenant_id' || Object.values(body).some((v) => typeof v !== 'string')) {
        return send(res, 400, { error: 'BAD_REQUEST' });
      }
      const tenantOk = !opts.allowedTenantIds || opts.allowedTenantIds.includes(body.tenant_id as string);
      const userId = users[body.email as string];
      if (!tenantOk || !userId) return send(res, 404, { error: 'NOT_FOUND' });
      return send(res, 200, { user_id: userId });
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, server, close: () => new Promise<void>((r) => server.close(() => r())) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_GERTRUDE_PORT ?? 4010);
  const { url } = await startFakeGertrudeServer({ port });
  process.stdout.write(`fake Gertrude on ${url} (bearer ${FAKE_VERIFY_TOKEN}); known email: ${Object.keys(DEFAULT_FAKE_USERS).join(', ')}\n`);
}
