import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Db = pg.Pool;

export function createPool(databaseUrl: string): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client erroring (server restart) must not crash the process.
  pool.on('error', () => {});
  return pool;
}

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const MIGRATION_LOCK_ID = 7_340_011;

/**
 * Plain SQL files applied in filename order, once each. A session advisory lock
 * serialises concurrent starters (two Railway instances during a deploy).
 */
export async function migrate(pool: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      }
      applied.push(file);
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
  return applied;
}

export async function pingDb(pool: Db, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const query = pool.query('select 1 as ok').then((res) => res.rows[0]?.ok === 1);
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return await Promise.race([query, timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
