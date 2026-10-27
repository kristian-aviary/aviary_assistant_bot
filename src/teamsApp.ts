import { App, ExpressAdapter } from '@microsoft/teams.apps';
import type { CloudEnvironment } from '@microsoft/teams.api';
import express, { type Express } from 'express';
import type { Config } from './config.js';
import { InboundService, type InboundEvent, type InboundPorts, type RosterMember } from './inbound.js';
import { createSdkLogger, type Logger } from './logger.js';

export const TEAMS_REQUEST_TIMEOUT_MS = 8000;

export type TeamsAppOptions = {
  config: Pick<Config, 'clientId' | 'clientSecret' | 'tenantId'>;
  logger: Logger;
  express?: Express;
  requestTimeoutMs?: number;
  /** Tests only: point JWKS and the token issuer at a local fake and bypass MSAL with a static token. */
  testOverrides?: { cloud: CloudEnvironment; token: () => string };
};

export type TeamsApp = { app: App; express: Express };

/**
 * Builds the SDK app with its own inbound token validation switched ON.
 * `dangerouslyAllowUnauthenticatedRequests` and `skipAuth` are never set.
 */
export function createTeamsApp(opts: TeamsAppOptions): TeamsApp {
  const sdkLogger = createSdkLogger(opts.logger);
  const expressApp = opts.express ?? express();
  const adapter = new ExpressAdapter(expressApp, { logger: sdkLogger, onError: () => opts.logger.error('http_server_error', { code: 'SERVER' }) });
  const common = {
    logger: sdkLogger,
    httpServerAdapter: adapter,
    client: { timeout: opts.requestTimeoutMs ?? TEAMS_REQUEST_TIMEOUT_MS, logger: sdkLogger },
    messagingEndpoint: '/api/messages' as const,
  };
  const app = opts.testOverrides
    ? new App({
        ...common,
        clientId: opts.config.clientId,
        tenantId: opts.config.tenantId,
        token: opts.testOverrides.token,
        cloud: opts.testOverrides.cloud,
      })
    : new App({
        ...common,
        clientId: opts.config.clientId,
        clientSecret: opts.config.clientSecret,
        tenantId: opts.config.tenantId,
      });
  return { app, express: expressApp };
}

/** Roster lookup and replies through the SDK API client, pinned to a validated service URL. */
export function createSdkPorts(app: App): InboundPorts {
  return {
    async getRosterMember(serviceUrl, conversationId, memberId): Promise<RosterMember> {
      const api = app.api.clone({ serviceUrl });
      const m = await api.conversations.getMemberById(conversationId, memberId);
      return { aadObjectId: m.aadObjectId, email: m.email, tenantId: m.tenantId };
    },
    async reply(serviceUrl, conversationId, text) {
      const appId = app.id;
      if (!appId) return;
      const api = app.api.clone({ serviceUrl });
      await api.conversations.createActivity(conversationId, {
        type: 'message',
        text,
        from: { id: appId, role: 'bot' },
        conversation: { id: conversationId },
      } as never);
    },
  };
}

type RawActivity = {
  channelId?: string;
  serviceUrl?: string;
  from?: { id?: string; aadObjectId?: string };
  recipient?: { id?: string };
  conversation?: { id?: string; conversationType?: string; isGroup?: boolean; tenantId?: string };
  channelData?: { tenant?: { id?: string } };
};

export function toInboundEvent(kind: InboundEvent['kind'], activity: unknown): InboundEvent | null {
  const a = activity as RawActivity;
  if (!a.conversation?.id || !a.from?.id || !a.serviceUrl) return null;
  return {
    kind,
    channelId: a.channelId,
    conversationId: a.conversation.id,
    conversationType: a.conversation.conversationType,
    isGroup: a.conversation.isGroup,
    conversationTenantId: a.conversation.tenantId,
    channelDataTenantId: a.channelData?.tenant?.id,
    fromId: a.from.id,
    fromAadObjectId: a.from.aadObjectId,
    botId: a.recipient?.id,
    serviceUrl: a.serviceUrl,
  };
}

/** Registers the three handlers. Handlers never throw into the SDK. */
export function registerInboundHandlers(app: App, inbound: InboundService, logger: Logger): void {
  const run = (kind: InboundEvent['kind']) => async (ctx: { activity: unknown }) => {
    const ev = toInboundEvent(kind, ctx.activity);
    if (!ev) {
      logger.warn('inbound_refused', { code: 'MALFORMED_ACTIVITY' });
      return;
    }
    try {
      await inbound.handle(ev);
    } catch {
      logger.error('inbound_error', { code: 'INTERNAL' });
    }
  };
  app.on('install.add', run('install_add'));
  app.on('install.remove', run('install_remove'));
  app.on('message', run('message'));
}
