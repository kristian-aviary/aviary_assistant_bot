/**
 * A stand-in for Gertrude's internal Teams reference routes, for local runs only.
 * Everything here is fake and committed on purpose: the token, the people, the ids.
 *
 *   PUT  /api/internal/teams/reference         link: store the conversation reference for a user
 *   POST /api/internal/teams/reference/remove  unlink: drop the reference for a (tenant, aad) identity
 *
 *   FAKE_GERTRUDE_PORT=4010 FAKE_GERTRUDE_USERS='you@example.com=samlp|aviary|you@example.com' npm run fake:gertrude
 *
 * Mirrors the bot <-> Gertrude contract: the bearer is checked before the body is read (401), the body is
 * validated strictly (400 INVALID_REQUEST on unknown or missing keys or wrong types), an unknown email or a
 * tenant that is not allowed is 404, an identity conflict is 409, and any other route or method is 404.
 * References are kept in memory only, keyed by user_id.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_VERIFY_TOKEN = 'local-fake-verify-token-not-a-secret';

export const LINK_PATH = '/api/internal/teams/reference';
export const REMOVE_PATH = '/api/internal/teams/reference/remove';

export type FakeGertrudeOptions = {
  port?: number;
  token?: string;
  /** email -> assistant user_id. Emails are matched lower-cased. */
  users?: Record<string, string>;
  allowedTenantIds?: string[];
  /** Called once per answered request on the two routes (matching method only). */
  onRequest?: (info: { route: 'link' | 'remove'; status: number }) => void;
};

export type FakeLink = {
  userId: string;
  tenantId: string;
  aadObjectId: string;
  conversationId: string;
  serviceUrl: string;
  reference: Record<string, unknown>;
};

export type FakeGertrudeServer = {
  url: string;
  server: Server;
  close(): Promise<void>;
  /** Snapshot of the stored references. */
  links(): FakeLink[];
};

export const DEFAULT_FAKE_USERS: Record<string, string> = {
  'alex.example@example.com': 'samlp|aviary|alex.example@example.com',
};

type StoredRow = Omit<FakeLink, 'userId'>;

const LINK_KEYS = ['aad_object_id', 'conversation_id', 'email', 'reference', 'service_url', 'tenant_id'] as const;
const LINK_STRING_KEYS = ['aad_object_id', 'conversation_id', 'email', 'service_url', 'tenant_id'] as const;
const REMOVE_KEYS = ['aad_object_id', 'tenant_id'] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function hasExactKeys(body: Record<string, unknown>, keys: readonly string[]): boolean {
  const want = [...keys].sort();
  const have = Object.keys(body).sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}

export async function startFakeGertrudeServer(opts: FakeGertrudeOptions = {}): Promise<FakeGertrudeServer> {
  const token = opts.token ?? FAKE_VERIFY_TOKEN;
  const users = new Map(Object.entries(opts.users ?? DEFAULT_FAKE_USERS).map(([email, userId]) => [email.trim().toLowerCase(), userId]));
  const allowedTenants = opts.allowedTenantIds?.map((t) => t.toLowerCase());
  const rows = new Map<string, StoredRow>();

  const routeFor = (method: string | undefined, url: string | undefined): 'link' | 'remove' | null => {
    if (method === 'PUT' && url === LINK_PATH) return 'link';
    if (method === 'POST' && url === REMOVE_PATH) return 'remove';
    return null;
  };

  const link = (body: Record<string, unknown>): { status: number; body: Record<string, unknown> } => {
    if (!hasExactKeys(body, LINK_KEYS) || !LINK_STRING_KEYS.every((k) => typeof body[k] === 'string') || !isPlainObject(body.reference)) {
      return { status: 400, body: { error: 'INVALID_REQUEST' } };
    }
    const tenantId = (body.tenant_id as string).toLowerCase();
    const aadObjectId = (body.aad_object_id as string).toLowerCase();
    const email = (body.email as string).trim().toLowerCase();
    const userId = users.get(email);
    const tenantAllowed = !allowedTenants || allowedTenants.includes(tenantId);
    if (!userId || !tenantAllowed) return { status: 404, body: { error: 'NOT_FOUND' } };

    const existing = rows.get(userId);
    const identityElsewhere = [...rows].some(([otherUser, row]) => otherUser !== userId && row.tenantId === tenantId && row.aadObjectId === aadObjectId);
    const userBoundElsewhere = existing !== undefined && (existing.tenantId !== tenantId || existing.aadObjectId !== aadObjectId);
    if (identityElsewhere || userBoundElsewhere) return { status: 409, body: { error: 'CONFLICT' } };

    rows.set(userId, {
      tenantId,
      aadObjectId,
      conversationId: body.conversation_id as string,
      serviceUrl: body.service_url as string,
      reference: body.reference as Record<string, unknown>,
    });
    return { status: 200, body: { status: existing ? 'refreshed' : 'created' } };
  };

  const remove = (body: Record<string, unknown>): { status: number; body: Record<string, unknown> } => {
    if (!hasExactKeys(body, REMOVE_KEYS) || typeof body.tenant_id !== 'string' || typeof body.aad_object_id !== 'string') {
      return { status: 400, body: { error: 'INVALID_REQUEST' } };
    }
    const tenantId = body.tenant_id.toLowerCase();
    const aadObjectId = body.aad_object_id.toLowerCase();
    let removed = false;
    for (const [userId, row] of rows) {
      if (row.tenantId === tenantId && row.aadObjectId === aadObjectId) {
        rows.delete(userId);
        removed = true;
      }
    }
    return { status: 200, body: { removed } };
  };

  const server = createServer((req, res) => {
    const route = routeFor(req.method, req.url);
    if (!route) return res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'NOT_FOUND' }));

    const respond = (status: number, body: Record<string, unknown>) => {
      opts.onRequest?.({ route, status });
      writeJson(res, status, body);
    };
    // The bearer is checked before the body is read.
    if (req.headers.authorization !== `Bearer ${token}`) return respond(401, { error: 'UNAUTHORIZED' });

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return respond(400, { error: 'INVALID_REQUEST' });
      }
      if (!isPlainObject(parsed)) return respond(400, { error: 'INVALID_REQUEST' });
      const result = route === 'link' ? link(parsed) : remove(parsed);
      return respond(result.status, result.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
    links: () =>
      [...rows].map(([userId, row]) => ({
        userId,
        tenantId: row.tenantId,
        aadObjectId: row.aadObjectId,
        conversationId: row.conversationId,
        serviceUrl: row.serviceUrl,
        reference: structuredClone(row.reference),
      })),
  };
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_GERTRUDE_PORT ?? 4010);
  const users = process.env.FAKE_GERTRUDE_USERS
    ? Object.fromEntries(
        process.env.FAKE_GERTRUDE_USERS.split(',').map((pair) => {
          const [email = '', ...rest] = pair.split('=');
          return [email.trim().toLowerCase(), rest.join('=').trim()];
        }),
      )
    : DEFAULT_FAKE_USERS;
  const { url } = await startFakeGertrudeServer({ port, users });
  process.stdout.write(`fake Gertrude on ${url} (bearer ${FAKE_VERIFY_TOKEN}); known emails: ${Object.keys(users).join(', ')}\n`);
}
