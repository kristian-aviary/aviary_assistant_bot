import { describe, expect, it } from 'vitest';
import { DEFAULT_SERVICE_URL_HOSTS, normalizeServiceUrl } from '../src/serviceUrl.js';

const policy = { allowedHosts: DEFAULT_SERVICE_URL_HOSTS };

describe('normalizeServiceUrl', () => {
  it.each([
    ['https://smba.trafficmanager.net/emea/', 'https://smba.trafficmanager.net/emea'],
    ['https://smba.trafficmanager.net/teams', 'https://smba.trafficmanager.net/teams'],
    ['https://SMBA.TrafficManager.net/amer///', 'https://smba.trafficmanager.net/amer'],
    ['https://smba.trafficmanager.net/', 'https://smba.trafficmanager.net'],
  ])('accepts and canonicalises %s', (input, expected) => {
    expect(normalizeServiceUrl(input, policy)).toBe(expected);
  });

  it.each([
    ['http scheme', 'http://smba.trafficmanager.net/emea/'],
    ['other host', 'https://evil.example.com/emea/'],
    ['suffix trick', 'https://smba.trafficmanager.net.evil.com/emea/'],
    ['userinfo trick', 'https://smba.trafficmanager.net@evil.com/emea/'],
    ['credentials', 'https://user:pw@smba.trafficmanager.net/emea/'],
    ['explicit port', 'https://smba.trafficmanager.net:8443/emea/'],
    ['query string', 'https://smba.trafficmanager.net/emea/?x=1'],
    ['fragment', 'https://smba.trafficmanager.net/emea/#x'],
    ['not a URL', 'not a url'],
    ['empty', ''],
    ['loopback http without the test flag', 'http://127.0.0.1:3000/emea/'],
    ['file scheme', 'file:///etc/passwd'],
  ])('rejects %s', (_name, input) => {
    expect(normalizeServiceUrl(input, policy)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(normalizeServiceUrl(undefined, policy)).toBeNull();
    expect(normalizeServiceUrl(42, policy)).toBeNull();
  });

  it('extra hosts from config are honoured', () => {
    expect(normalizeServiceUrl('https://smba.infra.gcc.teams.microsoft.com/teams/', { allowedHosts: ['smba.infra.gcc.teams.microsoft.com'] })).toBe(
      'https://smba.infra.gcc.teams.microsoft.com/teams',
    );
  });

  it('loopback http is only allowed when the test flag is set', () => {
    expect(normalizeServiceUrl('http://127.0.0.1:3000/emea/', { ...policy, allowLoopbackHttp: true })).toBe('http://127.0.0.1:3000/emea');
    expect(normalizeServiceUrl('http://evil.example.com/emea/', { ...policy, allowLoopbackHttp: true })).toBeNull();
  });
});
