/**
 * Maps a failure from the Teams / Bot Connector call to a contract outcome.
 * The rule that drives every row: the key may only be released (so Gertrude can
 * retry and Teams might receive a second copy) when the request provably was not
 * accepted. Anything that could have been accepted is `unknown`.
 */
export type TeamsFailure =
  | { kind: 'blocked'; code: string }
  | { kind: 'rejected'; code: string }
  | { kind: 'rate_limited'; code: string; retryAfterSeconds?: number }
  | { kind: 'unavailable'; code: string }
  | { kind: 'unknown'; code: string };

type AxiosLike = {
  isAxiosError?: boolean;
  code?: string;
  response?: { status?: number; headers?: Record<string, unknown> };
};

/** Errors raised before any byte of the request reaches Teams: DNS, refused connect, TLS handshake. */
const NOT_WRITTEN_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ERR_INVALID_URL',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export class PreDispatchError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PreDispatchError';
  }
}

export function classifyTeamsError(err: unknown, dispatched: boolean): TeamsFailure {
  if (err instanceof PreDispatchError) return { kind: 'unavailable', code: err.code };

  const e = (typeof err === 'object' && err !== null ? err : {}) as AxiosLike;
  const status = e.response?.status;

  if (typeof status === 'number') {
    if (status === 403 || status === 404) return { kind: 'blocked', code: `teams_${status}` };
    if (status === 429) {
      return { kind: 'rate_limited', code: 'teams_429', retryAfterSeconds: parseRetryAfter(e.response?.headers?.['retry-after']) };
    }
    if (status === 503) return { kind: 'unavailable', code: 'teams_503' };
    if (status === 401) return { kind: 'unavailable', code: 'teams_401_credentials' };
    if (status === 408) return { kind: 'unknown', code: 'teams_408' };
    if (status >= 400 && status < 500) return { kind: 'rejected', code: `teams_${status}` };
    return { kind: 'unknown', code: `teams_${status}` };
  }

  const code = typeof e.code === 'string' ? e.code : undefined;
  if (e.isAxiosError === true || code !== undefined) {
    if (code !== undefined && NOT_WRITTEN_CODES.has(code)) return { kind: 'unavailable', code: `net_${code.toLowerCase()}` };
    return { kind: 'unknown', code: code ? `net_${code.toLowerCase()}` : 'net_error' };
  }

  // Not an HTTP error: token acquisition or other local failure. Before the
  // transport was reached nothing was written; after, we cannot tell.
  return dispatched ? { kind: 'unknown', code: 'local_error_after_dispatch' } : { kind: 'unavailable', code: 'local_error_before_dispatch' };
}

function parseRetryAfter(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 3600 ? Math.ceil(n) : undefined;
}
