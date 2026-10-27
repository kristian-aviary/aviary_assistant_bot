import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const valid = {
  DATABASE_URL: 'postgres://user:db-password-VALUE-xyz@host:5432/db',
  GERTRUDE_URL: 'https://gertrude.example.com/',
  GERTRUDE_VERIFY_TOKEN: 'verify-token-VALUE-xyz',
  SEND_SERVICE_TOKEN: 'send-token-VALUE-xyz',
  CLIENT_ID: 'client-id-VALUE-xyz',
  CLIENT_SECRET: 'client-secret-VALUE-xyz',
  TENANT_ID: 'tenant-id-VALUE-xyz',
  PORT: '8080',
};

function fail(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('parses a complete environment', () => {
    const c = loadConfig(valid);
    expect(c).toMatchObject({ port: 8080, gertrudeUrl: 'https://gertrude.example.com', clientId: 'client-id-VALUE-xyz' });
    expect(c.extraServiceUrlHosts).toEqual([]);
  });

  it('PORT defaults to 3978', () => {
    expect(loadConfig({ ...valid, PORT: undefined }).port).toBe(3978);
  });

  it('reads optional extra service URL hosts', () => {
    expect(loadConfig({ ...valid, SERVICE_URL_ALLOWED_HOSTS: ' A.example.com, ,b.example.com ' }).extraServiceUrlHosts).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
  });

  it.each(['DATABASE_URL', 'GERTRUDE_URL', 'GERTRUDE_VERIFY_TOKEN', 'SEND_SERVICE_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'TENANT_ID'])(
    'a missing %s is named, and no value appears in the message',
    (name) => {
      const env: Record<string, string | undefined> = { ...valid };
      delete env[name];
      const err = fail(env);
      expect(err.message).toContain(name);
      expect(err.variables).toEqual([name]);
      expect(err.message).not.toContain('VALUE-xyz');
    },
  );

  it('treats blank values as missing', () => {
    const err = fail({ ...valid, CLIENT_SECRET: '   ' });
    expect(err.message).toContain('missing CLIENT_SECRET');
  });

  it('reports every problem at once', () => {
    const err = fail({});
    for (const n of ['DATABASE_URL', 'GERTRUDE_URL', 'GERTRUDE_VERIFY_TOKEN', 'SEND_SERVICE_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'TENANT_ID']) {
      expect(err.variables).toContain(n);
    }
  });

  it('an invalid value names the variable but not the value', () => {
    const err = fail({ ...valid, GERTRUDE_URL: 'ftp://leaky-secret-host', PORT: 'abc-VALUE-xyz' });
    expect(err.message).toContain('GERTRUDE_URL');
    expect(err.message).toContain('PORT');
    expect(err.message).not.toContain('leaky-secret-host');
    expect(err.message).not.toContain('abc-VALUE-xyz');
  });

  it('rejects an out-of-range PORT', () => {
    expect(fail({ ...valid, PORT: '70000' }).variables).toEqual(['PORT']);
    expect(fail({ ...valid, PORT: '0' }).variables).toEqual(['PORT']);
  });

  it('refuses the same value for both service tokens (one token per direction) without printing it', () => {
    const err = fail({ ...valid, SEND_SERVICE_TOKEN: 'same-VALUE-xyz', GERTRUDE_VERIFY_TOKEN: 'same-VALUE-xyz' });
    expect(err.variables).toEqual(['SEND_SERVICE_TOKEN', 'GERTRUDE_VERIFY_TOKEN']);
    expect(err.message).not.toContain('same-VALUE-xyz');
  });
});
