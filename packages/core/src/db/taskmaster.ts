/**
 * Taskmaster Slice 1 DAL (WO-HARNESS-TASKMASTER-SLICE1-01, M-133 ratified).
 *
 * Persistence for the always-on Taskmaster loop: the action journal
 * (tm_journal), the pause/epoch control plane (tm_control), durable provider
 * health samples (tm_health) and capacity observations (tm_usage_sample).
 *
 * Row-first discipline: recordAction() writes the tm_journal row BEFORE any send
 * occurs (see loop.ts), and idempotency_key carries a UNIQUE constraint so a
 * restart-then-replay cannot double-send.
 */
import { randomUUID } from 'crypto';
import { createLogger } from '@archon/paths';
import { getDatabase } from './connection';

const log = createLogger('db/taskmaster');

export type TaskmasterActionType = 'deliver_ruling' | 'nudge' | 'escalate' | 'digest';
export type TaskmasterOutcome =
  | 'proposed'
  | 'sent'
  | 'parked'
  | 'rejected'
  | 'deferred'
  | 'expired';
export type TaskmasterPauseState = 'RUNNING' | 'PAUSED' | 'HARD_PAUSE';

export interface TaskmasterJournalRow {
  id: string;
  created_at: string;
  thread_ref: string;
  action_type: string;
  proposal_json: string;
  idempotency_key: string;
  before_hash: string | null;
  proof_predicate: string | null;
  proof_deadline_at: string | null;
  outcome: string;
  graded_at: string | null;
  grade: string | null;
}

export interface TaskmasterControlRow {
  id: number;
  pause_state: TaskmasterPauseState;
  pause_scope: string | null;
  pause_reason: string | null;
  pause_actor: string | null;
  epoch: number;
  updated_at: string;
}

