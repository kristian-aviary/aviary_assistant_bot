import type { GertrudeClient, LinkResult } from './gertrude.js';
import type { Logger } from './logger.js';
import { normalizeServiceUrl, type ServiceUrlPolicy } from './serviceUrl.js';

export const MESSAGES = {
  linked: 'You will receive Aviary Assistant reports here.',
  notSetUp: 'This account is not set up to receive Aviary Assistant reports. Please contact your Aviary administrator.',
  temporary: 'Aviary Assistant could not complete setup right now. Please try again later.',
  personalOnly: 'This bot only works in a personal chat.',
} as const;

export type InboundKind = 'install_add' | 'message' | 'install_remove';

/** What the SDK glue extracts from an authenticated activity. Nothing else is trusted or kept. */
export type InboundEvent = {
  kind: InboundKind;
  channelId?: string;
  conversationId: string;
  conversationType?: string;
  isGroup?: boolean;
  conversationTenantId?: string;
  channelDataTenantId?: string;
  fromId: string;
  fromAadObjectId?: string;
  botId?: string;
  serviceUrl: string;
};

export type RosterMember = { aadObjectId?: string; email?: string; tenantId?: string };

export interface InboundPorts {
  getRosterMember(serviceUrl: string, conversationId: string, memberId: string): Promise<RosterMember>;
  reply(serviceUrl: string, conversationId: string, text: string): Promise<void>;
}

export type InboundOutcome =
  | 'linked'
  | 'refreshed'
  | 'not_set_up'
  | 'temporary_failure'
  | 'not_personal'
  | 'removed'
  | 'ignored';

export class InboundService {
  constructor(
    private readonly deps: {
      gertrude: GertrudeClient;
      ports: InboundPorts;
      logger: Logger;
      serviceUrlPolicy: ServiceUrlPolicy;
    },
  ) {}

  async handle(ev: InboundEvent): Promise<InboundOutcome> {
    const serviceUrl = normalizeServiceUrl(ev.serviceUrl, this.deps.serviceUrlPolicy);
    const isPersonal = ev.conversationType === 'personal' && ev.isGroup !== true;

    if (ev.kind === 'install_remove') return this.remove(ev, isPersonal);

    if (!serviceUrl) {
      this.deps.logger.error('inbound_refused', { code: 'SERVICE_URL_REJECTED' });
      return 'not_set_up';
    }

    if (!isPersonal) {
      this.deps.logger.info('inbound_refused', { code: 'NOT_PERSONAL_SCOPE' });
      await this.say(serviceUrl, ev.conversationId, MESSAGES.personalOnly);
      return 'not_personal';
    }

    const outcome = await this.link(ev, serviceUrl);
    const text =
      outcome === 'linked' || outcome === 'refreshed'
        ? MESSAGES.linked
        : outcome === 'temporary_failure'
          ? MESSAGES.temporary
          : MESSAGES.notSetUp;
    await this.say(serviceUrl, ev.conversationId, text);
    return outcome;
  }

  /** Best effort: the result class is logged, nothing is retried, and nothing escapes this method. */
  private async remove(ev: InboundEvent, isPersonal: boolean): Promise<InboundOutcome> {
    const tenantId = (ev.conversationTenantId ?? ev.channelDataTenantId)?.toLowerCase();
    const aadObjectId = ev.fromAadObjectId?.toLowerCase();
    if (!isPersonal || !tenantId || !aadObjectId) return 'ignored';
    try {
      const res = await this.deps.gertrude.removeReference({ tenantId, aadObjectId });
      switch (res.kind) {
        case 'removed':
          this.deps.logger.info('reference_removed', { status: res.removed ? 'removed' : 'none' });
          break;
        case 'unauthorized':
          this.deps.logger.critical('reference_remove_failed', { code: 'GERTRUDE_UNAUTHORIZED' });
          break;
        case 'bad_request':
          this.deps.logger.error('reference_remove_failed', { code: 'GERTRUDE_BAD_REQUEST' });
          break;
        case 'unavailable':
          this.deps.logger.warn('reference_remove_failed', { code: res.code });
          break;
      }
    } catch {
      this.deps.logger.warn('reference_remove_failed', { code: 'UNEXPECTED' });
    }
    return 'removed';
  }

