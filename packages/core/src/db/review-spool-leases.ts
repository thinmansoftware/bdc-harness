/**
 * Review spool single-writer lease (WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01).
 *
 * One row per review spool in `review_spool_leases`. Exactly one review worker
 * holds a spool at a time: it acquires the lease for a whole review tick,
 * renews it while the tick runs and releases it in `finally`. Checkout
 * eviction re-checks (holder, fencing token) against the database before every
 * directory delete.
 *
 * Acquire is ONE conditional UPSERT inside `withSerializedTransaction`: insert
 * the row, or take it over only where `expires_at` is before the database
 * clock, incrementing `fencing_token`. The caller holds the lease only if the
 * row afterwards carries its holder id and that token. The database does the
 * compare-and-swap, so a takeover race has exactly one winner (a lock FILE has
 * no atomic compare-and-delete, which is why this replaced one).
 *
 * Release never deletes the row: it expires it, so the fencing token stays
 * monotonic across holders.
 */
import { getDatabase } from './connection';
import { databaseClock, withSerializedTransaction, type TxQuery } from './overseer-control-plane';

export interface ReviewSpoolLease {
  readonly spool_key: string;
  readonly holder_id: string;
  readonly fencing_token: number;
  readonly acquired_at: string;
  readonly heartbeat_at: string;
  readonly expires_at: string;
}

export interface ReviewSpoolLeaseIdentity {
  readonly spool_key: string;
  readonly holder_id: string;
  readonly fencing_token: number;
}

/** Expiry written by release: always before any database clock, so the next acquire takes over. */
const RELEASED_EXPIRES_AT = '1970-01-01T00:00:00.000Z';

function lockKey(spoolKey: string): string {
  return `review-spool-lease:${spoolKey}`;
}

function text(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  throw new Error('review_spool_lease_invalid_timestamp');
}

function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('review_spool_lease_invalid_integer');
  return parsed;
}

function validTtl(ttlSeconds: number): boolean {
  return Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0;
}

function validIdentity(identity: ReviewSpoolLeaseIdentity): boolean {
  return (
    identity.spool_key.trim().length > 0 &&
    identity.holder_id.trim().length > 0 &&
    Number.isSafeInteger(identity.fencing_token) &&
    identity.fencing_token > 0
  );
}

function expiryAfter(dbNow: string, ttlSeconds: number): string {
  return new Date(Date.parse(dbNow) + ttlSeconds * 1000).toISOString();
}

interface LeaseRow {
  spool_key: string;
  holder_id: string;
  fencing_token: number | string;
  acquired_at: unknown;
  heartbeat_at: unknown;
  expires_at: unknown;
}

async function readLease(query: TxQuery, spoolKey: string): Promise<ReviewSpoolLease | null> {
  const row = (
    await query<LeaseRow>(
      `SELECT spool_key,holder_id,fencing_token,acquired_at,heartbeat_at,expires_at
       FROM review_spool_leases WHERE spool_key=$1`,
      [spoolKey]
    )
  ).rows[0];
  return row
    ? {
        spool_key: row.spool_key,
        holder_id: row.holder_id,
        fencing_token: integer(row.fencing_token),
        acquired_at: text(row.acquired_at),
        heartbeat_at: text(row.heartbeat_at),
        expires_at: text(row.expires_at),
      }
    : null;
}

/**
 * Acquire (or take over an expired) review spool lease. Returns the lease when
 * this holder now owns it, else null (another holder's lease is live).
 */
export async function acquireReviewSpoolLease(input: {
  spool_key: string;
  holder_id: string;
  ttl_seconds: number;
}): Promise<ReviewSpoolLease | null> {
  const spoolKey = input.spool_key.trim();
  const holderId = input.holder_id.trim();
  if (!spoolKey || !holderId || !validTtl(input.ttl_seconds)) {
    throw new Error('review_spool_lease_invalid_input');
  }
  const database = getDatabase();
  return withSerializedTransaction(database, lockKey(spoolKey), async query => {
    const clock = await databaseClock(query, database.dialect);
    const expiresAt = expiryAfter(clock.db_now, input.ttl_seconds);
    await query(
      `INSERT INTO review_spool_leases
         (spool_key,holder_id,fencing_token,acquired_at,heartbeat_at,expires_at)
       VALUES ($1,$2,1,$3,$3,$4)
       ON CONFLICT (spool_key) DO UPDATE SET
         holder_id=EXCLUDED.holder_id,
         fencing_token=review_spool_leases.fencing_token + 1,
         acquired_at=EXCLUDED.acquired_at,
         heartbeat_at=EXCLUDED.heartbeat_at,
         expires_at=EXCLUDED.expires_at
       WHERE review_spool_leases.expires_at < EXCLUDED.acquired_at`,
      [spoolKey, holderId, clock.db_now, expiresAt]
    );
    const lease = await readLease(query, spoolKey);
    // Held only if the row now carries this holder and this acquisition's clock.
    return lease?.holder_id === holderId && lease.acquired_at === clock.db_now ? lease : null;
  });
}

/** Extend a held lease. Null when (holder, token) no longer holds a live lease. */
export async function renewReviewSpoolLease(
  identity: ReviewSpoolLeaseIdentity,
  ttlSeconds: number
): Promise<ReviewSpoolLease | null> {
  if (!validIdentity(identity) || !validTtl(ttlSeconds)) return null;
  const database = getDatabase();
  return withSerializedTransaction(database, lockKey(identity.spool_key), async query => {
    const clock = await databaseClock(query, database.dialect);
    const changed = await query(
      `UPDATE review_spool_leases SET heartbeat_at=$1,expires_at=$2
       WHERE spool_key=$3 AND holder_id=$4 AND fencing_token=$5 AND expires_at > $1`,
      [
        clock.db_now,
        expiryAfter(clock.db_now, ttlSeconds),
        identity.spool_key,
        identity.holder_id,
        identity.fencing_token,
      ]
    );
    if (changed.rowCount !== 1) return null;
    return readLease(query, identity.spool_key);
  });
}

/** Release a held lease (expires it). False when (holder, token) did not hold it. */
export async function releaseReviewSpoolLease(
  identity: ReviewSpoolLeaseIdentity
): Promise<boolean> {
  if (!validIdentity(identity)) return false;
  const database = getDatabase();
  return withSerializedTransaction(database, lockKey(identity.spool_key), async query => {
    const clock = await databaseClock(query, database.dialect);
    const changed = await query(
      `UPDATE review_spool_leases SET heartbeat_at=$1,expires_at=$2
       WHERE spool_key=$3 AND holder_id=$4 AND fencing_token=$5 AND expires_at > $1`,
      [
        clock.db_now,
        RELEASED_EXPIRES_AT,
        identity.spool_key,
        identity.holder_id,
        identity.fencing_token,
      ]
    );
    return changed.rowCount === 1;
  });
}

/** True only while (holder, token) holds a live (unexpired) lease, by the database clock. */
export async function checkReviewSpoolLease(identity: ReviewSpoolLeaseIdentity): Promise<boolean> {
  if (!validIdentity(identity)) return false;
  const database = getDatabase();
  return withSerializedTransaction(database, lockKey(identity.spool_key), async query => {
    const clock = await databaseClock(query, database.dialect);
    const lease = await readLease(query, identity.spool_key);
    return (
      lease !== null &&
      lease.holder_id === identity.holder_id &&
      lease.fencing_token === identity.fencing_token &&
      Date.parse(lease.expires_at) > Date.parse(clock.db_now)
    );
  });
}
