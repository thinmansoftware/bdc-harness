import { randomUUID } from 'crypto';
import { createLogger } from '@archon/paths';
import { getDatabase } from './connection';

const log = createLogger('db/overseer');

export interface OverseerWatchRun {
  id: string;
  woId: string;
  repo: string;
  owner: string;
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

function parseRepo(metadata: Record<string, unknown>): { owner: string; repo: string } {
  const target = stringField(metadata, ['targetRepo', 'target_repo', 'repository', 'repo']) ?? '';
  const [owner, repo] = target.includes('/')
    ? target.split('/').slice(-2)
    : ['bluedevilcollectibles', target];
  return {
    owner: owner || 'bluedevilcollectibles',
    repo: repo || 'bdc-harness',
  };
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
