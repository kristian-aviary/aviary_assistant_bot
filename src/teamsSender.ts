import type { App } from '@microsoft/teams.apps';
import { toActivityParams } from '@microsoft/teams.api';
import { normalizeServiceUrl, type ServiceUrlPolicy } from './serviceUrl.js';
import { PreDispatchError } from './teamsErrors.js';

export type TeamsTarget = { conversationId: string; serviceUrl: string };
export type TeamsMessage = { text: string; card: Record<string, unknown> };
export type SendHooks = {
  /** Called when the request is handed to the HTTP transport (after the bot token was acquired). */
  onDispatched(): void;
};

export interface TeamsSender {
  send(target: TeamsTarget, message: TeamsMessage, hooks: SendHooks): Promise<{ activityId: string | null }>;
}

export const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

/**
 * Proactive send through the SDK's own API client. `app.send()` always uses the
 * app-wide default service URL, so this clones the client onto the stored
 * (re-validated) service URL instead; token acquisition, headers and the
 * connector call are still the SDK's.
 */
export class SdkTeamsSender implements TeamsSender {
  constructor(
    private readonly app: App,
    private readonly policy: ServiceUrlPolicy,
  ) {}

  async send(target: TeamsTarget, message: TeamsMessage, hooks: SendHooks): Promise<{ activityId: string | null }> {
    const appId = this.app.id;
    if (!appId) throw new PreDispatchError('no_credentials');
    const serviceUrl = normalizeServiceUrl(target.serviceUrl, this.policy);
    if (!serviceUrl) throw new PreDispatchError('service_url_rejected');

    const api = this.app.api.clone({ serviceUrl });
    api.http.use({
      request: (ctx) => {
        hooks.onDispatched();
        return ctx.config;
      },
    });

    const params = toActivityParams({
      type: 'message',
      text: message.text,
      attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, content: message.card }],
    } as never);
    const res = await api.conversations.createActivity(target.conversationId, {
      ...params,
      from: { id: appId, role: 'bot' },
      conversation: { id: target.conversationId },
    } as never);
    const id = (res as { id?: unknown } | undefined)?.id;
    return { activityId: typeof id === 'string' && id.length > 0 ? id : null };
  }
}
