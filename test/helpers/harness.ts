import { randomUUID } from 'node:crypto';
import type { Config } from '../../src/config.js';
import type { InboundPorts } from '../../src/inbound.js';
import { HttpGertrudeClient } from '../../src/gertrude.js';
import { startService, type RunningService } from '../../src/server.js';
import { DEFAULT_SERVICE_URL_HOSTS } from '../../src/serviceUrl.js';
import type { TeamsSender } from '../../src/teamsSender.js';
import {
  BOT_TENANT_ID,
  CLIENT_ID,
  CLIENT_SECRET,
  CONVERSATION_ID,
  SEND_TOKEN,
  TEAMS_USER_ID,
  USER_AAD_ID,
  USER_TENANT_ID,
  VERIFY_TOKEN,
  sendBody,
} from './constants.js';
import { startFakeConnector, type FakeConnector } from './fakeConnector.js';
import { startFakeGertrude, type FakeGertrude, type GertrudeBehavior } from './fakeGertrude.js';
import { startFakeIdentityProvider, type FakeIdentityProvider } from './jwks.js';
import { captureLogs, type LogCapture } from './logs.js';
import { createTestDb, type TestDb } from './pg.js';

export type Harness = {
  db: TestDb;
  logs: LogCapture;
  gertrude: FakeGertrude;
  connector: FakeConnector;
  idp: FakeIdentityProvider;
  service: RunningService;
  config: Config;
  baseUrl: string;
  serviceUrl: string;
  send(body?: unknown, opts?: { token?: string | null; key?: string | null; headers?: Record<string, string> }): Promise<{ status: number; body: any; headers: Headers; key: string }>;
  postActivity(activity: unknown, token?: string | null): Promise<{ status: number; body: string }>;
  signedActivityPost(activity: unknown): Promise<{ status: number; body: string }>;
  stop(): Promise<void>;
};

export type HarnessOptions = {
  sender?: TeamsSender;
  ports?: InboundPorts;
  gertrude?: GertrudeBehavior;
  sendDeadlineMs?: number;
  logs?: LogCapture;
  drainTimeoutMs?: number;
  gertrudeTimeoutMs?: number;
  teamsTimeoutMs?: number;
};

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const db = await createTestDb();
  const logs = opts.logs ?? captureLogs();
  const gertrude = await startFakeGertrude(VERIFY_TOKEN, opts.gertrude);
  const connector = await startFakeConnector();
  const idp = await startFakeIdentityProvider();
  const config: Config = {
    databaseUrl: db.url,
    gertrudeUrl: gertrude.url,
    gertrudeVerifyToken: VERIFY_TOKEN,
    sendServiceToken: SEND_TOKEN,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tenantId: BOT_TENANT_ID,
    port: 0,
    extraServiceUrlHosts: [],
  };
  const botToken = await idp.signToken({ expiresInSeconds: 3600 });
  const service = await startService(config, logs.logger, {
    pool: db.pool,
    sender: opts.sender,
    gertrude: opts.gertrudeTimeoutMs ? new HttpGertrudeClient(gertrude.url, VERIFY_TOKEN, opts.gertrudeTimeoutMs) : undefined,
    ports: opts.ports,
    serviceUrlPolicy: { allowedHosts: DEFAULT_SERVICE_URL_HOSTS, allowLoopbackHttp: true },
    testOverrides: { cloud: idp.cloud, token: () => botToken },
    sendDeadlineMs: opts.sendDeadlineMs,
    listenPort: 0,
    drainTimeoutMs: opts.drainTimeoutMs,
    teamsTimeoutMs: opts.teamsTimeoutMs,
  });
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const serviceUrl = `${connector.url}/emea/`;

  const harness: Harness = {
    db,
    logs,
    gertrude,
    connector,
    idp,
    service,
    config,
    baseUrl,
    serviceUrl,
    async send(body = sendBody(), o = {}) {
      const key = o.key === null ? '' : (o.key ?? randomUUID());
      const headers: Record<string, string> = { 'content-type': 'application/json', ...o.headers };
      if (o.token !== null) headers.authorization = `Bearer ${o.token ?? SEND_TOKEN}`;
      if (o.key !== null) headers['idempotency-key'] = key;
      const res = await fetch(`${baseUrl}/v1/send`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not json
      }
      return { status: res.status, body: parsed as any, headers: res.headers, key };
    },
    async postActivity(activity, token) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${baseUrl}/api/messages`, { method: 'POST', headers, body: JSON.stringify(activity) });
      return { status: res.status, body: await res.text() };
    },
    async signedActivityPost(activity) {
      const token = await idp.signToken({ serviceurl: serviceUrl });
      return harness.postActivity(activity, token);
    },
    async stop() {
      await service.stop().catch(() => {});
      await Promise.all([gertrude.close(), connector.close(), idp.close()]);
      await db.drop();
    },
  };
  return harness;
}

export function activity(
  over: {
    type?: string;
    name?: string;
    action?: string;
    conversationType?: 'personal' | 'groupChat' | 'channel';
    conversationId?: string;
    serviceUrl: string;
    text?: string;
    aadObjectId?: string | null;
    tenantId?: string;
    channelDataTenantId?: string;
    channelId?: string;
  },
): Record<string, unknown> {
  const conversationType = over.conversationType ?? 'personal';
  return {
    type: over.type ?? 'message',
    ...(over.action ? { action: over.action } : {}),
    id: `activity-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    channelId: over.channelId ?? 'msteams',
    serviceUrl: over.serviceUrl,
    from: { id: TEAMS_USER_ID, name: 'Some One', ...(over.aadObjectId === null ? {} : { aadObjectId: over.aadObjectId ?? USER_AAD_ID }) },
    recipient: { id: `28:${CLIENT_ID}`, name: 'Aviary Assistant' },
    conversation: {
      id: over.conversationId ?? CONVERSATION_ID,
      conversationType,
      isGroup: conversationType !== 'personal',
      tenantId: over.tenantId ?? USER_TENANT_ID,
    },
    channelData: { tenant: { id: over.channelDataTenantId ?? over.tenantId ?? USER_TENANT_ID } },
    text: over.text ?? 'hello',
    entities: [],
    locale: 'en-US',
  };
}
