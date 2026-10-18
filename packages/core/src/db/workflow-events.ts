/**
 * Database operations for workflow events (lean UI-relevant events).
 *
 * Stores step transitions, parallel agent status, artifacts, and errors.
 * Verbose assistant/tool content stays in JSONL logs only.
 *
 * All write operations use fire-and-forget pattern (catch + log, never throw)
 * because workflow execution must not fail due to event logging.
 * Read operations also throw on error -- callers own the degradation policy.
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflow-events');
  return cachedLog;
}

export interface WorkflowEventRow {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_index: number | null;
  step_name: string | null;
  /** Normalized to object -- SQLite returns JSON as string, PG returns object. */
  data: Record<string, unknown>;
  created_at: string;
}

function normalizeWorkflowEvent(row: WorkflowEventRow): WorkflowEventRow {
  return {
    ...row,
    data:
      typeof row.data === 'string'
        ? ((): Record<string, unknown> => {
            try {
              const parsed: unknown = JSON.parse(row.data);
              return parsed && typeof parsed === 'object'
                ? (parsed as Record<string, unknown>)
                : { value: parsed };
            } catch {
              return { raw: row.data };
            }
          })()
        : row.data && typeof row.data === 'object'
          ? row.data
          : {},
  };
}

export async function createDurableWorkflowEvent(data: {
  workflow_run_id: string;
  event_type: string;
  step_index?: number;
  step_name?: string;
  data?: Record<string, unknown>;
}): Promise<WorkflowEventRow> {
  const dialect = getDialect();
  const id = dialect.generateUuid();
  const result = await pool.query<WorkflowEventRow>(
    `INSERT INTO remote_agent_workflow_events
       (id, workflow_run_id, event_type, step_index, step_name, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      id,
      data.workflow_run_id,
      data.event_type,
      data.step_index ?? null,
      data.step_name ?? null,
      JSON.stringify(data.data ?? {}),
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('durable_workflow_event_insert_failed');
  return normalizeWorkflowEvent(row);
}

/**
 * Create a workflow event. Fire-and-forget - never throws.
 */
export async function createWorkflowEvent(data: {
  workflow_run_id: string;
  event_type: string;
  step_index?: number;
  step_name?: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  try {
    await createDurableWorkflowEvent(data);
  } catch (error) {
    getLog().error(
      { err: error as Error, eventType: data.event_type, runId: data.workflow_run_id },
      'db.workflow_event_create_failed'
    );
    // Fire-and-forget: never throw
  }
}

/**
 * List all events for a workflow run, ordered by creation time.
 */
export async function listWorkflowEvents(workflowRunId: string): Promise<WorkflowEventRow[]> {
  try {
    const result = await pool.query<WorkflowEventRow>(
      `SELECT * FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1
       ORDER BY created_at ASC`,
      [workflowRunId]
    );
    return [...result.rows].map(normalizeWorkflowEvent);
  } catch (error) {
    getLog().error({ err: error as Error, runId: workflowRunId }, 'db.workflow_events_list_failed');
    throw new Error(`Failed to list workflow events: ${(error as Error).message}`);
  }
}

/**
 * List recent events for a single node in a workflow run, newest first.
 *
 * Used by the node peek side panel to show the latest activity for a node.
 * Caller can reverse the array if chronological order is required.
 */
export async function listNodeEvents(
  workflowRunId: string,
  stepName: string,
  limit: number
): Promise<WorkflowEventRow[]> {
  try {
    const result = await pool.query<WorkflowEventRow>(
      `SELECT * FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1 AND step_name = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [workflowRunId, stepName, limit]
    );
    return [...result.rows].map(row => ({
      ...row,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    }));
  } catch (error) {
    getLog().error(
      { err: error as Error, runId: workflowRunId, stepName },
      'db.workflow_node_events_list_failed'
    );
    throw new Error(`Failed to list node events: ${(error as Error).message}`);
  }
}

/**
 * List recent events for a workflow run since a given timestamp.
 */
