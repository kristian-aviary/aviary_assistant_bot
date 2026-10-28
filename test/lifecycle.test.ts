import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from '../src/server.js';
import { FakeTeamsSender } from './helpers/fakeSender.js';
import { createHarness, type Harness } from './helpers/harness.js';
import { captureLogs } from './helpers/logs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('GET /healthz', () => {
  it('200 {"ok":true} with no secrets in the body, and no dependency anywhere to check', async () => {
    h = await createHarness();
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('needs no auth, and keeps answering 200 while Gertrude and Teams are down (it is liveness, not readiness)', async () => {
    h = await createHarness();
    await h.gertrude.close();
    await h.connector.close();
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('www-authenticate')).toBeNull();
  });
});

describe('startup', () => {
  it('actually listens (the SDK adapter would not start on a user-supplied Express app)', async () => {
    h = await createHarness();
    expect(h.service.server.listening).toBe(true);
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });

  it('starts with no database anywhere: the only state is the in-memory idempotency store', async () => {
    h = await createHarness();
    expect(h.idempotency.size).toBe(0);
    expect(h.service.idempotency).toBe(h.idempotency);
    expect((await h.send()).status).toBe(200);
    expect(h.idempotency.size).toBe(1);
  });
});

describe('graceful shutdown (SIGTERM path: service.stop())', () => {
  it('finishes the in-flight send, answers it normally, refuses new sends, then closes', async () => {
    const sender = new FakeTeamsSender();
    h = await createHarness({ sender });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    sender.enqueue({ type: 'gate', gate, then: { type: 'ok', activityId: 'act-drain' } });

    const inFlightKey = randomUUID();
    const inFlight = h.send(h.body(), { key: inFlightKey });
    await until(() => sender.calls.length === 1);

    const stopping = h.service.stop();
    await until(() => !h!.service.server.listening);
    expect(h.service.sendService.inFlightCount).toBe(1);

    await expect(h.send()).rejects.toThrow();

    let stopped = false;
    void stopping.then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 150));
    expect(stopped).toBe(false);

    release();
    const result = await inFlight;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'sent', activity_id: 'act-drain' });
    await stopping;
    expect(h.service.sendService.inFlightCount).toBe(0);
  });

  it('a send that outlives the drain deadline is left in_progress, which would replay as unknown (never a duplicate)', async () => {
    const sender = new FakeTeamsSender();
    h = await createHarness({ sender, drainTimeoutMs: 200 });
    sender.enqueue({ type: 'hang', dispatched: true });
    const key = randomUUID();
    const pending = h.send(h.body(), { key }).catch(() => 'cut');
    await until(() => sender.calls.length === 1);
    await h.service.stop();
    expect(await pending).toBe('cut');
    expect(h.idempotency.find(key)?.status).toBe('in_progress');
  });

  it('stop is idempotent', async () => {
    const logs = captureLogs();
    const config = {
      gertrudeUrl: 'http://127.0.0.1:9',
      gertrudeVerifyToken: 'v'.repeat(20),
      sendServiceToken: 's'.repeat(20),
      clientId: '11111111-2222-4333-8444-555555555555',
      clientSecret: 'x',
      tenantId: '99999999-8888-4777-8666-555555555555',
      port: 0,
      extraServiceUrlHosts: [],
    };
    const svc = await startService(config, logs.logger, { listenPort: 0 });
    await Promise.all([svc.stop(), svc.stop()]);
    expect(svc.server.listening).toBe(false);
    expect(logs.lines.some((l) => l.includes('service_started'))).toBe(true);
  });
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('until timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
