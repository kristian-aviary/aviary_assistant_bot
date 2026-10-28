import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate, pingDb } from '../src/db.js';
import { PgConversationReferenceStore, PgIdempotencyStore, type StoredReference } from '../src/repositories.js';
import { createTestDb, type TestDb } from './helpers/pg.js';

let db: TestDb;
let refs: PgConversationReferenceStore;
let idem: PgIdempotencyStore;

beforeAll(async () => {
  db = await createTestDb();
  await migrate(db.pool);
  refs = new PgConversationReferenceStore(db.pool);
  idem = new PgIdempotencyStore(db.pool);
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  await db.pool.query('truncate conversation_reference, send_idempotency');
});

const ref = (over: Partial<StoredReference> = {}): StoredReference => ({
  userId: 'user-a',
  tenantId: 'tenant-1',
  aadObjectId: 'aad-1',
  conversationId: 'conv-1',
  serviceUrl: 'https://smba.trafficmanager.net/emea',
  reference: { channelId: 'msteams', n: 1 },
  ...over,
});

describe('migrations', () => {
  it('apply once, record themselves, and are idempotent', async () => {
    const other = await createTestDb();
    try {
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'));
      expect(await migrate(other.pool)).toEqual(files.sort());
      expect(await migrate(other.pool)).toEqual([]);
      const recorded = await other.pool.query('select name from schema_migrations order by name');
      expect(recorded.rows.map((r) => r.name)).toEqual(files.sort());
    } finally {
      await other.drop();
    }
  });

  it('two concurrent starters do not collide', async () => {
    const other = await createTestDb();
    try {
      await Promise.all([migrate(other.pool), migrate(other.pool), migrate(other.pool)]);
      const t = await other.pool.query(`select count(*)::int as n from information_schema.tables where table_name in ('conversation_reference','send_idempotency')`);
      expect(t.rows[0].n).toBe(2);
    } finally {
      await other.drop();
    }
  });

  it('creates the specified tables, columns and the unique (tenant_id, aad_object_id) index', async () => {
    const cols = await db.pool.query(
      `select table_name, column_name, is_nullable from information_schema.columns
        where table_name in ('conversation_reference','send_idempotency') order by table_name, ordinal_position`,
    );
    const byTable = (t: string) => cols.rows.filter((r) => r.table_name === t).map((r) => r.column_name);
    expect(byTable('conversation_reference')).toEqual([
      'user_id', 'tenant_id', 'aad_object_id', 'conversation_id', 'service_url', 'reference', 'created_at', 'updated_at',
    ]);
    expect(byTable('send_idempotency')).toEqual(['key', 'user_id', 'status', 'outcome', 'activity_id', 'created_at', 'updated_at']);
    const idx = await db.pool.query(`select indexdef from pg_indexes where tablename = 'conversation_reference' and indexdef like '%UNIQUE%'`);
    expect(idx.rows.some((r) => /tenant_id, aad_object_id/.test(r.indexdef))).toBe(true);
  });

  it('rejects statuses outside the specified set', async () => {
    await expect(db.pool.query(`insert into send_idempotency (key, user_id, status) values ($1, 'u', 'bogus')`, [randomUUID()])).rejects.toThrow();
    await expect(db.pool.query(`insert into send_idempotency (key, user_id, status) values ($1, 'u', 'failed_permanent')`, [randomUUID()])).rejects.toThrow();
  });
});

describe('pingDb', () => {
  it('true when the database answers, false when it cannot', async () => {
    expect(await pingDb(db.pool)).toBe(true);
    const dead = await createTestDb();
    await dead.drop();
    expect(await pingDb(dead.pool, 500)).toBe(false);
  });
});

describe('ConversationReferenceStore', () => {
  it('creates, reads back (including jsonb), and refreshes the same identity', async () => {
    expect(await refs.link(ref())).toEqual({ kind: 'created' });
    expect(await refs.get('user-a')).toEqual(ref());

    const refreshed = ref({ conversationId: 'conv-2', serviceUrl: 'https://smba.trafficmanager.net/amer', reference: { n: 2 } });
    expect(await refs.link(refreshed)).toEqual({ kind: 'refreshed' });
    expect(await refs.get('user-a')).toEqual(refreshed);
    const row = await db.pool.query('select created_at, updated_at from conversation_reference');
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(row.rows[0].created_at.getTime());
  });

  it('get returns null for an unknown user', async () => {
    expect(await refs.get('nobody')).toBeNull();
  });

  it('REFERENCE_CONFLICT: same user_id with a different aad_object_id keeps the old row untouched', async () => {
    await refs.link(ref());
    const res = await refs.link(ref({ aadObjectId: 'aad-OTHER', conversationId: 'conv-evil' }));
    expect(res).toEqual({ kind: 'conflict', reason: 'user_bound_to_other_identity' });
    expect(await refs.get('user-a')).toEqual(ref());
  });

  it('REFERENCE_CONFLICT: same user_id in a different tenant keeps the old row untouched', async () => {
    await refs.link(ref());
    const res = await refs.link(ref({ tenantId: 'tenant-OTHER', conversationId: 'conv-evil' }));
    expect(res).toEqual({ kind: 'conflict', reason: 'user_bound_to_other_identity' });
    expect(await refs.get('user-a')).toEqual(ref());
  });

  it('the same Teams identity cannot be linked to a second user_id (unique index), and both rows stay as they were', async () => {
    await refs.link(ref());
    const res = await refs.link(ref({ userId: 'user-b' }));
    expect(res).toEqual({ kind: 'conflict', reason: 'identity_bound_to_other_user' });
    expect(await refs.get('user-b')).toBeNull();
    expect(await refs.get('user-a')).toEqual(ref());
  });

  it('different Teams identities for different users coexist', async () => {
    await refs.link(ref());
    expect(await refs.link(ref({ userId: 'user-b', aadObjectId: 'aad-2' }))).toEqual({ kind: 'created' });
    expect((await db.pool.query('select count(*)::int as n from conversation_reference')).rows[0].n).toBe(2);
  });

  it('deleteByIdentity removes only the matching tenant + object id', async () => {
    await refs.link(ref());
    await refs.link(ref({ userId: 'user-b', aadObjectId: 'aad-2' }));
    expect(await refs.deleteByIdentity('tenant-1', 'aad-NOPE')).toBe(false);
    expect(await refs.deleteByIdentity('tenant-OTHER', 'aad-1')).toBe(false);
    expect(await refs.deleteByIdentity('tenant-1', 'aad-1')).toBe(true);
    expect(await refs.get('user-a')).toBeNull();
    expect(await refs.get('user-b')).not.toBeNull();
    expect(await refs.deleteByIdentity('tenant-1', 'aad-1')).toBe(false);
  });

  it('concurrent first links for one user create exactly one row', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => refs.link(ref())));
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
    expect(results.every((r) => r.kind === 'created' || r.kind === 'refreshed')).toBe(true);
  });
});

