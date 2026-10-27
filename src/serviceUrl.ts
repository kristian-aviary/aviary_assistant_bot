/**
 * The Bot Framework service URL is where the bot's access token is sent when we
 * message a user. It is stored from an inbound activity, so it is validated both
 * when stored and again right before every send.
 */
export const DEFAULT_SERVICE_URL_HOSTS: readonly string[] = ['smba.trafficmanager.net'];

export type ServiceUrlPolicy = {
  allowedHosts: readonly string[];
  /** Tests only: lets the fake connector on 127.0.0.1 through. Never set from env. */
  allowLoopbackHttp?: boolean;
};

export function normalizeServiceUrl(raw: unknown, policy: ServiceUrlPolicy): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  const loopback = policy.allowLoopbackHttp === true && url.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost');
  if (!loopback) {
    if (url.protocol !== 'https:') return null;
    if (url.port !== '') return null;
    if (!policy.allowedHosts.includes(host)) return null;
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}
