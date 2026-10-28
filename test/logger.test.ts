import { describe, expect, it } from 'vitest';
import { createLogger, createSdkLogger } from '../src/logger.js';
import { CARD_TEXT, SENSITIVE, USER_AAD_ID, USER_EMAIL } from './helpers/constants.js';
import { expectCleanLogs } from './helpers/logs.js';

// Shaped like a user id with pipes; the logger must refuse it whatever it is called.
const USER_ID = 'samlp|aviary|someone@example.com';

describe('logger allowlist', () => {
  const make = () => {
    const lines: string[] = [];
    return { lines, log: createLogger((l) => lines.push(l)) };
  };

  it('writes one JSON object per line with level and event', () => {
    const { lines, log } = make();
    log.info('send_sent', { delivery_id: '3f1c9a54-2c0e-4a53-9c43-2a1c1a2b3c4d', status: 'sent' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', event: 'send_sent', status: 'sent', delivery_id: '3f1c9a54-2c0e-4a53-9c43-2a1c1a2b3c4d' });
  });

  it('drops fields that are not on the allowlist even if a caller passes them', () => {
    const { lines, log } = make();
    log.error('x', { email: USER_EMAIL, user_id: USER_ID, card: CARD_TEXT, token: 'abc', code: 'OK_CODE' } as never);
    const rec = JSON.parse(lines[0]!);
    expect(Object.keys(rec).sort()).toEqual(['code', 'event', 'level', 'ts']);
  });

  it.each([USER_EMAIL, USER_ID, USER_AAD_ID + ' x', 'https://smba.trafficmanager.net/emea', 'Bearer abc', CARD_TEXT + ' with spaces', 'a'.repeat(65)])(
    'an allowed field whose value is not an identifier or status word is redacted: %s',
    (value) => {
      const { lines, log } = make();
      log.warn('x', { reason: value });
      expect(JSON.parse(lines[0]!).reason).toBe('redacted');
      expectCleanLogs(lines);
    },
  );

  it('an unsafe event name is replaced', () => {
    const { lines, log } = make();
    log.info(USER_EMAIL);
    expect(JSON.parse(lines[0]!).event).toBe('invalid_event_name');
  });

  it('the SDK logger adapter keeps no message and no arguments', () => {
    const { lines, log } = make();
    const sdk = createSdkLogger(log);
    sdk.debug('Handling activity', { from: USER_EMAIL });
    sdk.info('listening');
    sdk.warn('JWT validation failed', new Error(`Service URL mismatch. Token: https://x`));
    sdk.error('axios failed', { config: { headers: { Authorization: 'Bearer eyJ' } } });
    sdk.log('error', USER_ID);
    sdk.child('sub').error(CARD_TEXT);
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(JSON.parse(l).event).toBe('sdk_log');
    for (const needle of SENSITIVE) for (const l of lines) expect(l).not.toContain(needle);
  });
});
