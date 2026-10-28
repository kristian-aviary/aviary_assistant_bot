export const SEND_TOKEN = 'send-token-AAAAAAAAAAAAAAAAAAAAAAAA';
export const VERIFY_TOKEN = 'verify-token-BBBBBBBBBBBBBBBBBBBBBB';
export const CLIENT_ID = '11111111-2222-4333-8444-555555555555';
export const CLIENT_SECRET = 'client-secret-CCCCCCCCCCCCCCCCCCCC';
export const BOT_TENANT_ID = '99999999-8888-4777-8666-555555555555';
export const USER_TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const USER_AAD_ID = 'f0f0f0f0-1111-4222-8333-444444444444';
export const USER_EMAIL = 'someone@example.com';
export const TEAMS_USER_ID = '29:1-teams-user-id-opaque';
export const CONVERSATION_ID = 'a:1-conversation-id-opaque';
export const CARD_TEXT = 'SECRET-CARD-TEXT-quarterly-numbers';
export const FALLBACK_TEXT = 'SECRET-FALLBACK-TEXT-quarterly-numbers';

/** Substrings that must never appear in any log line. */
export const SENSITIVE = [
  SEND_TOKEN,
  VERIFY_TOKEN,
  CLIENT_SECRET,
  CLIENT_ID,
  BOT_TENANT_ID,
  USER_TENANT_ID,
  USER_AAD_ID,
  USER_EMAIL,
  'someone',
  TEAMS_USER_ID,
  CONVERSATION_ID,
  CARD_TEXT,
  FALLBACK_TEXT,
  '127.0.0.1',
  'smba.trafficmanager.net',
  'Bearer',
  // markers of the reference object (it must never be logged)
  'conversationType',
  'aadObjectId',
  'msteams',
];

export function sampleCard(extra: Record<string, unknown> = {}) {
  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [{ type: 'TextBlock', text: CARD_TEXT }],
    actions: [],
    ...extra,
  };
}

export const ALLOWED_SERVICE_URL = 'https://smba.trafficmanager.net/emea/';

export function sendBody(overrides: Record<string, unknown> = {}) {
  return { conversation_id: CONVERSATION_ID, service_url: ALLOWED_SERVICE_URL, card: sampleCard(), fallback_text: FALLBACK_TEXT, ...overrides };
}
