/**
 * Taskmaster Slice 1 DAL (WO-HARNESS-TASKMASTER-SLICE1-01, M-133).
 *
 * Persistence for the deterministic taskmaster loop: action journal
 * (row-first discipline), singleton pause/epoch control, provider health
 * samples with expiry, and usage observations where a failed meter is
 * recorded as is_unknown=1 -- never as zero available capacity.
 *
 * All sends still go through the dispatch DAL (createMessage in
 * ./dispatch.ts). This module never writes agent_dispatch_messages.
 */
import { randomUUID } from 'crypto';
import { createLogger } from '@archon/paths';
import { getDatabase } from './connection';

const log = createLogger('db/taskmaster');

export type TmActionType = 'deliver_ruling' | 'nudge' | 'escalate_p0' | 'digest';
export type TmActionOutcome =
  | 'pending'
  | 'sent'
  | 'parked'
  | 'deferred'
  | 'rejected'
  | 'expired'
  | 'failed';
export type TmGrade = 'useful' | 'noise' | 'harmful';
export type TmPauseState = 'RUNNING' | 'PAUSED' | 'HARD_PAUSE';
export type TmHealthState = 'healthy' | 'degraded' | 'dark' | 'unknown';
export type TmUsageConfidence = 'high' | 'low' | 'none';

export interface TmJournalEntry {
  id: string;
  created_at: string;
  thread_ref: string;
  action_type: TmActionType;
  proposal_json: string;
  idempotency_key: string | null;
  before_hash: string | null;
  proof_predicate: string | null;
  proof_deadline_at: string | null;
  outcome: TmActionOutcome;
  graded_at: string | null;
  grade: TmGrade | null;
}

export interface TmControlState {
  pause_state: TmPauseState;
  pause_scope: string | null;
  pause_reason: string | null;
  pause_actor: string | null;
  epoch: number;
  updated_at: string;
}

export interface TmHealthSample {
  provider: string;
  state: TmHealthState;
  sampled_at: string;
  expires_at: string;
  evidence: string | null;
}

export interface TmUsageSample {
  id: string;
  provider: string;
  window_kind: string;
  source: string;
  observed_at: string;
  value_json: string | null;
  confidence: TmUsageConfidence | null;
  is_unknown: number;
}

interface TmJournalRow extends Omit<
  TmJournalEntry,
  'created_at' | 'proof_deadline_at' | 'graded_at'
> {
  created_at: string | Date;
  proof_deadline_at: string | Date | null;
  graded_at: string | Date | null;
}

