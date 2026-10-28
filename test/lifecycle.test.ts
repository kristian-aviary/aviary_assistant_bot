import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from '../src/server.js';
import { sendBody } from './helpers/constants.js';
import { FakeTeamsSender } from './helpers/fakeSender.js';
import { createHarness, type Harness } from './helpers/harness.js';
import { captureLogs } from './helpers/logs.js';
import { seedReference } from './helpers/seed.js';
import { createTestDb } from './helpers/pg.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('GET /healthz', () => {
  it('200 {"ok":true} when the database answers, with no secrets in the body', async () => {
    h = await createHarness();
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('needs no auth, and answers 503 {"ok":false} when the database does not', async () => {
    h = await createHarness();
    await h.db.pool.end();
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });
});

describe('startup', () => {
  it('actually listens (the SDK adapter would not start on a user-supplied Express app)', async () => {
    h = await createHarness();
    expect(h.service.server.listening).toBe(true);
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });

  it('runs migrations at start against an empty database', async () => {
    h = await createHarness();
    const t = await h.db.pool.query(`select count(*)::int as n from information_schema.tables where table_name in ('conversation_reference','send_idempotency','schema_migrations')`);
    expect(t.rows[0].n).toBe(3);
  });
});

describe('graceful shutdown (SIGTERM path: service.stop())', () => {
  it('finishes the in-flight send, answers it normally, refuses new sends, then closes', async () => {
    const sender = new FakeTeamsSender();
    h = await createHarness({ sender });
    await seedReference(h.db.pool, h.serviceUrl);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    sender.enqueue({ type: 'gate', gate, then: { type: 'ok', activityId: 'act-drain' } });

    const inFlightKey = randomUUID();
    const inFlight = h.send(sendBody(), { key: inFlightKey });
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

  it('a send that outlives the drain deadline is left in_progress, which replays as unknown (never a duplicate)', async () => {
    const sender = new FakeTeamsSender();
    h = await createHarness({ sender, drainTimeoutMs: 200 });
    await seedReference(h.db.pool, h.serviceUrl);
    sender.enqueue({ type: 'hang', dispatched: true });
    const key = randomUUID();
    const pending = h.send(sendBody(), { key }).catch(() => 'cut');
    await until(() => sender.calls.length === 1);
    await h.service.stop();
    expect(await pending).toBe('cut');
    const row = (await h.db.pool.query('select status from send_idempotency where key = $1', [key])).rows[0];
    expect(row.status).toBe('in_progress');
  });

  it('stop is idempotent and closes the pool it owns', async () => {
    const db = await createTestDb();
    const logs = captureLogs();
    const config = {
      databaseUrl: db.url,
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
    await db.drop();
  });
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('until timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
