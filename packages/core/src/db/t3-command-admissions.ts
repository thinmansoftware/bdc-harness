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
 * (wo_id) WHERE verb='fire' AND state IN ('reserved','unknown') guarantees at
 * most one unresolved fire per WO, so a losing concurrent fire -- or any fire
 * while an unadjudicated `unknown` fire holds the WO -- returns `wo_fire_locked`. A duplicate
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

/**
 * Reconcile an admission to `unknown`: the command's effect cannot be proven
 * either way, so it is never reported ok and is NEVER refired automatically.
 *
 * Any cascade/run identity the caller DID observe is persisted -- a cascade that
 * executed before the failure already owns a real run, and this ledger is the
 * only durable record of it. `COALESCE($4, cascade_id)` can only ADD identity:
 * a caller that observed nothing (startup recovery) leaves whatever the row
 * already holds intact, so a retry still replays the original run identity.
 */
export async function markUnknown(
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
       SET state = 'unknown', status_code = $2, code = $3,
           cascade_id = COALESCE($4, cascade_id),
           run_id = COALESCE($5, run_id),
           updated_at = $6
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
 * An UNRESOLVED fire for this WO: a `reserved` row (mid-admission) or an
 * `unknown` row (its effect could not be proven -- a crash or an uncertain
 * cascade -- so a run may exist that no live-run scan can see yet, or one that
 * already finished). Both hold the WO lock until resolved; an `unknown` row is
 * resolved only by operator adjudication (adjudicateUnknownFire). Admissions are
 * NEVER deleted, so an `admitted` or `refused` row does not block: liveness of
 * an admitted fire's run is owned by the remote_agent_workflow_runs check
 * (hasLiveWorkflowRun). Excludes the caller's own request_id so a replay does
 * not treat itself as a competitor.
 */
export async function findLiveFireForWo(
  woId: string,
  excludeRequestId?: string,
  db: IDatabase = getDatabase()
): Promise<T3CommandAdmissionRow | null> {
  const result = await db.query<T3CommandAdmissionRow>(
    `SELECT * FROM t3_command_admissions
     WHERE verb = 'fire' AND wo_id = $1 AND state IN ('reserved', 'unknown')
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

export type UnknownFireAdjudication =
  | { resolution: 'no_run'; adjudicated_by: string; now: string }
  | { resolution: 'run'; run_id: string; adjudicated_by: string; now: string };

export type AdjudicateUnknownFireResult =
  | { status: 'adjudicated'; row: T3CommandAdmissionRow }
  | { status: 'not_found' }
  | { status: 'not_unknown'; row: T3CommandAdmissionRow };

/**
 * Operator adjudication of an `unknown` fire -- the ONLY path that releases the
 * WO fire lock an unknown fire holds (docs/runbooks/t3-command-consumer.md,
 * "Adjudicating an unknown fire").
 *
 *   no_run -> state `refused`, 409 `adjudicated_no_run:<adjudicator>`: the
 *             operator confirmed no run was created; the WO may be fired again
 *             by a NEW request.
 *   run    -> state `admitted`, 200 `ok` with the run id the operator proved;
 *             the actor then owns that run for cancel-own / approve, and later
 *             fires are gated by the live-run check like any admitted fire.
 *
 * Compare-and-set on state = 'unknown': a row in any other state is returned
 * unchanged (`not_unknown`). Request identity is never deleted.
 */
export async function adjudicateUnknownFire(
  requestId: string,
  decision: UnknownFireAdjudication,
  db: IDatabase = getDatabase()
): Promise<AdjudicateUnknownFireResult> {
  const adjudicatedBy = decision.adjudicated_by.trim();
  if (!adjudicatedBy) throw new Error('t3_adjudicated_by_required');
  if (decision.resolution === 'run' && !decision.run_id.trim()) {
    throw new Error('t3_adjudicated_run_id_required');
  }
  const result =
    decision.resolution === 'run'
      ? await db.query(
          `UPDATE t3_command_admissions
             SET state = 'admitted', status_code = 200, code = 'ok',
                 run_id = $2, updated_at = $3
           WHERE request_id = $1 AND verb = 'fire' AND state = 'unknown'`,
          [requestId, decision.run_id.trim(), decision.now]
        )
      : await db.query(
          `UPDATE t3_command_admissions
             SET state = 'refused', status_code = 409, code = $2, updated_at = $3
           WHERE request_id = $1 AND verb = 'fire' AND state = 'unknown'`,
          [requestId, `adjudicated_no_run:${adjudicatedBy}`, decision.now]
        );
  const row = await getByRequestId(requestId, db);
  if (!row) return { status: 'not_found' };
  if (result.rowCount === 0) return { status: 'not_unknown', row };
  return { status: 'adjudicated', row };
}