export async function listRecentEvents(
  workflowRunId: string,
  since?: Date
): Promise<WorkflowEventRow[]> {
  try {
    if (since) {
      const result = await pool.query<WorkflowEventRow>(
        `SELECT * FROM remote_agent_workflow_events
         WHERE workflow_run_id = $1 AND created_at > $2
         ORDER BY created_at ASC`,
        [workflowRunId, since.toISOString()]
      );
      return [...result.rows].map(row => ({
        ...row,
        data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
      }));
    }
    return await listWorkflowEvents(workflowRunId);
  } catch (error) {
    getLog().error(
      { err: error as Error, runId: workflowRunId },
      'db.workflow_events_list_recent_failed'
    );
    throw new Error(`Failed to list recent workflow events: ${(error as Error).message}`);
  }
}

/**
 * Return a map of nodeId -> output for all node_completed events in a workflow run.
 * Used by the DAG executor to restore node outputs when resuming a failed run.
 * Throws on DB error -- caller owns the degradation policy.
 */
export interface OriginatingPullRequestRun {
  runId: string;
  workflowName: string;
  userMessage: string;
  workingPath: string;
}

/**
 * Newest Cauldron feature-lane run that opened this exact pull request URL.
 *
 * A URL is not a prefix match: /pull/91 does not match an event that only
 * names /pull/914. The trailing character must be absent or not a digit.
 */
export async function findOriginatingRunForPullRequest(
  prUrl: string
): Promise<OriginatingPullRequestRun | null> {
  const result = await pool.query<{
    run_id: string;
    workflow_name: string;
    user_message: string;
    working_path: string;
    data: string | Record<string, unknown>;
  }>(
    `SELECT r.id AS run_id, r.workflow_name, r.user_message, r.working_path, e.data AS data
     FROM remote_agent_workflow_runs r
     INNER JOIN remote_agent_workflow_events e ON e.workflow_run_id = r.id
     WHERE r.working_path IS NOT NULL
       AND TRIM(r.working_path) <> ''
       AND r.workflow_name LIKE $1
       AND e.event_type = $2
       AND e.step_name = $3
       AND CAST(e.data AS TEXT) LIKE $4
     ORDER BY r.started_at DESC`,
    ['bdc-feature-development%', 'node_completed', 'open-pr-if-needed', `%${prUrl}%`]
  );
  for (const row of result.rows) {
    const dataText = typeof row.data === 'string' ? row.data : JSON.stringify(row.data);
    if (!containsExactPullUrl(dataText, prUrl)) continue;
    return {
      runId: row.run_id,
      workflowName: row.workflow_name,
      userMessage: row.user_message,
      workingPath: row.working_path,
    };
  }
  return null;
}

function containsExactPullUrl(dataText: string, prUrl: string): boolean {
  let from = 0;
  while (from <= dataText.length) {
    const at = dataText.indexOf(prUrl, from);
    if (at < 0) return false;
    const next = dataText.charAt(at + prUrl.length);
    if (next === '' || !/[0-9]/.test(next)) return true;
    from = at + prUrl.length;
  }
  return false;
}

export async function getCompletedDagNodeOutputs(
  workflowRunId: string
): Promise<Map<string, string>> {
  const result = await pool.query<{
    step_name: string | null;
    data: string | Record<string, unknown>;
  }>(
    `SELECT step_name, data FROM remote_agent_workflow_events
     WHERE workflow_run_id = $1 AND event_type = 'node_completed'
     ORDER BY created_at ASC`,
    [workflowRunId]
  );
  const outputs = new Map<string, string>();
  for (const row of result.rows) {
    if (!row.step_name) continue;
    let data: Record<string, unknown>;
    try {
      data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch (parseErr) {
      getLog().warn(
        { err: parseErr as Error, runId: workflowRunId, stepName: row.step_name },
        'db.workflow_dag_node_output_parse_failed'
      );
      continue;
    }
    if (typeof data.node_output === 'string') {
      outputs.set(row.step_name, data.node_output);
    }
  }
  return outputs;
}
