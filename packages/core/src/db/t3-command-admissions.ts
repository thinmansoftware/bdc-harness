/**
 * WO-HARNESS-T3-COMMAND-CONSUMER-01: durable admission ledger for the
 * cauldron-fire T3 command consumer.
 *
 * Each typed command (fire / cancel-own / approve) is admitted at most once,
 * keyed by request_id. Modeled on the Taskmaster tm_fire_admissions state
 * machine (migration 063 / taskmaster.ts): reserved -> admitted | refused, and
 * `unknown` for a fire reserved before a crash whose cascade cannot be proven
 * (never refired automatically). Rows are NEVER deleted: request and run
 * identity are retained after completion so a retry returns the original
 * outcome.
 *
 * This table is NOT tm_fire_admissions (whose CHECK pins source='taskmaster').
 */
import { getDatabase } from './connection';
import type { IDatabase } from './adapters/types';

export type T3CommandVerb = 'fire' | 'cancel-own' | 'approve';
export type T3CommandAdmissionState = 'reserved' | 'admitted' | 'refused' | 'unknown';

export interface T3CommandAdmissionRow {
  request_id: string;
  actor_principal_id: string;
  verb: T3CommandVerb;
  payload_sha256: string;
  wo_id: string | null;
  project: string | null;
  target_run_id: string | null;
  pr_ref: string | null;
  head_sha: string | null;
  thread_id: string | null;
  source_message_id: string;
  state: T3CommandAdmissionState;
  status_code: number | null;
  code: string | null;
  cascade_id: string | null;
  run_id: string | null;
  reply_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReserveAdmissionInput {
  request_id: string;
  actor_principal_id: string;
  verb: T3CommandVerb;
  payload_sha256: string;
  wo_id?: string | null;
  project?: string | null;
  target_run_id?: string | null;
  pr_ref?: string | null;
  head_sha?: string | null;
  thread_id?: string | null;
  source_message_id: string;
  now: string;
}

export type ReserveAdmissionResult =
  | { status: 'reserved'; row: T3CommandAdmissionRow }
  | { status: 'exists'; row: T3CommandAdmissionRow }
  | { status: 'wo_fire_locked' };

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true; // Postgres unique_violation
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /UNIQUE constraint failed/i.test(message);
}

export async function getByRequestId(
  requestId: string,
  db: IDatabase = getDatabase()
): Promise<T3CommandAdmissionRow | null> {
  const result = await db.query<T3CommandAdmissionRow>(
    'SELECT * FROM t3_command_admissions WHERE request_id = $1',
    [requestId]
  );
  return result.rows[0] ?? null;
}

/**
 * Insert a `reserved` admission for this request. The partial unique index on
 * (wo_id) WHERE verb='fire' AND state='reserved' guarantees at most one reserved
 * fire per WO, so a losing concurrent fire returns `wo_fire_locked`. A duplicate
 * request_id returns the existing row (`exists`); the caller decides replay vs
 * conflict from the stored digest and actor.
 */