describe('IdempotencyStore state machine', () => {
  it('claim then markSent', async () => {
    const key = randomUUID();
    expect(await idem.find(key)).toBeNull();
    expect(await idem.claim(key, 'u')).toEqual({ claimed: true });
    expect(await idem.find(key)).toMatchObject({ status: 'in_progress', userId: 'u', activityId: null });
    expect(await idem.markSent(key, 'act-1')).toBe(true);
    expect(await idem.find(key)).toMatchObject({ status: 'sent', activityId: 'act-1' });
  });

  it('the loser of a claim gets the winner row', async () => {
    const key = randomUUID();
    await idem.claim(key, 'u');
    const second = await idem.claim(key, 'u');
    expect(second).toMatchObject({ claimed: false, row: { status: 'in_progress', userId: 'u' } });
    await idem.markSent(key, 'a');
    expect(await idem.claim(key, 'u')).toMatchObject({ claimed: false, row: { status: 'sent', activityId: 'a' } });
  });

  it('concurrent claims: exactly one wins', async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 12 }, () => idem.claim(key, 'u')));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });

  it('failed_permanent stores the outcome for replay', async () => {
    const key = randomUUID();
    await idem.claim(key, 'u');
    expect(await idem.markFailedPermanent(key, 'blocked_or_uninstalled')).toBe(true);
    expect(await idem.find(key)).toMatchObject({ status: 'failed_permanent', outcome: 'blocked_or_uninstalled' });
  });

  it('unknown is terminal: it can never be released, resent or upgraded', async () => {
    const key = randomUUID();
    await idem.claim(key, 'u');
    expect(await idem.markUnknown(key)).toBe(true);
    expect(await idem.release(key)).toBe(false);
    expect(await idem.markSent(key, 'late')).toBe(false);
    expect(await idem.markFailedPermanent(key, 'invalid_request')).toBe(false);
    expect(await idem.markUnknown(key)).toBe(false);
    expect(await idem.find(key)).toMatchObject({ status: 'unknown', activityId: null });
    expect(await idem.claim(key, 'u')).toMatchObject({ claimed: false, row: { status: 'unknown' } });
  });

  it('sent is terminal', async () => {
    const key = randomUUID();
    await idem.claim(key, 'u');
    await idem.markSent(key, 'a');
    expect(await idem.release(key)).toBe(false);
    expect(await idem.markUnknown(key)).toBe(false);
    expect(await idem.markFailedPermanent(key, 'invalid_request')).toBe(false);
    expect(await idem.find(key)).toMatchObject({ status: 'sent', activityId: 'a' });
  });

  it('failed_permanent is terminal', async () => {
    const key = randomUUID();
    await idem.claim(key, 'u');
    await idem.markFailedPermanent(key, 'invalid_request');
    expect(await idem.release(key)).toBe(false);
    expect(await idem.markSent(key, 'a')).toBe(false);
    expect(await idem.markUnknown(key)).toBe(false);
  });

  it('release frees an in_progress key so it can be claimed again (clean transient failure)', async () => {
    const key = randomUUID();
    await idem.claim(key, 'u');
    expect(await idem.release(key)).toBe(true);
    expect(await idem.find(key)).toBeNull();
    expect(await idem.claim(key, 'u')).toEqual({ claimed: true });
  });

  it('transitions on a missing key do nothing', async () => {
    const key = randomUUID();
    expect(await idem.markSent(key, 'a')).toBe(false);
    expect(await idem.markUnknown(key)).toBe(false);
    expect(await idem.release(key)).toBe(false);
  });

  it('purgeOlderThan keeps recent keys and removes old ones; 30 days are always kept', async () => {
    const [fresh, old, thirtyOne] = [randomUUID(), randomUUID(), randomUUID()];
    for (const k of [fresh, old, thirtyOne]) await idem.claim(k, 'u');
    await db.pool.query(`update send_idempotency set created_at = now() - interval '90 days' where key = $1`, [old]);
    await db.pool.query(`update send_idempotency set created_at = now() - interval '31 days' where key = $1`, [thirtyOne]);
    expect(await idem.purgeOlderThan(45)).toBe(1);
    expect(await idem.find(old)).toBeNull();
    expect(await idem.find(thirtyOne)).not.toBeNull();
    expect(await idem.find(fresh)).not.toBeNull();
  });
});
