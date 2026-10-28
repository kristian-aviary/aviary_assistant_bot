import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, type Db } from '../../src/db.js';

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://bot_test:bot_test@127.0.0.1:5432/postgres';
const PREFIX = 'aviary_bot_test_';

export type TestDb = { url: string; name: string; pool: Db; drop(): Promise<void> };

/** A throwaway database per call, named aviary_bot_test_*, dropped afterwards. Never a shared database. */
export async function createTestDb(): Promise<TestDb> {
  const name = `${PREFIX}${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach the local test Postgres (TEST_PG_ADMIN_URL, default ${ADMIN_URL.replace(/:[^:@/]*@/, ':***@')}): ${(err as Error).message}`,
    );
  }
  await admin.query(`create database ${name}`);
  await admin.end();
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  const url = u.toString();
  const pool = createPool(url);
  return {
    url,
    name,
    pool,
    async drop() {
      await pool.end().catch(() => {});
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}