export interface TaskmasterHealthRow {
  provider: string;
  state: string;
  sampled_at: string;
  expires_at: string | null;
  evidence: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Record a proposed action BEFORE it is actuated. Idempotent on idempotency_key:
 * if a row with the same key already exists (crash/restart), the existing row is
 * returned rather than a second insert -- the send path can then short-circuit.
 */
export async function recordAction(input: {
  thread_ref: string;
  action_type: TaskmasterActionType;
  proposal_json: string;
  idempotency_key: string;
  before_hash?: string | null;
  proof_predicate?: string | null;
  proof_deadline_at?: string | null;
  outcome?: TaskmasterOutcome;
}): Promise<TaskmasterJournalRow> {
  const db = getDatabase();
  const existing = await db.query<TaskmasterJournalRow>(
    'SELECT * FROM tm_journal WHERE idempotency_key = $1',
    [input.idempotency_key]
  );
  const existingRow = existing.rows[0];
  if (existingRow) return existingRow;

  const result = await db.query<TaskmasterJournalRow>(
    `INSERT INTO tm_journal
       (id, created_at, thread_ref, action_type, proposal_json, idempotency_key,
        before_hash, proof_predicate, proof_deadline_at, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING *`,
    [
      randomUUID(),
      nowIso(),
      input.thread_ref,
      input.action_type,
      input.proposal_json,
      input.idempotency_key,
      input.before_hash ?? null,
      input.proof_predicate ?? null,
      input.proof_deadline_at ?? null,
      input.outcome ?? 'proposed',
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('taskmaster_record_action_failed');
  return row;
}

/** Update the outcome (and optional grade) of a journalled action after actuation. */
export async function updateActionOutcome(
  id: string,
  outcome: TaskmasterOutcome,
  grade?: string | null
): Promise<void> {
  const db = getDatabase();
  const gradedAt = grade ? nowIso() : null;
  await db.query('UPDATE tm_journal SET outcome = $1, grade = $2, graded_at = $3 WHERE id = $4', [
    outcome,
    grade ?? null,
    gradedAt,
    id,
  ]);
}

export async function getActionByIdempotencyKey(key: string): Promise<TaskmasterJournalRow | null> {
  const db = getDatabase();
  const result = await db.query<TaskmasterJournalRow>(
    'SELECT * FROM tm_journal WHERE idempotency_key = $1',
    [key]
  );
  return result.rows[0] ?? null;
}

/** All actions journalled at or after `sinceIso`, newest first. */
export async function getActionsSince(sinceIso: string): Promise<TaskmasterJournalRow[]> {
  const db = getDatabase();
  const result = await db.query<TaskmasterJournalRow>(
    'SELECT * FROM tm_journal WHERE created_at >= $1 ORDER BY created_at DESC',
    [sinceIso]
  );
  return [...result.rows];
}

/**
 * Count SENT interventions against one thread since `sinceIso`. Feeds the
 * "max 3 automated interventions per item per 24h" budget. Only outcome='sent'
 * rows count -- parked/deferred/rejected proposals did not spend the budget.
 */
export async function countInterventionsSince(
  threadRef: string,
  sinceIso: string
): Promise<number> {
  const db = getDatabase();
  // COUNT(*) comes back as number (sqlite) or string (postgres bigint) depending
  // on dialect -- normalize to a number.
  const result = await db.query<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM tm_journal WHERE thread_ref = $1 AND outcome = 'sent' AND created_at >= $2",
    [threadRef, sinceIso]
  );
  return Number(result.rows[0]?.n ?? 0);
}

export async function getPauseState(): Promise<TaskmasterControlRow> {
  const db = getDatabase();
  const result = await db.query<
    Omit<TaskmasterControlRow, 'id' | 'epoch'> & { id: number | string; epoch: number | string }
  >('SELECT * FROM tm_control WHERE id = 1');
  const row = result.rows[0];
  if (row) {
    // Normalize across dialects (postgres may hand back numerics as strings).
    return { ...row, id: Number(row.id), epoch: Number(row.epoch) };
  }
  // Defensive: seed the singleton if the migration insert was skipped.
  await db.query(
    "INSERT INTO tm_control (id, pause_state, epoch, updated_at) VALUES (1, 'RUNNING', 0, $1) ON CONFLICT (id) DO NOTHING",
    [nowIso()]
  );
  return {
    id: 1,
    pause_state: 'RUNNING',
    pause_scope: null,
    pause_reason: null,
    pause_actor: null,
    epoch: 0,
    updated_at: nowIso(),
  };
}

/**
 * Set the pause state. Resuming to RUNNING increments the epoch so any proposal
 * computed under the prior (paused) epoch expires rather than replays. An
 * automatic circuit may only tighten into PAUSED/HARD_PAUSE; it may never KILL
 * (KILL is env-driven: TASKMASTER_INTERVAL_MS=0).
 */
export async function setPauseState(input: {
  pause_state: TaskmasterPauseState;
  pause_scope?: string | null;
  pause_reason?: string | null;
  pause_actor?: string | null;
}): Promise<TaskmasterControlRow> {
  const current = await getPauseState();
  const resuming = input.pause_state === 'RUNNING' && current.pause_state !== 'RUNNING';
  const nextEpoch = resuming ? current.epoch + 1 : current.epoch;
  const db = getDatabase();
  await db.query(
    `UPDATE tm_control
       SET pause_state = $1, pause_scope = $2, pause_reason = $3, pause_actor = $4,
           epoch = $5, updated_at = $6
     WHERE id = 1`,
    [
      input.pause_state,
      input.pause_scope ?? null,
      input.pause_reason ?? null,
      input.pause_actor ?? null,
      nextEpoch,
      nowIso(),
    ]
  );
  log.info(
    { pauseState: input.pause_state, epoch: nextEpoch, resuming },
    'taskmaster.pause_state_set'
  );
  return getPauseState();
}

/** Persist a provider health sample with explicit expiry. */
export async function upsertHealthSample(input: {
  provider: string;
  state: string;
  expires_at?: string | null;
  evidence?: string | null;
}): Promise<void> {
  const db = getDatabase();
  await db.query(
    `INSERT INTO tm_health (provider, state, sampled_at, expires_at, evidence)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.provider, input.state, nowIso(), input.expires_at ?? null, input.evidence ?? null]
  );
}

/**
 * Latest NON-EXPIRED health sample for a provider, or null. An expired sample is
 * treated as absent -- the Taskmaster never trusts stale health as durable truth.
 */
export async function getHealthSample(provider: string): Promise<TaskmasterHealthRow | null> {
  const db = getDatabase();
  const result = await db.query<TaskmasterHealthRow>(
    `SELECT * FROM tm_health
       WHERE provider = $1 AND (expires_at IS NULL OR expires_at > $2)
     ORDER BY sampled_at DESC LIMIT 1`,
    [provider, nowIso()]
  );
  return result.rows[0] ?? null;
}

/**
 * Record a capacity observation. is_unknown=true records a FAILED meter read;
 * a failed meter must never be persisted as numeric-zero capacity.
 */
export async function recordUsageSample(input: {
  provider?: string | null;
  window_kind?: string | null;
  source?: string | null;
  value_json?: string | null;
  confidence?: string | null;
  is_unknown?: boolean;
}): Promise<void> {
  const db = getDatabase();
  await db.query(
    `INSERT INTO tm_usage_sample
       (id, provider, window_kind, source, observed_at, value_json, confidence, is_unknown)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      input.provider ?? null,
      input.window_kind ?? null,
      input.source ?? null,
      nowIso(),
      input.value_json ?? null,
      input.confidence ?? null,
      input.is_unknown ? 1 : 0,
    ]
  );
}
