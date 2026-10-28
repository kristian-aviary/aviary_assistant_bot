export type IdempotencyStatus = 'in_progress' | 'sent' | 'failed_permanent' | 'unknown';
export type PermanentOutcome = 'blocked_or_uninstalled' | 'invalid_request';

export type IdempotencyEntry = {
  key: string;
  /** The conversation the key was first used for. A replay for another conversation is refused. */
  conversationId: string;
  status: IdempotencyStatus;
  outcome: PermanentOutcome | null;
  activityId: string | null;
};

/**
 * In-memory, one process (deploy one replica). Every method is synchronous, so a claim is atomic:
 * two requests can never both win the same key. State is lost on restart, which is acceptable
 * because Gertrude never retries `unknown`.
 */
export interface IdempotencyStore {
  find(key: string): IdempotencyEntry | null;
  /** Claims the key before Teams is called. The loser of a race gets the winner's entry. */
  claim(key: string, conversationId: string): { claimed: true } | { claimed: false; entry: IdempotencyEntry };
  markSent(key: string, activityId: string | null): boolean;
  markFailedPermanent(key: string, outcome: PermanentOutcome): boolean;
  markUnknown(key: string): boolean;
  /** Frees the key after a clean transient failure so Gertrude's retry can send. */
  release(key: string): boolean;
  readonly size: number;
}

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_MAX_ENTRIES = 50_000;

export type InMemoryIdempotencyOptions = {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
};

type Slot = IdempotencyEntry & { claimedAt: number };

export class InMemoryIdempotencyStore implements IdempotencyStore {
  // A Map iterates in insertion order, and every entry is inserted when it is claimed (never
  // re-inserted afterwards), so the first entry is always the oldest.
  private readonly slots = new Map<string, Slot>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: InMemoryIdempotencyOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? IDEMPOTENCY_TTL_MS;
    this.maxEntries = Math.max(1, opts.maxEntries ?? IDEMPOTENCY_MAX_ENTRIES);
  }

  get size(): number {
    this.sweep();
    return this.slots.size;
  }

  find(key: string): IdempotencyEntry | null {
    this.sweep();
    const slot = this.slots.get(key);
    return slot ? toEntry(slot) : null;
  }

  claim(key: string, conversationId: string): { claimed: true } | { claimed: false; entry: IdempotencyEntry } {
    this.sweep();
    const existing = this.slots.get(key);
    if (existing) return { claimed: false, entry: toEntry(existing) };
    while (this.slots.size >= this.maxEntries) {
      const oldest = this.slots.keys().next();
      if (oldest.done) break;
      this.slots.delete(oldest.value);
    }
    this.slots.set(key, { key, conversationId, status: 'in_progress', outcome: null, activityId: null, claimedAt: this.now() });
    return { claimed: true };
  }

  markSent(key: string, activityId: string | null): boolean {
    const slot = this.inProgress(key);
    if (!slot) return false;
    slot.status = 'sent';
    slot.activityId = activityId;
    return true;
  }

  markFailedPermanent(key: string, outcome: PermanentOutcome): boolean {
    const slot = this.inProgress(key);
    if (!slot) return false;
    slot.status = 'failed_permanent';
    slot.outcome = outcome;
    return true;
  }

  markUnknown(key: string): boolean {
    const slot = this.inProgress(key);
    if (!slot) return false;
    slot.status = 'unknown';
    return true;
  }

  release(key: string): boolean {
    return this.inProgress(key) ? this.slots.delete(key) : false;
  }

  private inProgress(key: string): Slot | undefined {
    const slot = this.slots.get(key);
    return slot && slot.status === 'in_progress' ? slot : undefined;
  }

  /** Drops expired entries from the old end. Entries are in claim order, so it stops at the first live one. */
  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, slot] of this.slots) {
      if (slot.claimedAt > cutoff) break;
      this.slots.delete(key);
    }
  }
}

const toEntry = (s: Slot): IdempotencyEntry => ({
  key: s.key,
  conversationId: s.conversationId,
  status: s.status,
  outcome: s.outcome,
  activityId: s.activityId,
});
