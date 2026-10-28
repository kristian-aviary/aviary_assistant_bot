import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SENSITIVE, sendBody } from './helpers/constants.js';
import { activity, createHarness, type Harness } from './helpers/harness.js';
import { expectCleanLogs } from './helpers/logs.js';
import { seedReference } from './helpers/seed.js';

let h: Harness;
const written: string[] = [];
const spies: ReturnType<typeof vi.spyOn>[] = [];

beforeAll(async () => {
  h = await createHarness({ gertrudeTimeoutMs: 300, teamsTimeoutMs: 300 });
  const capture = (chunk: unknown) => {
    written.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  spies.push(vi.spyOn(process.stdout, 'write').mockImplementation(capture as never));
  spies.push(vi.spyOn(process.stderr, 'write').mockImplementation(capture as never));
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    spies.push(vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void written.push(args.map(String).join(' '))));
  }
});
afterEach(() => undefined);
afterAll(async () => {
  spies.forEach((s) => s.mockRestore());
  await h.stop();
});

describe('nothing the SDK or its dependencies print can leak', () => {
  it('runs the failure paths (bad token, bad JWT, roster failure, Teams errors, Gertrude timeout) and prints nothing sensitive', async () => {
    process.stdout.write('PROBE');
    expect(written.join('')).toContain('PROBE');
    written.length = 0;
    await h.postActivity(activity({ serviceUrl: h.serviceUrl }));
    await h.postActivity(activity({ serviceUrl: h.serviceUrl }), 'garbage');
    await h.postActivity(activity({ serviceUrl: h.serviceUrl }), await h.idp.signToken({ serviceurl: 'https://other.example.com' }));
    h.connector.memberStatus = 500;
    await h.signedActivityPost(activity({ serviceUrl: h.serviceUrl }));
    h.connector.memberStatus = 200;
    h.gertrude.behavior = { type: 'timeout' };
    await h.signedActivityPost(activity({ serviceUrl: h.serviceUrl }));
    h.gertrude.behavior = { type: 'ok' };
    await h.signedActivityPost(activity({ serviceUrl: h.serviceUrl }));
    await seedReference(h.db.pool, h.serviceUrl).catch(() => undefined);
    for (const behavior of [
      { type: 'status', status: 403 },
      { type: 'status', status: 429 },
      { type: 'status', status: 500 },
      { type: 'reset' },
      { type: 'hang' },
      { type: 'ok' },
    ] as const) {
      h.connector.activityBehavior = behavior;
      await h.send(sendBody());
    }

    const output = written.join('');
    expectCleanLogs(output.split('\n').filter(Boolean));
    for (const needle of SENSITIVE) expect(output.includes(needle)).toBe(false);
  });

  it('prints nothing at all through stdout, stderr or console (our logger writes to its own sink in tests)', () => {
    expect(written.join('')).toBe('');
  });
});
