import { randomUUID } from 'crypto';
import { createLogger } from '@archon/paths';
import { getDatabase } from './connection';

const log = createLogger('db/overseer');

export interface OverseerWatchRun {
  id: string;
  woId: string;
  /**
   * Repo identity as recorded by the run itself. OPTIONAL and frequently absent:
   * the engine writes only telemetry into run metadata, so most runs carry no repo
   * at all. Undefined means unknown -- never substitute a default, or the PR lookup
   * silently searches the wrong repository.
   */
  repo?: string;
  owner?: string;
  status: string;
  headBranch?: string;
  /**
   * Engine-written worktree path for this run. Trustworthy provenance anchor:
   * agents author `metadata` (including headBranch), but not this column.
   */
  workingPath?: string;
  metadata: Record<string, unknown>;
}

export interface OverseerWorkflowEventRow {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface OverseerAction {
  id: string;
  run_id: string;
  wo_id: string;
  class: string;
  action: string;
  result: string;
  created_at: string;
}

interface WorkflowRunRow {
  id: string;
  status: string;
  metadata: unknown;
  user_message: string;
  // Engine-written (see workflows.ts createRun). Unlike `metadata`, an agent cannot
  // author this -- which is why merge provenance binds to it and not to metadata.
  working_path: string | null;
}

interface WorkflowEventRow {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_name: string | null;
  data: unknown;
  created_at: string;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (err) {
    log.warn(
      {
        err: err as Error,
        valueType: typeof value,
        valuePreview: typeof value === 'string' ? value.slice(0, 100) : String(value),
      },
      'db.metadata_parse_failed'
    );
    return {};
  }
}

function stringField(metadata: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function parseWoId(metadata: Record<string, unknown>, userMessage: string): string {
  return (
    stringField(metadata, ['woId', 'wo_id', 'WO_ID']) ??
    /\bWO-[A-Z0-9-]+\b/.exec(userMessage)?.[0] ??
    'unknown'
  );
}

/**
 * Read the run's repo identity, or report that it has none.
 *
 * This used to default to `bluedevilcollectibles/bdc-harness` whenever metadata was
 * silent -- which is the common case, not the rare one (zero of 563 live terminal runs
 * carried a repo key on 2026-07-28). A run against any other repo was therefore looked
 * up in the WRONG repo, and the resulting "no PR" was indistinguishable from a true
 * negative. Unknown identity is now unknown.
 *
 * A bare (slashless) value is still treated as a repo under the BDC org, which is the
 * one place a default is safe: the value was explicitly written by the run.
 */
function parseRepo(metadata: Record<string, unknown>): { owner?: string; repo?: string } {
  const target = stringField(metadata, ['targetRepo', 'target_repo', 'repository', 'repo'])?.trim();
  if (!target) return {};
  if (!target.includes('/')) return { owner: 'bluedevilcollectibles', repo: target };
  const [owner, repo] = target.split('/').slice(-2);
  if (!owner || !repo) return {};
  return { owner, repo };
}

function normalizeRun(row: WorkflowRunRow): OverseerWatchRun {
  const metadata = parseObject(row.metadata);
  const repo = parseRepo(metadata);
  return {
    id: row.id,
    woId: parseWoId(metadata, row.user_message),
    owner: repo.owner,
    repo: repo.repo,
    status: row.status,
    headBranch: stringField(metadata, ['headBranch', 'head_branch', 'branch']),
    workingPath: row.working_path ?? undefined,
    metadata,
  };
}

function normalizeEvent(row: WorkflowEventRow): OverseerWorkflowEventRow {
  return {
    id: row.id,
    workflow_run_id: row.workflow_run_id,
    event_type: row.event_type,
    step_name: row.step_name,
    data: parseObject(row.data),
    created_at: row.created_at,
  };
}

export async function listRunsForOverseerWatch(): Promise<OverseerWatchRun[]> {
  const result = await getDatabase().query<WorkflowRunRow>(
    `SELECT id, status, metadata, user_message, working_path
     FROM remote_agent_workflow_runs
     WHERE status IN ('completed', 'failed', 'escalated', 'cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM overseer_actions oa WHERE oa.run_id = remote_agent_workflow_runs.id
       )
     ORDER BY COALESCE(completed_at, last_activity_at, started_at) ASC`
  );
  return result.rows.map(normalizeRun);
}

interface OverseerEffectTimestampRow {
  last_effect_at: string | null;
}

interface OverseerPendingCountRow {
  pending_count: number | string;
}

export async function getOverseerLastActionAt(): Promise<string | null> {
  const result = await getDatabase().query<OverseerEffectTimestampRow>(
    'SELECT MAX(created_at) AS last_effect_at FROM overseer_actions'
  );
  return result.rows[0]?.last_effect_at ?? null;
}

export async function getOverseerLastVerdictAt(): Promise<string | null> {
  const result = await getDatabase().query<OverseerEffectTimestampRow>(
    'SELECT MAX(created_at) AS last_effect_at FROM overseer_verdicts'
  );
  return result.rows[0]?.last_effect_at ?? null;
}

export async function countRunsPendingOverseerJudgment(): Promise<number> {
  const result = await getDatabase().query<OverseerPendingCountRow>(
    `SELECT COUNT(*) AS pending_count
     FROM remote_agent_workflow_runs
     WHERE status IN ('completed', 'failed', 'escalated', 'cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM overseer_actions oa WHERE oa.run_id = remote_agent_workflow_runs.id
       )`
  );
  return Number(result.rows[0]?.pending_count ?? 0);
}

export async function listRunEventsForOverseer(runId: string): Promise<OverseerWorkflowEventRow[]> {
  const result = await getDatabase().query<WorkflowEventRow>(
    `SELECT id, workflow_run_id, event_type, step_name, data, created_at
     FROM remote_agent_workflow_events
     WHERE workflow_run_id = $1
     ORDER BY created_at ASC`,
    [runId]
  );
  return result.rows.map(normalizeEvent);
}

export async function insertOverseerAction(record: {
  runId: string;
  woId: string;
  class: string;
  action: string;
  result: string;
}): Promise<OverseerAction> {
  const db = getDatabase();
  const id = randomUUID();
  const inserted = await db.query<OverseerAction>(
    `INSERT INTO overseer_actions (id, run_id, wo_id, class, action, result)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, record.runId, record.woId, record.class, record.action, record.result]
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('Failed to insert overseer action');
  return row;
}

export async function getOverseerActionsForRun(runId: string): Promise<OverseerAction[]> {
  const result = await getDatabase().query<OverseerAction>(
    'SELECT * FROM overseer_actions WHERE run_id = $1 ORDER BY created_at ASC',
    [runId]
  );
  return [...result.rows];
}

/**
 * Judge-first verdict store (Motion M-99). Lifecycle statuses on a row:
 * 'claimed' (model call in flight), 'verdict' (semantic verdict stored), or one
 * of the retryable health-alarm states. Health states are operational alarms,
 * never semantic verdicts (binding term 2).
 */
export const OVERSEER_VERDICT_RETRYABLE_STATUSES = [
  'judge_unavailable',
  'judge_invalid_output',
  'evidence_unavailable',
] as const;

export interface OverseerVerdictRow {
  id: string;
  run_id: string;
  wo_id: string;
  head_sha: string;
  evidence_digest: string;
  status: string;
  verdict: string | null;
  confidence: number | null;
  model: string | null;
  model_rung: number | null;
  proposed_action: string | null;
  proposed_tier: number | null;
  required_tier: number | null;
  effective_tier: number | null;
  hint_action: string | null;
  hint_error_class: string | null;
  reason: string | null;
  evidence: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface OverseerVerdictClaim {
  claimed: boolean;
  verdictId?: string;
  retryCount?: number;
}

/**
 * Claim-before-call: atomically claim the (run_id, head_sha) verdict slot BEFORE
 * any model is invoked, so the 60s watch loop can never double-bill the same
 * evidence and replay never re-acts (M-99 binding term 6).
 *
 * A fresh slot is claimed by insert. A slot finalized into a retryable
 * health-alarm state may be re-claimed until maxRetries is exhausted. A slot
 * holding a semantic verdict (or an in-flight claim) is never re-claimed.
 */
export async function claimOverseerVerdict(input: {
  runId: string;
  woId: string;
  headSha?: string;
  hintAction?: string;
  hintErrorClass?: string;
  maxRetries?: number;
}): Promise<OverseerVerdictClaim> {
  const db = getDatabase();
  const id = randomUUID();
  const headSha = input.headSha ?? '';
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO overseer_verdicts (id, run_id, wo_id, head_sha, status, hint_action, hint_error_class)
     VALUES ($1, $2, $3, $4, 'claimed', $5, $6)
     ON CONFLICT (run_id, head_sha) DO NOTHING
     RETURNING id`,
    [id, input.runId, input.woId, headSha, input.hintAction ?? null, input.hintErrorClass ?? null]
  );
  if (inserted.rows[0]) {
    return { claimed: true, verdictId: inserted.rows[0].id, retryCount: 0 };
  }
  const maxRetries = input.maxRetries ?? 3;
  // SELECT-then-UPDATE rather than UPDATE ... RETURNING: the SQLite adapter
  // rejects RETURNING on UPDATE/DELETE, and production runs SQLite. The UPDATE
  // repeats the status/retry predicates so a concurrent re-claim cannot double
  // it -- rowCount 0 means another pass won, and we report the claim as lost.
  const existing = await db.query<{ id: string; retry_count: number }>(
    `SELECT id, retry_count FROM overseer_verdicts
     WHERE run_id = $1 AND head_sha = $2
       AND status IN ('judge_unavailable', 'judge_invalid_output', 'evidence_unavailable')
       AND retry_count < $3
     LIMIT 1`,
    [input.runId, headSha, maxRetries]
  );
  const row = existing.rows[0];
  if (!row) return { claimed: false };
  const nextRetry = row.retry_count + 1;
  const claimResult = await db.query(
    `UPDATE overseer_verdicts
     SET status = 'claimed', retry_count = $2, updated_at = $3
     WHERE id = $1 AND retry_count = $4
       AND status IN ('judge_unavailable', 'judge_invalid_output', 'evidence_unavailable')`,
    [row.id, nextRetry, new Date().toISOString(), row.retry_count]
  );
  if (claimResult.rowCount === 0) return { claimed: false };
  return { claimed: true, verdictId: row.id, retryCount: nextRetry };
}

/** Finalize a claimed verdict row with either a semantic verdict or a health-alarm state. */
export async function finalizeOverseerVerdict(input: {
  verdictId: string;
  status: string;
  verdict?: string;
  confidence?: number;
  model?: string;
  modelRung?: number;
  proposedAction?: string;
  proposedTier?: number;
  requiredTier?: number;
  effectiveTier?: number;
  reason?: string;
  evidenceDigest?: string;
  evidence?: string;
}): Promise<OverseerVerdictRow> {
  const db = getDatabase();
  // No RETURNING: the SQLite adapter rejects it on UPDATE, and this throw took
  // the whole watcher down in production on 2026-07-30 (the exception escaped
  // watchLoop and runOverseerService aborted every task). Read the row back
  // with a SELECT instead.
  await db.query(
    `UPDATE overseer_verdicts
     SET status = $2, verdict = $3, confidence = $4, model = $5, model_rung = $6,
         proposed_action = $7, proposed_tier = $8, required_tier = $9, effective_tier = $10,
         reason = $11, evidence_digest = COALESCE($12, evidence_digest),
         evidence = $13, updated_at = $14
     WHERE id = $1`,
    [
      input.verdictId,
      input.status,
      input.verdict ?? null,
      input.confidence ?? null,
      input.model ?? null,
      input.modelRung ?? null,
      input.proposedAction ?? null,
      input.proposedTier ?? null,
      input.requiredTier ?? null,
      input.effectiveTier ?? null,
      input.reason ?? null,
      input.evidenceDigest ?? null,
      input.evidence ?? null,
      new Date().toISOString(),
    ]
  );
  const readBack = await db.query<OverseerVerdictRow>(
    'SELECT * FROM overseer_verdicts WHERE id = $1',
    [input.verdictId]
  );
  const row = readBack.rows[0];
  if (!row) throw new Error(`overseer_verdict_finalize_missing_row:${input.verdictId}`);
  return row;
}

export async function getOverseerVerdictsForRun(runId: string): Promise<OverseerVerdictRow[]> {
  const result = await getDatabase().query<OverseerVerdictRow>(
    'SELECT * FROM overseer_verdicts WHERE run_id = $1 ORDER BY created_at ASC',
    [runId]
  );
  return [...result.rows];
}

export interface OverseerReconcileAction {
  id: string;
  pr_ref: string;
  wo_id: string;
  class: string;
  action: string;
  result: string;
  created_at: string;
}

/**
 * Records a reconcile duty (V1B) action. Reconcile actions fire off a merged
 * PR, not a remote_agent_workflow_runs row, so they cannot honor
 * overseer_actions.run_id's NOT NULL FK -- see overseer_reconcile_actions.
 * Do NOT route reconcile writes through insertOverseerAction.
 */
export async function insertReconcileAction(record: {
  prRef: string;
  woId: string;
  class: string;
  action: string;
  result: string;
}): Promise<OverseerReconcileAction> {
  const db = getDatabase();
  const id = randomUUID();
  const inserted = await db.query<OverseerReconcileAction>(
    `INSERT INTO overseer_reconcile_actions (id, pr_ref, wo_id, class, action, result)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, record.prRef, record.woId, record.class, record.action, record.result]
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('Failed to insert overseer reconcile action');
  return row;
}

export async function hasReconcileActionForPr(input: {
  prRef: string;
  woId: string;
  action: string;
}): Promise<boolean> {
  const result = await getDatabase().query<{ found: number }>(
    `SELECT 1 AS found
     FROM overseer_reconcile_actions
     WHERE pr_ref = $1 AND wo_id = $2 AND action = $3
     LIMIT 1`,
    [input.prRef, input.woId, input.action]
  );
  return result.rows.length > 0;
}
