import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/pg.js';

const root = path.resolve(import.meta.dirname, '..');
let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
});

function run(env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const baseEnv: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: root, env: { ...baseEnv, ...env } });
  child.stdout!.on('data', (d: Buffer) => out.push(d.toString()));
  child.stderr!.on('data', (d: Buffer) => err.push(d.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child!.on('exit', (code, signal) => resolve({ code, signal })));
  return { out, err, exited, child: child! };
}

const waitFor = async (cond: () => boolean, ms = 15_000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for process output');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('the real process', () => {
  it('exits 1 on invalid config and names the variable but not any value', async () => {
    const p = run({ DATABASE_URL: 'postgres://u:pw-VALUE-xyz@127.0.0.1:1/db', GERTRUDE_URL: 'https://g.example.com' });
    const { code } = await p.exited;
    expect(code).toBe(1);
    const all = p.err.join('') + p.out.join('');
    for (const v of ['GERTRUDE_VERIFY_TOKEN', 'SEND_SERVICE_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'TENANT_ID']) expect(all).toContain(v);
    expect(all).not.toContain('pw-VALUE-xyz');
  });

  it('starts, serves /healthz, and on SIGTERM drains and exits 0', async () => {
    const db = await createTestDb();
    try {
      const port = 20_000 + Math.floor(Math.random() * 20_000);
      const p = run({
        DATABASE_URL: db.url,
        GERTRUDE_URL: 'http://127.0.0.1:9',
        GERTRUDE_VERIFY_TOKEN: 'verify-token-for-process-test',
        SEND_SERVICE_TOKEN: 'send-token-for-process-test',
        CLIENT_ID: '11111111-2222-4333-8444-555555555555',
        CLIENT_SECRET: 'secret-for-process-test',
        TENANT_ID: '99999999-8888-4777-8666-555555555555',
        PORT: String(port),
      });
      await waitFor(() => p.out.join('').includes('service_started'));
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      p.child.kill('SIGTERM');
      const { code, signal } = await p.exited;
      expect(signal).toBeNull();
      expect(code).toBe(0);
      const logs = p.out.join('');
      expect(logs).toContain('shutdown_started');
      expect(logs).toContain('shutdown_complete');
      for (const line of logs.split('\n').filter(Boolean)) {
        expect(() => JSON.parse(line)).not.toThrow();
        expect(line).not.toContain('secret-for-process-test');
        expect(line).not.toContain('token-for-process-test');
      }
      await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    } finally {
      await db.drop();
    }
  });
});
