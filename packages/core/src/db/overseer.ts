import { randomUUID } from 'crypto';
import { createLogger } from '@archon/paths';
import { getDatabase } from './connection';

const log = createLogger('db/overseer');

/**
 * Run-id prefix for discovery-sourced PR verdicts (hand-opened spec/diary PRs).
 *
 * This MUST stay byte-for-byte in sync with PR_DISCOVERY_RUN_ID_PREFIX in
 * packages/overseer/src/merge-candidate-discovery.ts, which is the canonical
 * owner that mints these run ids and the value the merge-execution bridge parses
 * PR identity back out of. It is re-declared here rather than imported because
 * @archon/overseer depends on @archon/core (overseer/src/service.ts imports
 * claimOverseerVerdict from this module); importing the constant back would be a
 * circular workspace dependency and a layering inversion (core is the
 * foundational layer). The value is a fixed contract
 * (WO-HARNESS-DISCOVERY-VERDICT-RECORD-01 "keep the prefix"); any divergence
 * would break the discovery -> verdict -> bridge round-trip and be caught there.
 */
const DISCOVERY_RUN_ID_PREFIX = 'pr-discovery:';

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
  // Engine-written FK to remote_agent_codebases, set on every insert from the
  // resolved codebase binding (--project / prefix / target_repo). Joined to its
  // codebase name below because it is the AUTHORITATIVE repo identity: metadata
  // is agent-authorable and, in practice, never carries a repo key at all.
  codebase_name: string | null;
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
function parseRepoIdentifier(target: string | undefined): { owner?: string; repo?: string } {
  const value = target?.trim();
  if (!value) return {};
  if (!value.includes('/')) return { owner: 'bluedevilcollectibles', repo: value };
  const [owner, repo] = value.split('/').slice(-2);
  if (!owner || !repo) return {};
  return { owner, repo };
}

/**
 * Resolve repo identity, preferring the engine-written codebase FK over
 * agent-authorable metadata.
 *
 * Anchor: 2026-08-25 E2E merge canary (bdc-harness PR #705). Every terminal run
 * resolved to `unresolvableEvidence` in judgePullRequest -- which hard-requires
 * owner+repo -- so Overseer's PR lookup never ran, and the Merge Manager's
 * heartbeat reported eligible:0 on a PR that was CLEAN, APPROVED and MERGEABLE.
 * The cause was not missing identity: the canary's own run row carried
 * codebase_id -> 'thinmansoftware/bdc-harness' correctly the whole time. This
 * query simply never selected it, and fell back to a metadata key that (per the
 * note above) no run has ever written.
 */
function parseRepo(
  metadata: Record<string, unknown>,
  codebaseName: string | null
): { owner?: string; repo?: string } {
  const fromCodebase = parseRepoIdentifier(codebaseName ?? undefined);
  if (fromCodebase.owner && fromCodebase.repo) return fromCodebase;
  return parseRepoIdentifier(
    stringField(metadata, ['targetRepo', 'target_repo', 'repository', 'repo'])
  );
}

