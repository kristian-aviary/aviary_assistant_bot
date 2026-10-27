import type { Db } from './db.js';

export type StoredReference = {
  userId: string;
  tenantId: string;
  aadObjectId: string;
  conversationId: string;
  serviceUrl: string;
  reference: Record<string, unknown>;
};

export type LinkResult =
  | { kind: 'created' }
  | { kind: 'refreshed' }
  | { kind: 'conflict'; reason: 'user_bound_to_other_identity' | 'identity_bound_to_other_user' };

export interface ConversationReferenceStore {
  get(userId: string): Promise<StoredReference | null>;
  link(ref: StoredReference): Promise<LinkResult>;
  deleteByIdentity(tenantId: string, aadObjectId: string): Promise<boolean>;
}

type RefRow = {
  user_id: string;
  tenant_id: string;
  aad_object_id: string;
  conversation_id: string;
  service_url: string;
  reference: Record<string, unknown>;
};

export class PgConversationReferenceStore implements ConversationReferenceStore {
  constructor(private readonly db: Db) {}

  async get(userId: string): Promise<StoredReference | null> {
    const res = await this.db.query<RefRow>(
      `select user_id, tenant_id, aad_object_id, conversation_id, service_url, reference
         from conversation_reference where user_id = $1`,
      [userId],
    );
    const r = res.rows[0];
    return r
      ? {
          userId: r.user_id,
          tenantId: r.tenant_id,
          aadObjectId: r.aad_object_id,
          conversationId: r.conversation_id,
          serviceUrl: r.service_url,
          reference: r.reference,
        }
      : null;
  }

  /**
   * One atomic statement. An existing row for the user is only refreshed when it
   * belongs to the same Teams identity (tenant + object id); otherwise the WHERE
   * clause leaves it untouched and no row is returned (REFERENCE_CONFLICT).
   * The (tenant, object id) unique index catches the mirror case: the same Teams
   * identity already linked to a different user_id.
   */
  async link(ref: StoredReference): Promise<LinkResult> {
    try {
      const res = await this.db.query<{ inserted: boolean }>(
        `insert into conversation_reference
           (user_id, tenant_id, aad_object_id, conversation_id, service_url, reference)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (user_id) do update set
           conversation_id = excluded.conversation_id,
           service_url     = excluded.service_url,
           reference       = excluded.reference,
           updated_at      = now()
         where conversation_reference.tenant_id = excluded.tenant_id
           and conversation_reference.aad_object_id = excluded.aad_object_id
         returning (xmax = 0) as inserted`,
        [ref.userId, ref.tenantId, ref.aadObjectId, ref.conversationId, ref.serviceUrl, JSON.stringify(ref.reference)],
      );
      const row = res.rows[0];
      if (!row) return { kind: 'conflict', reason: 'user_bound_to_other_identity' };
      return { kind: row.inserted ? 'created' : 'refreshed' };
    } catch (err) {
      if (isUniqueViolation(err)) return { kind: 'conflict', reason: 'identity_bound_to_other_user' };
      throw err;
    }
  }

  async deleteByIdentity(tenantId: string, aadObjectId: string): Promise<boolean> {
    const res = await this.db.query(
      'delete from conversation_reference where tenant_id = $1 and aad_object_id = $2',
      [tenantId, aadObjectId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export type IdempotencyStatus = 'in_progress' | 'sent' | 'failed_permanent' | 'unknown';
export type PermanentOutcome = 'blocked_or_uninstalled' | 'invalid_request';

export type IdempotencyRow = {
  key: string;
  userId: string;
  status: IdempotencyStatus;
  outcome: PermanentOutcome | null;
  activityId: string | null;
};

export interface IdempotencyStore {
  find(key: string): Promise<IdempotencyRow | null>;
  /** Claims the key before Teams is called. The loser of a race gets the winner's row. */
  claim(key: string, userId: string): Promise<{ claimed: true } | { claimed: false; row: IdempotencyRow }>;
  markSent(key: string, activityId: string | null): Promise<boolean>;
  markFailedPermanent(key: string, outcome: PermanentOutcome): Promise<boolean>;
  markUnknown(key: string): Promise<boolean>;
  /** Frees the key after a clean transient failure so Gertrude's retry can send. */
  release(key: string): Promise<boolean>;
  purgeOlderThan(days: number): Promise<number>;
}

type IdemRow = {
  key: string;
  user_id: string;
  status: IdempotencyStatus;
  outcome: PermanentOutcome | null;
  activity_id: string | null;
};

const toRow = (r: IdemRow): IdempotencyRow => ({
  key: r.key,
  userId: r.user_id,
  status: r.status,
  outcome: r.outcome,
  activityId: r.activity_id,
});

export class PgIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Db) {}

  async find(key: string): Promise<IdempotencyRow | null> {
    const res = await this.db.query<IdemRow>(
      'select key, user_id, status, outcome, activity_id from send_idempotency where key = $1',
      [key],
    );
    return res.rows[0] ? toRow(res.rows[0]) : null;
  }

  async claim(key: string, userId: string) {
    const ins = await this.db.query(
      `insert into send_idempotency (key, user_id, status) values ($1, $2, 'in_progress')
       on conflict (key) do nothing`,
      [key, userId],
    );
    if ((ins.rowCount ?? 0) === 1) return { claimed: true as const };
    const row = await this.find(key);
    if (!row) {
      // Released between our insert and our read: treat as lost; caller answers 409.
      return { claimed: false as const, row: { key, userId, status: 'in_progress' as const, outcome: null, activityId: null } };
    }
    return { claimed: false as const, row };
  }

  async markSent(key: string, activityId: string | null): Promise<boolean> {
    const res = await this.db.query(
      `update send_idempotency set status = 'sent', activity_id = $2, updated_at = now()
        where key = $1 and status = 'in_progress'`,
      [key, activityId],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async markFailedPermanent(key: string, outcome: PermanentOutcome): Promise<boolean> {
    const res = await this.db.query(
      `update send_idempotency set status = 'failed_permanent', outcome = $2, updated_at = now()
        where key = $1 and status = 'in_progress'`,
      [key, outcome],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async markUnknown(key: string): Promise<boolean> {
    const res = await this.db.query(
      `update send_idempotency set status = 'unknown', updated_at = now()
        where key = $1 and status = 'in_progress'`,
      [key],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async release(key: string): Promise<boolean> {
    const res = await this.db.query(`delete from send_idempotency where key = $1 and status = 'in_progress'`, [key]);
    return (res.rowCount ?? 0) === 1;
  }

  async purgeOlderThan(days: number): Promise<number> {
    const res = await this.db.query(
      `delete from send_idempotency where created_at < now() - ($1::int * interval '1 day')`,
      [days],
    );
    return res.rowCount ?? 0;
  }
}
