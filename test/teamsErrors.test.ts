import { describe, expect, it } from 'vitest';
import { classifyTeamsError, PreDispatchError } from '../src/teamsErrors.js';
import { httpError, netError } from './helpers/fakeSender.js';

describe('classifyTeamsError', () => {
  it.each([
    [403, 'blocked'],
    [404, 'blocked'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
    [401, 'unavailable'],
    [400, 'rejected'],
    [413, 'rejected'],
    [409, 'rejected'],
    [408, 'unknown'],
    [500, 'unknown'],
    [502, 'unknown'],
    [504, 'unknown'],
    [507, 'unknown'],
    [302, 'unknown'],
  ])('HTTP %i -> %s', (status, kind) => {
    expect(classifyTeamsError(httpError(status), true).kind).toBe(kind);
  });

  it('Retry-After seconds are passed through when sane, dropped otherwise', () => {
    expect(classifyTeamsError(httpError(429, { 'retry-after': '12' }), true)).toMatchObject({ retryAfterSeconds: 12 });
    expect(classifyTeamsError(httpError(429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), true)).not.toHaveProperty('retryAfterSeconds', expect.any(Number));
    expect(classifyTeamsError(httpError(429, { 'retry-after': '999999' }), true)).not.toHaveProperty('retryAfterSeconds', expect.any(Number));
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT'])(
    'network error %s happened before the request was written -> unavailable (releasable)',
    (code) => {
      expect(classifyTeamsError(netError(code), true).kind).toBe('unavailable');
    },
  );

  it.each(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'ERR_CANCELED', 'ERR_BAD_RESPONSE', 'ERR_UNKNOWN_THING'])(
    'network error %s may have happened after the request was written -> unknown',
    (code) => {
      expect(classifyTeamsError(netError(code), true).kind).toBe('unknown');
    },
  );

  it('a non-HTTP error is unavailable before dispatch (token acquisition) and unknown after', () => {
    expect(classifyTeamsError(new Error('msal'), false).kind).toBe('unavailable');
    expect(classifyTeamsError(new Error('weird'), true).kind).toBe('unknown');
    expect(classifyTeamsError('a string', false).kind).toBe('unavailable');
    expect(classifyTeamsError(undefined, true).kind).toBe('unknown');
  });

  it('PreDispatchError is always unavailable', () => {
    expect(classifyTeamsError(new PreDispatchError('service_url_rejected'), true)).toEqual({ kind: 'unavailable', code: 'service_url_rejected' });
  });

  it('error codes never contain message text from the error', () => {
    const e = Object.assign(new Error('user someone@example.com card SECRET'), { isAxiosError: true, code: 'ECONNRESET' });
    expect(JSON.stringify(classifyTeamsError(e, true))).not.toMatch(/someone|SECRET/);
  });
});