interface TmControlRow extends Omit<TmControlState, 'epoch' | 'updated_at'> {
  epoch: number | string;
  updated_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toNullableIso(value: string | Date | null): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function normalizeJournal(row: TmJournalRow): TmJournalEntry {
  return {
    ...row,
    created_at: toIso(row.created_at),
    proof_deadline_at: toNullableIso(row.proof_deadline_at),
    graded_at: toNullableIso(row.graded_at),
  };
}

function normalizeControl(row: TmControlRow): TmControlState {
  return {
    pause_state: row.pause_state,
    pause_scope: row.pause_scope,
    pause_reason: row.pause_reason,
    pause_actor: row.pause_actor,
    epoch: Number(row.epoch),
    updated_at: toIso(row.updated_at),
  };
}

/**
 * Record a taskmaster action in the journal. ROW FIRST, always -- the loop
 * calls this BEFORE attempting any external effect, then updates the outcome
 * afterwards via updateActionOutcome().
 */
export async function recordAction(data: {
  thread_ref: string;
  action_type: TmActionType;
  proposal_json: string;
  idempotency_key?: string | null;
  before_hash?: string | null;
  proof_predicate?: string | null;
  proof_deadline_at?: string | null;
  outcome: TmActionOutcome;
}): Promise<TmJournalEntry> {
  const result = await getDatabase().query<TmJournalRow>(
    `INSERT INTO tm_journal
     (id, created_at, thread_ref, action_type, proposal_json, idempotency_key,
      before_hash, proof_predicate, proof_deadline_at, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      randomUUID(),
      new Date().toISOString(),
      data.thread_ref,
      data.action_type,
      data.proposal_json,
      data.idempotency_key ?? null,
      data.before_hash ?? null,
      data.proof_predicate ?? null,
      data.proof_deadline_at ?? null,
      data.outcome,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to record taskmaster action');
  return normalizeJournal(row);
}

/** Update the outcome of a previously recorded action (post-effect). */
export async function updateActionOutcome(
  id: string,
  outcome: TmActionOutcome
): Promise<TmJournalEntry | null> {
  // The sqlite adapter rejects UPDATE ... RETURNING; mutate then re-read.
  const db = getDatabase();
  await db.query('UPDATE tm_journal SET outcome = $1 WHERE id = $2', [outcome, id]);
  const result = await db.query<TmJournalRow>('SELECT * FROM tm_journal WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? normalizeJournal(row) : null;
}

/**
 * Grade a sent action after its external effect is verified in the SOR.
 * Grading is a verification write, not a self-report -- the caller must
 * have observed the effect independently before calling this.
 */
export async function gradeAction(id: string, grade: TmGrade): Promise<TmJournalEntry | null> {
  const db = getDatabase();
  await db.query('UPDATE tm_journal SET grade = $1, graded_at = $2 WHERE id = $3', [
    grade,
    new Date().toISOString(),
    id,
  ]);
  const result = await db.query<TmJournalRow>('SELECT * FROM tm_journal WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? normalizeJournal(row) : null;
}

/** List journal actions created at or after the given ISO timestamp. */
export async function getActionsSince(
  sinceIso: string,
  threadRef?: string
): Promise<TmJournalEntry[]> {
  const params: unknown[] = [sinceIso];
  let sql = 'SELECT * FROM tm_journal WHERE created_at >= $1';
  if (threadRef) {
    params.push(threadRef);
    sql += ' AND thread_ref = $2';
  }
  sql += ' ORDER BY created_at ASC';
  const result = await getDatabase().query<TmJournalRow>(sql, params);
  return result.rows.map(normalizeJournal);
}

/**
 * Expire parked proposals (used on resume: epoch increments and stale
 * proposals are expired rather than replayed). Returns the count expired.
 */
export async function expireParkedActions(): Promise<number> {
  const db = getDatabase();
  const pending = await db.query<{ id: string }>(
    "SELECT id FROM tm_journal WHERE outcome IN ('parked', 'pending')"
  );
  if (pending.rows.length === 0) return 0;
  await db.query(
    "UPDATE tm_journal SET outcome = 'expired' WHERE outcome IN ('parked', 'pending')"
  );
  return pending.rows.length;
}

/** Read the singleton pause/epoch control row, creating it if absent. */
export async function getPauseState(): Promise<TmControlState> {
  const db = getDatabase();
  const result = await db.query<TmControlRow>('SELECT * FROM tm_control WHERE id = 1');
  const row = result.rows[0];
  if (row) return normalizeControl(row);
  // Defensive: seed the singleton if a fresh database lacks it.
  const inserted = await db.query<TmControlRow>(
    `INSERT INTO tm_control (id, pause_state, epoch, updated_at)
     VALUES (1, 'RUNNING', 0, $1)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [new Date().toISOString()]
  );
  const seeded = inserted.rows[0];
  if (seeded) return normalizeControl(seeded);
  const reread = await db.query<TmControlRow>('SELECT * FROM tm_control WHERE id = 1');
  const rereadRow = reread.rows[0];
  if (!rereadRow) throw new Error('tm_control singleton missing after seed attempt');
  return normalizeControl(rereadRow);
}

/**
 * Set the pause state. incrementEpoch is used by resume (and by auto-circuit
 * transitions) so in-flight proposals confirmed under the old epoch expire
 * instead of replaying.
 */
export async function setPauseState(data: {
  pause_state: TmPauseState;
  pause_scope?: string | null;
  pause_reason?: string | null;
  pause_actor: string;
  incrementEpoch?: boolean;
}): Promise<TmControlState> {
  await getPauseState(); // ensure singleton exists
  const db = getDatabase();
  await db.query(
    `UPDATE tm_control
     SET pause_state = $1,
         pause_scope = $2,
         pause_reason = $3,
         pause_actor = $4,
         epoch = epoch + $5,
         updated_at = $6
     WHERE id = 1`,
    [
      data.pause_state,
      data.pause_scope ?? null,
      data.pause_reason ?? null,
      data.pause_actor,
      data.incrementEpoch ? 1 : 0,
      new Date().toISOString(),
    ]
  );
  const result = await db.query<TmControlRow>('SELECT * FROM tm_control WHERE id = 1');
  const row = result.rows[0];
  if (!row) throw new Error('Failed to update tm_control');
  log.info(
    { pauseState: row.pause_state, epoch: Number(row.epoch), actor: data.pause_actor },
    'taskmaster.pause_state_updated'
  );
  return normalizeControl(row);
}

/** Upsert a provider health sample with expiry. */
export async function upsertHealthSample(data: {
  provider: string;
  state: TmHealthState;
  expires_at: string;
  evidence?: string | null;
}): Promise<TmHealthSample> {
  const sampledAt = new Date().toISOString();
  const result = await getDatabase().query<TmHealthSample>(
    `INSERT INTO tm_health (provider, state, sampled_at, expires_at, evidence)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider) DO UPDATE SET
       state = EXCLUDED.state,
       sampled_at = EXCLUDED.sampled_at,
       expires_at = EXCLUDED.expires_at,
       evidence = EXCLUDED.evidence
     RETURNING *`,
    [data.provider, data.state, sampledAt, data.expires_at, data.evidence ?? null]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to upsert taskmaster health sample');
  return { ...row, sampled_at: toIso(row.sampled_at), expires_at: toIso(row.expires_at) };
}

/**
 * Read a provider health sample. Returns null when absent OR expired --
 * an expired sample is not evidence of anything.
 */
export async function getHealthSample(provider: string): Promise<TmHealthSample | null> {
  const result = await getDatabase().query<TmHealthSample>(
    'SELECT * FROM tm_health WHERE provider = $1',
    [provider]
  );
  const row = result.rows[0];
  if (!row) return null;
  const expiresAt = toIso(row.expires_at);
  if (Date.parse(expiresAt) <= Date.now()) return null;
  return { ...row, sampled_at: toIso(row.sampled_at), expires_at: expiresAt };
}

/**
 * Record one usage observation. A failed meter MUST be recorded with
 * is_unknown=1 and a null value -- never as a numeric zero.
 */
export async function recordUsageSample(data: {
  provider: string;
  window_kind: string;
  source: string;
  value_json?: string | null;
  confidence?: TmUsageConfidence | null;
  is_unknown: boolean;
}): Promise<TmUsageSample> {
  const result = await getDatabase().query<TmUsageSample>(
    `INSERT INTO tm_usage_sample
     (id, provider, window_kind, source, observed_at, value_json, confidence, is_unknown)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      randomUUID(),
      data.provider,
      data.window_kind,
      data.source,
      new Date().toISOString(),
      data.value_json ?? null,
      data.confidence ?? null,
      data.is_unknown ? 1 : 0,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to record taskmaster usage sample');
  return { ...row, observed_at: toIso(row.observed_at), is_unknown: row.is_unknown };
}