export async function reserveAdmission(
  input: ReserveAdmissionInput,
  db: IDatabase = getDatabase()
): Promise<ReserveAdmissionResult> {
  try {
    await db.query(
      `INSERT INTO t3_command_admissions
        (request_id, actor_principal_id, verb, payload_sha256, wo_id, project,
         target_run_id, pr_ref, head_sha, thread_id, source_message_id, state,
         created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'reserved',$12,$12)`,
      [
        input.request_id,
        input.actor_principal_id,
        input.verb,
        input.payload_sha256,
        input.wo_id ?? null,
        input.project ?? null,
        input.target_run_id ?? null,
        input.pr_ref ?? null,
        input.head_sha ?? null,
        input.thread_id ?? null,
        input.source_message_id,
        input.now,
      ]
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await getByRequestId(input.request_id, db);
    if (existing) return { status: 'exists', row: existing };
    // request_id did not exist -> the violated constraint was the fire lock.
    return { status: 'wo_fire_locked' };
  }
  const row = await getByRequestId(input.request_id, db);
  if (!row) throw new Error('t3_admission_reserve_readback_missing');
  return { status: 'reserved', row };
}

/**
 * Persist a terminal `refused` row for a brand-new request_id that never held a
 * reservation (used only for the wo-fire-lock loser so its retry can replay).
 */
export async function insertRefused(
  input: {
    request_id: string;
    actor_principal_id: string;
    verb: T3CommandVerb;
    payload_sha256: string;
    wo_id?: string | null;
    project?: string | null;
    target_run_id?: string | null;
    pr_ref?: string | null;
    head_sha?: string | null;
    thread_id?: string | null;
    source_message_id: string;
    status_code: number;
    code: string;
    run_id?: string | null;
    cascade_id?: string | null;
    now: string;
  },
  db: IDatabase = getDatabase()
): Promise<T3CommandAdmissionRow> {
  await db.query(
    `INSERT INTO t3_command_admissions
      (request_id, actor_principal_id, verb, payload_sha256, wo_id, project,
       target_run_id, pr_ref, head_sha, thread_id, source_message_id, state,
       status_code, code, run_id, cascade_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'refused',$12,$13,$14,$15,$16,$16)
     ON CONFLICT (request_id) DO NOTHING`,
    [
      input.request_id,
      input.actor_principal_id,
      input.verb,
      input.payload_sha256,
      input.wo_id ?? null,
      input.project ?? null,
      input.target_run_id ?? null,
      input.pr_ref ?? null,
      input.head_sha ?? null,
      input.thread_id ?? null,
      input.source_message_id,
      input.status_code,
      input.code,
      input.run_id ?? null,
      input.cascade_id ?? null,
      input.now,
    ]
  );
  const row = await getByRequestId(input.request_id, db);
  if (!row) throw new Error('t3_admission_refused_readback_missing');
  return row;
}

export async function markAdmitted(
  requestId: string,
  outcome: {
    status_code: number;
    code: string;
    cascade_id?: string | null;
    run_id?: string | null;
    now: string;
  },
  db: IDatabase = getDatabase()
): Promise<void> {
  await db.query(
    `UPDATE t3_command_admissions
       SET state = 'admitted', status_code = $2, code = $3,
           cascade_id = $4, run_id = $5, updated_at = $6
     WHERE request_id = $1`,
    [
      requestId,
      outcome.status_code,
      outcome.code,
      outcome.cascade_id ?? null,
      outcome.run_id ?? null,
      outcome.now,
    ]
  );
}

export async function markRefused(
  requestId: string,
  outcome: {
    status_code: number;
    code: string;
    run_id?: string | null;
    cascade_id?: string | null;
    now: string;
  },
  db: IDatabase = getDatabase()
): Promise<void> {
  await db.query(
    `UPDATE t3_command_admissions
       SET state = 'refused', status_code = $2, code = $3,
           run_id = $4, cascade_id = $5, updated_at = $6
     WHERE request_id = $1`,
    [
      requestId,
      outcome.status_code,
      outcome.code,
      outcome.run_id ?? null,
      outcome.cascade_id ?? null,
      outcome.now,
    ]
  );
}

export async function markUnknown(
  requestId: string,
  outcome: { status_code: number; code: string; now: string },
  db: IDatabase = getDatabase()
): Promise<void> {
  await db.query(
    `UPDATE t3_command_admissions
       SET state = 'unknown', status_code = $2, code = $3, updated_at = $4
     WHERE request_id = $1`,
    [requestId, outcome.status_code, outcome.code, outcome.now]
  );
}

export async function recordReply(
  requestId: string,
  replyMessageId: string,
  now: string,
  db: IDatabase = getDatabase()
): Promise<void> {
  await db.query(
    `UPDATE t3_command_admissions SET reply_message_id = $2, updated_at = $3
     WHERE request_id = $1`,
    [requestId, replyMessageId, now]
  );
}

/**
 * A still-live fire admission for this WO: a reserved fire (mid-admission) or an
 * admitted fire (succeeded). Excludes the caller's own request_id so a replay
 * does not treat itself as a competitor.
 */
export async function findLiveFireForWo(
  woId: string,
  excludeRequestId?: string,
  db: IDatabase = getDatabase()
): Promise<T3CommandAdmissionRow | null> {
  const result = await db.query<T3CommandAdmissionRow>(
    `SELECT * FROM t3_command_admissions
     WHERE verb = 'fire' AND wo_id = $1 AND state IN ('reserved','admitted')
       AND ($2 = '' OR request_id <> $2)
     ORDER BY created_at ASC
     LIMIT 1`,
    [woId, excludeRequestId ?? '']
  );
  return result.rows[0] ?? null;
}

/**
 * True when `actorPrincipalId` admitted a fire through this consumer whose
 * resulting run_id equals `runId`. The sole ownership source for cancel-own and
 * approve -- server-authenticated, never trusted from the request body.
 */
export async function ownsRun(
  actorPrincipalId: string,
  runId: string,
  db: IDatabase = getDatabase()
): Promise<boolean> {
  if (!runId) return false;
  const result = await db.query<{ request_id: string }>(
    `SELECT request_id FROM t3_command_admissions
     WHERE verb = 'fire' AND state = 'admitted'
       AND actor_principal_id = $1 AND run_id = $2
     LIMIT 1`,
    [actorPrincipalId, runId]
  );
  return result.rows.length > 0;
}

/** Reserved fire admissions found at startup (crash recovery). */
export async function listReservedFires(
  db: IDatabase = getDatabase()
): Promise<T3CommandAdmissionRow[]> {
  const result = await db.query<T3CommandAdmissionRow>(
    `SELECT * FROM t3_command_admissions WHERE verb = 'fire' AND state = 'reserved'
     ORDER BY created_at ASC`
  );
  return [...result.rows];
}
