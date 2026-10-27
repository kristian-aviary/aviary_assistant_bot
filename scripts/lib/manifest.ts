/**
 * Teams app manifest for the Aviary Assistant bot.
 *
 * Deliberately minimal, and different from the internal Crow bot on purpose:
 *  - personal scope only (no team, no groupChat);
 *  - no webApplicationInfo, no resource-specific consent, no ChannelMessage.Read.Group:
 *    this bot reads nothing from Teams beyond its own 1:1 chat;
 *  - no `permissions` block (device permissions are not needed to message a user);
 *  - validDomains is empty: it has no tabs, no web content, no SSO;
 *  - the app id is ours (below), not Crow's.
 */
export const MANIFEST_VERSION = '1.30';
export const MANIFEST_SCHEMA_URL = `https://developer.microsoft.com/json-schemas/teams/v${MANIFEST_VERSION}/MicrosoftTeams.schema.json`;

/** Fresh identifier of this Teams app. Not the bot's Entra app id (that is botId). Never reuse Crow's. */
export const TEAMS_APP_ID = '43d89c2d-145f-480a-bea7-39566082fb4e';

export type ManifestInput = {
  /** The Entra app (client) id of the bot registration: the CLIENT_ID the service runs with. */
  botId: string;
  /** Semver of the app package. Bump it for every manifest or icon change that is re-uploaded. */
  appVersion?: string;
  developerName?: string;
  websiteUrl?: string;
  privacyUrl?: string;
  termsOfUseUrl?: string;
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildManifest(input: ManifestInput): Record<string, unknown> {
  if (!GUID.test(input.botId)) throw new Error('botId must be a GUID (the CLIENT_ID of the bot registration)');
  return {
    $schema: MANIFEST_SCHEMA_URL,
    manifestVersion: MANIFEST_VERSION,
    version: input.appVersion ?? '0.1.0',
    id: TEAMS_APP_ID,
    developer: {
      name: input.developerName ?? 'Aviary',
      websiteUrl: input.websiteUrl ?? 'https://example.com/aviary',
      privacyUrl: input.privacyUrl ?? 'https://example.com/aviary/privacy',
      termsOfUseUrl: input.termsOfUseUrl ?? 'https://example.com/aviary/terms',
    },
    name: { short: 'Aviary Assistant', full: 'Aviary Assistant' },
    description: {
      short: 'Delivers your Aviary Assistant reports in Teams.',
      full: 'Aviary Assistant delivers your hypercare reports to you in Microsoft Teams. It sends you reports; it does not answer questions or read your other chats.',
    },
    icons: { outline: 'outline.png', color: 'color.png' },
    accentColor: '#1F6F8B',
    bots: [
      {
        botId: input.botId,
        scopes: ['personal'],
        supportsFiles: false,
        isNotificationOnly: false,
      },
    ],
    validDomains: [],
  };
}
