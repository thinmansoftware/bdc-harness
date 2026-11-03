/**
 * WO-HARNESS-T3-COMMAND-CONSUMER-01 Amendment 5 A5.0: ONE database-enforced
 * WO claim shared by every in-process cascade caller (Taskmaster and the T3
 * command consumer).
 *
 * runCascade already acquires a per-WO lock BEFORE any dispatch and releases it
 * only when its record is terminal (smart-cauldron wo-lock seam). This module is
 * the database-backed implementation of that seam: a claim is an `active` row
 * in cascade_wo_claims, at most one per canonical WO id (partial unique index),
 * held through every tier and pause. Rows are never deleted; release is a CAS to
 * `released` by the holding cascade only. A claim whose process died stays
 * `active` until an operator releases it (unknown outcomes stay blocked).
 */
import { getDatabase } from './connection';
import type { IDatabase } from './adapters/types';

export interface WoClaimRow {
  wo_id: string;
  project: string;
  cascade_id: string;
  holder: string;
  state: 'active' | 'released';
  claimed_at: string;
  released_at: string | null;
}

export interface AcquireWoClaimResult {
  acquired: boolean;
  claim: WoClaimRow | null;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /UNIQUE constraint failed/i.test(message);
}

export async function findActiveWoClaim(
  woId: string,
  db: IDatabase = getDatabase()
): Promise<WoClaimRow | null> {
  const result = await db.query<WoClaimRow>(
    "SELECT * FROM cascade_wo_claims WHERE wo_id = $1 AND state = 'active' LIMIT 1",
    [woId]
  );
  return result.rows[0] ?? null;
}

/**
 * Claim `woId` for `cascadeId`. Idempotent for the same cascade (a replayed
 * dispatch re-acquires its own claim); refused while another cascade holds it.
 */
export async function acquireWoClaim(
  input: { woId: string; project: string; cascadeId: string; holder: string; now: string },
  db: IDatabase = getDatabase()
): Promise<AcquireWoClaimResult> {
  try {
    await db.query(
      `INSERT INTO cascade_wo_claims (wo_id, project, cascade_id, holder, state, claimed_at)
       VALUES ($1, $2, $3, $4, 'active', $5)`,
      [input.woId, input.project, input.cascadeId, input.holder, input.now]
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await findActiveWoClaim(input.woId, db);
    return { acquired: existing?.cascade_id === input.cascadeId, claim: existing };
  }
  return { acquired: true, claim: await findActiveWoClaim(input.woId, db) };
}

/** CAS release by the holding cascade only. Returns whether this call released it. */
export async function releaseWoClaim(
  input: { woId: string; cascadeId: string; now: string },
  db: IDatabase = getDatabase()
): Promise<boolean> {
  const result = await db.query(
    `UPDATE cascade_wo_claims SET state = 'released', released_at = $3
     WHERE wo_id = $1 AND cascade_id = $2 AND state = 'active'`,
    [input.woId, input.cascadeId, input.now]
  );
  return result.rowCount > 0;
}