function normalizeRun(row: WorkflowRunRow): OverseerWatchRun {
  const metadata = parseObject(row.metadata);
  const repo = parseRepo(metadata, row.codebase_name ?? null);
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

/**
 * A run is excluded from future watch cycles only once it has a TERMINAL
 * overseer_actions row -- one that reflects a permanent, unchangeable
 * disposition (a completed merge). Every other recorded action
 * (verdict_write, merge_denied, merge_failed, tier_refused,
 * escalation_denied, escalate_with_evidence, comment_findings) describes a
 * snapshot of state that can change afterward -- CI can finish, a review
 * can post, a retry can succeed -- and must not permanently lock the run
 * out of re-evaluation.
 *
 * Anchor: 2026-08-25 E2E merge canary (WO-HARNESS-E2E-MERGE-CANARY-01,
 * bdc-harness PR #705). The judge wrote a provisional `verdict_write` before
 * CI had finished; the old `NOT EXISTS (... any row ...)` predicate excluded
 * the run forever, so it never got picked up again even after CI went green
 * and the PR was approved. The Merge Manager's own heartbeat stayed
 * eligible:0 for 30+ minutes on a fully mergeable PR.
 */
const TERMINAL_OVERSEER_ACTIONS = [
  'merged', // merge manager executed -- permanently done
  'watch_closed', // judged with a resolved lookup and nothing actionable -- done
  'escalate_with_evidence', // escalation posted once -- human owns it now
  'escalation_denied',
  'tier_refused',
  'comment_findings',
] as const;

export async function listRunsForOverseerWatch(): Promise<OverseerWatchRun[]> {
  const placeholders = TERMINAL_OVERSEER_ACTIONS.map(() => '?').join(', ');
  const result = await getDatabase().query<WorkflowRunRow>(
    `SELECT r.id, r.status, r.metadata, r.user_message, r.working_path,
            c.name AS codebase_name
     FROM remote_agent_workflow_runs r
     LEFT JOIN remote_agent_codebases c ON c.id = r.codebase_id
     WHERE r.status IN ('completed', 'failed', 'escalated', 'cancelled')
       -- Synthetic discovery-PR parent rows (workflow_name = 'pr-discovery') are
       -- not real work: excluding them keeps the watch loop from re-judging a
       -- hand-opened PR that already has its own verdict recorded directly.
       AND r.workflow_name != 'pr-discovery'
       AND NOT EXISTS (
         SELECT 1 FROM overseer_actions oa
         WHERE oa.run_id = r.id
           AND oa.action IN (${placeholders})
       )
     ORDER BY COALESCE(r.completed_at, r.last_activity_at, r.started_at) ASC`,
    [...TERMINAL_OVERSEER_ACTIONS]
  );
  return result.rows.map(normalizeRun);
}

export async function getOverseerWatchRunById(runId: string): Promise<OverseerWatchRun | null> {
  // Same codebase JOIN as listRunsForOverseerWatch. Without it codebase_name is
  // never selected, parseRepo falls back to metadata (which no run writes), and
  // the merge-execution bridge skips every run-backed verdict as
  // run_context_unresolvable (bdc-harness #846: 141 skipped, 0 merged).
  const result = await getDatabase().query<WorkflowRunRow>(
    `SELECT r.id, r.status, r.metadata, r.user_message, r.working_path,
            c.name AS codebase_name
     FROM remote_agent_workflow_runs r
     LEFT JOIN remote_agent_codebases c ON c.id = r.codebase_id
     WHERE r.id = $1`,
    [runId]
  );
  return result.rows[0] ? normalizeRun(result.rows[0]) : null;
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
       -- Exclude synthetic discovery-PR parent rows so backlog metrics are not
       -- inflated forever (they never receive an overseer_actions row this path).
       AND workflow_name != 'pr-discovery'
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
  actioned_at: string | null;
  mutation_sent: boolean | number | null;
  action_reason: string | null;
  merge_sha: string | null;
  pr_url: string | null;
}

export async function listUnactionedFlagMergeReadyVerdicts(): Promise<OverseerVerdictRow[]> {
  const result = await getDatabase().query<OverseerVerdictRow>(
    `SELECT * FROM overseer_verdicts
     WHERE proposed_action = 'flag_merge_ready' AND actioned_at IS NULL
     ORDER BY created_at ASC`
  );
  return [...result.rows];
}

export async function countRecentOverseerVerdictMerges(since: string): Promise<number> {
  const result = await getDatabase().query<{ merge_count: number | string }>(
    `SELECT COUNT(*) AS merge_count FROM overseer_verdicts
     WHERE mutation_sent = true AND actioned_at >= $1`,
    [since]
  );
  return Number(result.rows[0]?.merge_count ?? 0);
}

export async function reserveOverseerMergeSlot(
  verdictId: string,
  since: string,
  limit: number
): Promise<boolean> {
  const db = getDatabase();
  const now = new Date().toISOString();
  return db.withTransaction(async query => {
    const locked = await query('UPDATE overseer_merge_slot_lock SET id = 1 WHERE id = 1');
    if (locked.rowCount !== 1) {
      throw new Error('overseer_merge_slot_lock_missing');
    }
    const occupiedResult = await query<{ occupied: number | string }>(
      `SELECT COUNT(*) AS occupied FROM (
         SELECT verdict_id AS slot_key FROM overseer_merge_slot_reservations
         WHERE reserved_at >= $1 AND released_at IS NULL
         UNION
         SELECT id FROM overseer_verdicts
         WHERE mutation_sent = true AND actioned_at >= $1
       ) slots`,
      [since]
    );
    const occupied = Number(occupiedResult.rows[0]?.occupied ?? 0);
    if (!Number.isFinite(occupied) || occupied >= limit) return false;
    // Revival of a released row succeeds (rowCount 1). An active reservation
    // for the same verdict is a no-op (rowCount 0); the bridge never re-reserves
    // an active slot.
    const inserted = await query(
      `INSERT INTO overseer_merge_slot_reservations (id, verdict_id, reserved_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (verdict_id) DO UPDATE SET
         reserved_at = excluded.reserved_at,
         released_at = NULL
       WHERE overseer_merge_slot_reservations.released_at IS NOT NULL`,
      [randomUUID(), verdictId, now]
    );
    return inserted.rowCount === 1;
  });
}

export async function releaseOverseerMergeSlot(verdictId: string): Promise<void> {
  await getDatabase().query(
    `UPDATE overseer_merge_slot_reservations
     SET released_at = $2
     WHERE verdict_id = $1 AND released_at IS NULL`,
    [verdictId, new Date().toISOString()]
  );
}

export async function claimVerdictForMergeExecution(verdictId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await getDatabase().query(
    `UPDATE overseer_verdicts
     SET actioned_at = $2, mutation_sent = false, action_reason = 'processing', updated_at = $2
     WHERE id = $1 AND actioned_at IS NULL`,
    [verdictId, now]
  );
  return result.rowCount === 1;
}

export async function releaseVerdictClaimForMergeExecution(
  verdictId: string,
  _reason: string
): Promise<boolean> {
  const result = await getDatabase().query(
    `UPDATE overseer_verdicts
     SET actioned_at = NULL, mutation_sent = NULL, action_reason = NULL, updated_at = $2
     WHERE id = $1 AND actioned_at IS NOT NULL AND action_reason = 'processing'`,
    [verdictId, new Date().toISOString()]
  );
  return result.rowCount === 1;
}

export async function recordVerdictMergeOutcome(input: {
  verdictId: string;
  mutationSent: boolean;
  reason: string;
  mergeSha?: string;
  prUrl?: string;
}): Promise<OverseerVerdictRow> {
  const db = getDatabase();
  const updated = await db.query(
    `UPDATE overseer_verdicts
     SET mutation_sent = $2, action_reason = $3,
         merge_sha = $4, pr_url = $5, updated_at = $6
     WHERE id = $1 AND actioned_at IS NOT NULL AND action_reason = 'processing'`,
    [
      input.verdictId,
      input.mutationSent,
      input.reason,
      input.mergeSha ?? null,
      input.prUrl ?? null,
      new Date().toISOString(),
    ]
  );
  if (updated.rowCount !== 1) {
    throw new Error(`overseer_verdict_outcome_not_recorded:${input.verdictId}`);
  }
  const result = await db.query<OverseerVerdictRow>(
    'SELECT * FROM overseer_verdicts WHERE id = $1',
    [input.verdictId]
  );
  const row = result.rows[0];
  if (!row) throw new Error(`overseer_verdict_merge_outcome_missing_row:${input.verdictId}`);
  return row;
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
/**
 * Idempotently ensure the synthetic parent rows a discovery-PR verdict FKs to.
 *
 * `overseer_verdicts.run_id` has a NOT NULL FK to remote_agent_workflow_runs, but
 * discovery-sourced PRs (runId `pr-discovery:<owner>/<repo>#<n>`) are hand-opened
 * PRs with no workflow run -- so every claimOverseerVerdict for one previously
 * threw SQLITE_CONSTRAINT_FOREIGNKEY and no discovery verdict was ever recorded
 * (bdc-xo#2208: 0 rows table-wide, 500 FK errors in 3h).
 *
 * On SQLite (the production dialect) remote_agent_workflow_runs.conversation_id
 * is itself NOT NULL with an FK to remote_agent_conversations, so we ensure a
 * synthetic conversation first, then the run. Both inserts are deterministic from
 * runId and idempotent (ON CONFLICT (id) DO NOTHING), so a replay at the same head
 * leaves exactly one conversation and one run row.
 *
 * The run is TERMINAL ('completed') so the rebuild inflight guard
 * (status IN ('pending','running')), dashboards and backlog counts never treat it
 * as live work. It carries workflow_name = 'pr-discovery' so the watch loop and
 * pending-judgment count exclude it by name (see listRunsForOverseerWatch and
 * countRunsPendingOverseerJudgment); user_message is the runId, never a WO token,
 * so WO-substring run scans do not collide with it.
 */
export async function ensureDiscoveryRunRow(runId: string): Promise<void> {
  const db = getDatabase();
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, title)
     VALUES ($1, 'pr-discovery', $1, 'PR discovery')
     ON CONFLICT (id) DO NOTHING`,
    [runId]
  );
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, workflow_name, user_message, status, completed_at)
     VALUES ($1, $1, 'pr-discovery', $1, 'completed', $2)
     ON CONFLICT (id) DO NOTHING`,
    [runId, new Date().toISOString()]
  );
}

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
  // Discovery-sourced PRs have no workflow run; mint the synthetic terminal
  // parent row before the FK'd verdict insert so it does not throw.
  if (input.runId.startsWith(DISCOVERY_RUN_ID_PREFIX)) {
    await ensureDiscoveryRunRow(input.runId);
  }
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
  prUrl?: string;
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
         evidence = $13, pr_url = COALESCE($14, pr_url), updated_at = $15
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
      input.prUrl ?? null,
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
