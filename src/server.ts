import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { App } from '@microsoft/teams.apps';
import type { Config } from './config.js';
import { createPool, migrate, pingDb, type Db } from './db.js';
import { HttpGertrudeClient, type GertrudeClient } from './gertrude.js';
import { InboundService, type InboundPorts } from './inbound.js';
import { mountFallbacks, mountRoutes } from './httpApp.js';
import type { Logger } from './logger.js';
import { PgConversationReferenceStore, PgIdempotencyStore } from './repositories.js';
import { SendService } from './sendService.js';
import { DEFAULT_SERVICE_URL_HOSTS, type ServiceUrlPolicy } from './serviceUrl.js';
import { createSdkPorts, createTeamsApp, registerInboundHandlers, type TeamsAppOptions } from './teamsApp.js';
import { SdkTeamsSender, type TeamsSender } from './teamsSender.js';

export const IDEMPOTENCY_RETENTION_DAYS = 45;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type ServiceOverrides = {
  pool?: Db;
  sender?: TeamsSender;
  ports?: InboundPorts;
  gertrude?: GertrudeClient;
  serviceUrlPolicy?: ServiceUrlPolicy;
  testOverrides?: TeamsAppOptions['testOverrides'];
  sendDeadlineMs?: number;
  listenPort?: number;
  drainTimeoutMs?: number;
  teamsTimeoutMs?: number;
};

export type RunningService = {
  port: number;
  server: Server;
  app: App;
  sendService: SendService;
  pool: Db;
  stop(): Promise<void>;
};

export async function startService(config: Config, logger: Logger, overrides: ServiceOverrides = {}): Promise<RunningService> {
  const ownsPool = overrides.pool === undefined;
  const pool = overrides.pool ?? createPool(config.databaseUrl);
  await migrate(pool);

  const policy: ServiceUrlPolicy = overrides.serviceUrlPolicy ?? {
    allowedHosts: [...DEFAULT_SERVICE_URL_HOSTS, ...config.extraServiceUrlHosts],
  };
  const references = new PgConversationReferenceStore(pool);
  const idempotency = new PgIdempotencyStore(pool);

  const { app, express } = createTeamsApp({ config, logger, testOverrides: overrides.testOverrides, requestTimeoutMs: overrides.teamsTimeoutMs });
  let draining = false;
  const sendService = new SendService({
    token: config.sendServiceToken,
    references,
    idempotency,
    sender: overrides.sender ?? new SdkTeamsSender(app, policy),
    logger,
    deadlineMs: overrides.sendDeadlineMs,
    isDraining: () => draining,
  });
  const inbound = new InboundService({
    references,
    gertrude: overrides.gertrude ?? new HttpGertrudeClient(config.gertrudeUrl, config.gertrudeVerifyToken),
    ports: overrides.ports ?? createSdkPorts(app),
    logger,
    serviceUrlPolicy: policy,
  });

  mountRoutes(express, { sendService, sendToken: config.sendServiceToken, ping: () => pingDb(pool), logger });
  registerInboundHandlers(app, inbound, logger);
  await app.initialize();
  mountFallbacks(express, logger);

  const server = createServer(express);
  server.keepAliveTimeout = 65_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(overrides.listenPort ?? config.port, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  const purge = () => {
    idempotency.purgeOlderThan(IDEMPOTENCY_RETENTION_DAYS).then(
      (n) => logger.info('idempotency_purged', { count: n }),
      () => logger.warn('idempotency_purge_failed', { code: 'DB_ERROR' }),
    );
  };
  purge();
  const purgeTimer = setInterval(purge, PURGE_INTERVAL_MS);
  purgeTimer.unref();

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      draining = true;
      clearInterval(purgeTimer);
      // Stop accepting; idle keep-alive sockets go now, busy ones finish their request.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const drained = await sendService.drain(overrides.drainTimeoutMs ?? 10_000);
      if (!drained) logger.warn('shutdown_inflight_abandoned', { count: sendService.inFlightCount });
      // Let responses for just-finished sends flush before cutting the remaining sockets.
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
      server.closeAllConnections();
      await closed;
      if (ownsPool) await pool.end();
    })());

  logger.info('service_started', { port });
  return { port, server, app, sendService, pool, stop };
}