  private async link(ev: InboundEvent, serviceUrl: string): Promise<InboundOutcome> {
    const { logger, gertrude, ports } = this.deps;

    if (ev.channelId !== undefined && ev.channelId !== 'msteams') {
      logger.warn('inbound_refused', { code: 'WRONG_CHANNEL' });
      return 'not_set_up';
    }
    const aadObjectId = ev.fromAadObjectId?.toLowerCase();
    if (!aadObjectId) {
      logger.warn('inbound_refused', { code: 'NO_AAD_OBJECT_ID' });
      return 'not_set_up';
    }
    const tenantId = (ev.conversationTenantId ?? ev.channelDataTenantId)?.toLowerCase();
    if (!tenantId || (ev.channelDataTenantId && ev.conversationTenantId && ev.channelDataTenantId.toLowerCase() !== ev.conversationTenantId.toLowerCase())) {
      logger.warn('inbound_refused', { code: 'TENANT_UNCLEAR' });
      return 'not_set_up';
    }

    let member: RosterMember;
    try {
      member = await ports.getRosterMember(serviceUrl, ev.conversationId, ev.fromId);
    } catch {
      logger.warn('inbound_refused', { code: 'ROSTER_FAILED' });
      return 'temporary_failure';
    }
    if (member.aadObjectId?.toLowerCase() !== aadObjectId) {
      logger.warn('inbound_refused', { code: 'ROSTER_MISMATCH' });
      return 'not_set_up';
    }
    if (member.tenantId && member.tenantId.toLowerCase() !== tenantId) {
      logger.warn('inbound_refused', { code: 'ROSTER_TENANT_MISMATCH' });
      return 'not_set_up';
    }
    const email = member.email?.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      logger.warn('inbound_refused', { code: 'EMAIL_UNAVAILABLE' });
      return 'not_set_up';
    }

    const reference = {
      channelId: 'msteams',
      serviceUrl,
      conversation: { id: ev.conversationId, conversationType: 'personal', tenantId },
      ...(ev.botId ? { bot: { id: ev.botId } } : {}),
      user: { id: ev.fromId, aadObjectId },
    };

    let result: LinkResult;
    try {
      result = await gertrude.linkReference({ tenantId, aadObjectId, email, conversationId: ev.conversationId, serviceUrl, reference });
    } catch {
      logger.warn('link_failed', { code: 'UNEXPECTED' });
      return 'temporary_failure';
    }
    switch (result.kind) {
      case 'created':
        logger.info('reference_stored', { status: 'created' });
        return 'linked';
      case 'refreshed':
        logger.info('reference_stored', { status: 'refreshed' });
        return 'refreshed';
      case 'not_found':
        logger.info('link_result', { status: 'not_found' });
        return 'not_set_up';
      case 'conflict':
        logger.error('link_result', { code: 'REFERENCE_CONFLICT' });
        return 'not_set_up';
      case 'unauthorized':
        logger.critical('link_failed', { code: 'GERTRUDE_UNAUTHORIZED' });
        return 'temporary_failure';
      case 'bad_request':
        logger.error('link_failed', { code: 'GERTRUDE_BAD_REQUEST' });
        return 'temporary_failure';
      case 'unavailable':
        logger.warn('link_failed', { code: result.code });
        return 'temporary_failure';
    }
  }

  private async say(serviceUrl: string, conversationId: string, text: string): Promise<void> {
    try {
      await this.deps.ports.reply(serviceUrl, conversationId, text);
    } catch {
      this.deps.logger.warn('reply_failed', { code: 'REPLY_FAILED' });
    }
  }
}
