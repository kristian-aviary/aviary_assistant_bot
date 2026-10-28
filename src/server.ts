import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { App } from '@microsoft/teams.apps';
import type { Config } from './config.js';
import { HttpGertrudeClient, type GertrudeClient } from './gertrude.js';
import { InboundService, type InboundPorts } from './inbound.js';
import { mountFallbacks, mountRoutes } from './httpApp.js';
import type { Logger } from './logger.js';
import { InMemoryIdempotencyStore, type IdempotencyStore } from './idempotency.js';
import { SendService } from './sendService.js';
import { DEFAULT_SERVICE_URL_HOSTS, type ServiceUrlPolicy } from './serviceUrl.js';
import { createSdkPorts, createTeamsApp, registerInboundHandlers, type TeamsAppOptions } from './teamsApp.js';
import { SdkTeamsSender, type TeamsSender } from './teamsSender.js';

export type ServiceOverrides = {
  idempotency?: IdempotencyStore;
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
  idempotency: IdempotencyStore;
  stop(): Promise<void>;
};

export async function startService(config: Config, logger: Logger, overrides: ServiceOverrides = {}): Promise<RunningService> {
  const policy: ServiceUrlPolicy = overrides.serviceUrlPolicy ?? {
    allowedHosts: [...DEFAULT_SERVICE_URL_HOSTS, ...config.extraServiceUrlHosts],
  };
  const idempotency = overrides.idempotency ?? new InMemoryIdempotencyStore();

  const { app, express } = createTeamsApp({ config, logger, testOverrides: overrides.testOverrides, requestTimeoutMs: overrides.teamsTimeoutMs });
  let draining = false;
  const sendService = new SendService({
    token: config.sendServiceToken,
    idempotency,
    serviceUrlPolicy: policy,
    sender: overrides.sender ?? new SdkTeamsSender(app, policy),
    logger,
    deadlineMs: overrides.sendDeadlineMs,
    isDraining: () => draining,
  });
  const inbound = new InboundService({
    gertrude: overrides.gertrude ?? new HttpGertrudeClient(config.gertrudeUrl, config.gertrudeVerifyToken),
    ports: overrides.ports ?? createSdkPorts(app),
    logger,
    serviceUrlPolicy: policy,
  });

  mountRoutes(express, { sendService, sendToken: config.sendServiceToken, logger });
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

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      draining = true;
      // Stop accepting; idle keep-alive sockets go now, busy ones finish their request.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const drained = await sendService.drain(overrides.drainTimeoutMs ?? 10_000);
      if (!drained) logger.warn('shutdown_inflight_abandoned', { count: sendService.inFlightCount });
      // Let responses for just-finished sends flush before cutting the remaining sockets.
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
      server.closeAllConnections();
      await closed;
    })());

  logger.info('service_started', { port });
  return { port, server, app, sendService, idempotency, stop };
}
