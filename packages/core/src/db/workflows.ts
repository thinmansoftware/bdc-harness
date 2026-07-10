/**
 * Database operations for workflow runs
 */
import { pool, getDatabase, getDialect, getDatabaseType } from './connection';
import type { IDatabase } from './adapters/types';
import type {
  WorkflowRun,
  WorkflowRunStatus,
  ApprovalContext,
} from '@archon/workflows/schemas/workflow-run';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import type {
  ExecutionCapability,
  ExpiredRunLeaseRecord,
  ProviderAttemptOutcomeClass,
  ProviderAttemptRecord,
  RunAuthorityRecord,
  RunLeaseRecord,
  RunOutcome,
  ScheduledProviderWaitRecord,
  SupervisorActionRecord,
  SupervisorIncidentRecord,
  SupervisorObservationRecord,
  SupervisorRepairLeaseRecord,
  TerminalWorkflowPersistence,
} from '@archon/workflows/reliability/types';
import { createLogger } from '@archon/paths';

/** Best-effort ROLLBACK -- log but swallow errors since we're already in an error path. */
function rollback(): Promise<void> {
  return pool.query('ROLLBACK', []).then(
    () => undefined,
    rollbackErr => {
      getLog().warn({ err: rollbackErr as Error }, 'db.rollback_failed');
    }
  );
}

/** Guard error for deleteWorkflowRun -- re-thrown without wrapping in the outer catch. */
class WorkflowRunGuardError extends Error {}

/**
 * Normalize a WorkflowRun row from the database.
 * SQLite stores metadata as TEXT (JSON string), PostgreSQL returns parsed objects.
 * This ensures metadata is always a parsed object regardless of database backend.
 */
function normalizeWorkflowRun<T extends WorkflowRun>(row: T): T {
  if (typeof row.metadata === 'string') {
    try {
      row.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      row.metadata = {};
    }
  }
  return row;
}

type DbTimestamp = string | Date;

interface RunAuthorityRow {
  run_id: string;
  dispatch_id: string;
  wo_id: string;
  spec_source: string;
  spec_revision: string;
  spec_hash: string;
  workflow_name: string;
  codebase_id: string;
  canonical_remote: string;
  base_branch: string;
  base_sha: string;
  run_scope_sha: string;
  head_branch: string;
  worktree_path: string;
  workflow_revision: string;
  bundle_revision: string;
  engine_revision: string;
  runtime_image_revision: string | null;
  created_at: DbTimestamp;
}

interface RunLeaseRow {
  run_id: string;
  owner_id: string;
  lease_token: string;
  acquired_at: DbTimestamp;
  last_heartbeat_at: DbTimestamp;
  expires_at: DbTimestamp;
  released_at: DbTimestamp | null;
}

interface SupervisorIncidentRow {
  incident_id: string;
  incident_key: string;
  run_id: string;
  wo_id: string;
  status: SupervisorIncidentRecord['status'];
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

interface SupervisorObservationRow {
  observation_id: string;
  incident_id: string;
  supervisor_id: string;
  assessment: string;
  evidence_refs: unknown;
  created_at: DbTimestamp;
}

interface SupervisorRepairLeaseRow {
  incident_id: string;
  owner_id: string;
  fencing_token: number | string;
  acquired_at: DbTimestamp;
  last_heartbeat_at: DbTimestamp;
  expires_at: DbTimestamp;
  released_at: DbTimestamp | null;
}

interface ProviderAttemptRow {
  attempt_id: string;
  run_id: string;
  node_id: string;
  attempt_number: number;
  provider: string;
  model: string;
  declared_provider: string;
  declared_model: string;
  required_capabilities: unknown;
  started_at: DbTimestamp;
  completed_at: DbTimestamp | null;
  served_model_id: string | null;
  outcome_class: ProviderAttemptOutcomeClass | null;
  reason_code: ProviderAttemptRecord['reasonCode'];
  resume_at: DbTimestamp | null;
  supersedes_attempt_id: string | null;
}

interface RunOutcomeRow {
  execution_state: RunOutcome['executionState'];
  deliverable_state: RunOutcome['deliverableState'];
  validation_state: RunOutcome['validationState'];
  recovery_state: RunOutcome['recoveryState'];
  route_state: RunOutcome['routeState'];
  primary_reason: RunOutcome['primaryReason'];
  reason_codes: unknown;
  evidence_refs: unknown;
}

interface ScheduledProviderWaitRow {
  wait_id: string;
  run_id: string;
  attempt_id: string;
  provider: string;
  reason_code: ScheduledProviderWaitRecord['reasonCode'];
  resume_at: DbTimestamp;
  state: ScheduledProviderWaitRecord['state'];
  claim_owner_id: string | null;
  claim_token: string | null;
  created_at: DbTimestamp;
  claimed_at: DbTimestamp | null;
  cancelled_at: DbTimestamp | null;
  completed_at: DbTimestamp | null;
}

function normalizeTimestamp(value: DbTimestamp): string {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeNullableTimestamp(value: DbTimestamp | null): string | null {
  return value === null ? null : normalizeTimestamp(value);
}

function normalizeSupervisorIncident(row: SupervisorIncidentRow): SupervisorIncidentRecord {
  return {
    incidentId: row.incident_id,
    incidentKey: row.incident_key,
    runId: row.run_id,
    woId: row.wo_id,
    status: row.status,
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
  };
}

function normalizeSupervisorObservation(
  row: SupervisorObservationRow
): SupervisorObservationRecord {
  return {
    observationId: row.observation_id,
    incidentId: row.incident_id,
    supervisorId: row.supervisor_id,
    assessment: row.assessment,
    evidenceRefs: parseJsonArray<string>(row.evidence_refs),
    createdAt: normalizeTimestamp(row.created_at),
  };
}

function normalizeSupervisorRepairLease(
  row: SupervisorRepairLeaseRow
): SupervisorRepairLeaseRecord {
  return {
    incidentId: row.incident_id,
    ownerId: row.owner_id,
    fencingToken: Number(row.fencing_token),
    acquiredAt: normalizeTimestamp(row.acquired_at),
    lastHeartbeatAt: normalizeTimestamp(row.last_heartbeat_at),
    expiresAt: normalizeTimestamp(row.expires_at),
    releasedAt: normalizeNullableTimestamp(row.released_at),
  };
}

function parseJsonArray<T extends string>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function normalizeRunAuthority(row: RunAuthorityRow): RunAuthorityRecord {
  return {
    runId: row.run_id,
    dispatchId: row.dispatch_id,
    woId: row.wo_id,
    specSource: row.spec_source,
    specRevision: row.spec_revision,
    specHash: row.spec_hash,
    workflowName: row.workflow_name,
    codebaseId: row.codebase_id,
    canonicalRemote: row.canonical_remote,
    baseBranch: row.base_branch,
    baseSha: row.base_sha,
    runScopeSha: row.run_scope_sha,
    headBranch: row.head_branch,
    worktreePath: row.worktree_path,
    workflowRevision: row.workflow_revision,
    bundleRevision: row.bundle_revision,
    engineRevision: row.engine_revision,
    runtimeImageRevision: row.runtime_image_revision,
    createdAt: normalizeTimestamp(row.created_at),
  };
}

function runAuthoritiesEqual(left: RunAuthorityRecord, right: RunAuthorityRecord): boolean {
  const keys = Object.keys(left) as (keyof RunAuthorityRecord)[];
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
}

function normalizeRunLease(row: RunLeaseRow): RunLeaseRecord {
  return {
    runId: row.run_id,
    ownerId: row.owner_id,
    leaseToken: row.lease_token,
    acquiredAt: normalizeTimestamp(row.acquired_at),
    lastHeartbeatAt: normalizeTimestamp(row.last_heartbeat_at),
    expiresAt: normalizeTimestamp(row.expires_at),
    releasedAt: normalizeNullableTimestamp(row.released_at),
  };
}

function normalizeProviderAttempt(row: ProviderAttemptRow): ProviderAttemptRecord {
  return {
    attemptId: row.attempt_id,
    runId: row.run_id,
    nodeId: row.node_id,
    attemptNumber: row.attempt_number,
    provider: row.provider,
    model: row.model,
    declaredProvider: row.declared_provider,
    declaredModel: row.declared_model,
    requiredCapabilities: parseJsonArray<ExecutionCapability>(row.required_capabilities),
    startedAt: normalizeTimestamp(row.started_at),
    completedAt: normalizeNullableTimestamp(row.completed_at),
    servedModelId: row.served_model_id,
    outcomeClass: row.outcome_class,
    reasonCode: row.reason_code,
    resumeAt: normalizeNullableTimestamp(row.resume_at),
    supersedesAttemptId: row.supersedes_attempt_id,
  };
}

function normalizeRunOutcome(row: RunOutcomeRow): RunOutcome {
  return {
    executionState: row.execution_state,
    deliverableState: row.deliverable_state,
    validationState: row.validation_state,
    recoveryState: row.recovery_state,
    routeState: row.route_state,
    primaryReason: row.primary_reason,
    reasonCodes: parseJsonArray<RunOutcome['primaryReason']>(row.reason_codes),
    evidenceRefs: parseJsonArray<string>(row.evidence_refs),
  };
}

function runOutcomesEqual(left: RunOutcome, right: RunOutcome): boolean {
  return (
    left.executionState === right.executionState &&
    left.deliverableState === right.deliverableState &&
    left.validationState === right.validationState &&
    left.recoveryState === right.recoveryState &&
    left.routeState === right.routeState &&
    left.primaryReason === right.primaryReason &&
    left.reasonCodes.length === right.reasonCodes.length &&
    left.reasonCodes.every((value, index) => value === right.reasonCodes[index]) &&
    left.evidenceRefs.length === right.evidenceRefs.length &&
    left.evidenceRefs.every((value, index) => value === right.evidenceRefs[index])
  );
}

function normalizeScheduledProviderWait(
  row: ScheduledProviderWaitRow
): ScheduledProviderWaitRecord {
  return {
    waitId: row.wait_id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    provider: row.provider,
    reasonCode: row.reason_code,
    resumeAt: normalizeTimestamp(row.resume_at),
    state: row.state,
    claimOwnerId: row.claim_owner_id,
    claimToken: row.claim_token,
    createdAt: normalizeTimestamp(row.created_at),
    claimedAt: normalizeNullableTimestamp(row.claimed_at),
    cancelledAt: normalizeNullableTimestamp(row.cancelled_at),
    completedAt: normalizeNullableTimestamp(row.completed_at),
  };
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflows');
  return cachedLog;
}

export async function createWorkflowRun(data: {
  workflow_name: string;
  conversation_id: string;
  codebase_id?: string;
  user_message: string;
  metadata?: Record<string, unknown>;
  working_path?: string;
  parent_conversation_id?: string;
}): Promise<WorkflowRun> {
  // Serialize metadata with validation to catch circular references early
  let metadataJson: string;
  try {
    metadataJson = JSON.stringify(data.metadata ?? {});
  } catch (serializeError) {
    const err = serializeError as Error;

    // Check if metadata contains critical context that must not be silently lost
    if (data.metadata && 'github_context' in data.metadata) {
      // Critical context (e.g., GitHub issue/PR details) must not be silently discarded.
      // Failing here surfaces the problem to the user instead of running the workflow
      // with empty context variables ($CONTEXT, $EXTERNAL_CONTEXT, $ISSUE_CONTEXT).
      getLog().error(
        { err, metadataKeys: Object.keys(data.metadata) },
        'db.workflow_run_metadata_serialize_failed'
      );
      throw new Error(
        `Failed to serialize workflow metadata: ${err.message}. ` +
          'Metadata contains github_context which is required for this workflow.'
      );
    }

    // Non-critical metadata: fall back to empty object and log warning
    getLog().warn(
      { err, metadataKeys: data.metadata ? Object.keys(data.metadata) : [] },
      'db.workflow_run_metadata_serialize_fallback'
    );
    metadataJson = '{}';
  }

  try {
    const result = await pool.query<WorkflowRun>(
      `INSERT INTO remote_agent_workflow_runs
       (workflow_name, conversation_id, codebase_id, user_message, metadata, working_path, parent_conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.workflow_name,
        data.conversation_id,
        data.codebase_id ?? null,
        data.user_message,
        metadataJson,
        data.working_path ?? null,
        data.parent_conversation_id ?? null,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `Failed to create workflow run: INSERT returned no rows (workflow: ${data.workflow_name})`
      );
    }
    return normalizeWorkflowRun(row);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_create_failed');
    throw new Error(`Failed to create workflow run: ${err.message}`);
  }
}

export async function getWorkflowRun(id: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_failed');
    throw new Error(`Failed to get workflow run: ${err.message}`);
  }
}

/** Insert the immutable authority record, accepting only a byte-equivalent retry. */
export async function createRunAuthority(
  authority: RunAuthorityRecord
): Promise<'created' | 'unchanged'> {
  const result = await pool.query<RunAuthorityRow>(
    `INSERT INTO remote_agent_run_authorities
     (run_id, dispatch_id, wo_id, spec_source, spec_revision, spec_hash,
      workflow_name, codebase_id, canonical_remote, base_branch, base_sha,
      run_scope_sha, head_branch, worktree_path, workflow_revision, bundle_revision,
      engine_revision, runtime_image_revision, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, $19)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      authority.runId,
      authority.dispatchId,
      authority.woId,
      authority.specSource,
      authority.specRevision,
      authority.specHash,
      authority.workflowName,
      authority.codebaseId,
      authority.canonicalRemote,
      authority.baseBranch,
      authority.baseSha,
      authority.runScopeSha,
      authority.headBranch,
      authority.worktreePath,
      authority.workflowRevision,
      authority.bundleRevision,
      authority.engineRevision,
      authority.runtimeImageRevision,
      authority.createdAt,
    ]
  );
  if (result.rows[0]) return 'created';

  const existing = await getRunAuthority(authority.runId);
  if (existing && runAuthoritiesEqual(existing, authority)) return 'unchanged';
  const existingDispatch = await getRunAuthorityByDispatchId(authority.dispatchId);
  if (existingDispatch && existingDispatch.runId !== authority.runId) {
    throw new Error(
      `dispatch_conflict: dispatch ${authority.dispatchId} already belongs to run ${existingDispatch.runId}`
    );
  }
  throw new Error(`authority_conflict: immutable authority differs for run ${authority.runId}`);
}

async function getRunAuthorityByDispatchId(dispatchId: string): Promise<RunAuthorityRecord | null> {
  const result = await pool.query<RunAuthorityRow>(
    'SELECT * FROM remote_agent_run_authorities WHERE dispatch_id = $1',
    [dispatchId]
  );
  const row = result.rows[0];
  return row ? normalizeRunAuthority(row) : null;
}

export async function getRunAuthority(runId: string): Promise<RunAuthorityRecord | null> {
  const result = await pool.query<RunAuthorityRow>(
    'SELECT * FROM remote_agent_run_authorities WHERE run_id = $1',
    [runId]
  );
  const row = result.rows[0];
  return row ? normalizeRunAuthority(row) : null;
}

/**
 * Claim a lease in one compare-and-swap statement.
 * A live unreleased lease cannot be overwritten by another worker.
 */
export async function claimRunLease(lease: RunLeaseRecord): Promise<RunLeaseRecord | null> {
  const result = await pool.query<RunLeaseRow>(
    `INSERT INTO remote_agent_run_leases
     (run_id, owner_id, lease_token, acquired_at, last_heartbeat_at, expires_at, released_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL)
     ON CONFLICT (run_id) DO UPDATE SET
       owner_id = EXCLUDED.owner_id,
       lease_token = EXCLUDED.lease_token,
       acquired_at = EXCLUDED.acquired_at,
       last_heartbeat_at = EXCLUDED.last_heartbeat_at,
       expires_at = EXCLUDED.expires_at,
       released_at = NULL
     WHERE remote_agent_run_leases.released_at IS NOT NULL
        OR remote_agent_run_leases.expires_at <= EXCLUDED.acquired_at
     RETURNING *`,
    [
      lease.runId,
      lease.ownerId,
      lease.leaseToken,
      lease.acquiredAt,
      lease.lastHeartbeatAt,
      lease.expiresAt,
    ]
  );
  const row = result.rows[0];
  return row ? normalizeRunLease(row) : null;
}

export async function heartbeatRunLease(data: {
  runId: string;
  ownerId: string;
  leaseToken: string;
  heartbeatAt: string;
  expiresAt: string;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE remote_agent_run_leases
     SET last_heartbeat_at = $4, expires_at = $5
     WHERE run_id = $1 AND owner_id = $2 AND lease_token = $3
       AND released_at IS NULL AND expires_at > $4`,
    [data.runId, data.ownerId, data.leaseToken, data.heartbeatAt, data.expiresAt]
  );
  return result.rowCount === 1;
}

export async function releaseRunLease(data: {
  runId: string;
  ownerId: string;
  leaseToken: string;
  releasedAt: string;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE remote_agent_run_leases
     SET released_at = $4
     WHERE run_id = $1 AND owner_id = $2 AND lease_token = $3 AND released_at IS NULL`,
    [data.runId, data.ownerId, data.leaseToken, data.releasedAt]
  );
  return result.rowCount === 1;
}

export async function createSupervisorIncident(
  incident: SupervisorIncidentRecord
): Promise<SupervisorIncidentRecord> {
  const inserted = await pool.query<SupervisorIncidentRow>(
    `INSERT INTO remote_agent_supervisor_incidents
     (incident_id, incident_key, run_id, wo_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (incident_key) DO NOTHING
     RETURNING *`,
    [
      incident.incidentId,
      incident.incidentKey,
      incident.runId,
      incident.woId,
      incident.status,
      incident.createdAt,
      incident.updatedAt,
    ]
  );
  if (inserted.rows[0]) return normalizeSupervisorIncident(inserted.rows[0]);
  const existing = await pool.query<SupervisorIncidentRow>(
    'SELECT * FROM remote_agent_supervisor_incidents WHERE incident_key = $1',
    [incident.incidentKey]
  );
  const row = existing.rows[0];
  if (!row) throw new Error(`supervisor_incident_conflict: ${incident.incidentKey}`);
  if (row.run_id !== incident.runId || row.wo_id !== incident.woId) {
    throw new Error(`supervisor_incident_conflict: ${incident.incidentKey}`);
  }
  return normalizeSupervisorIncident(row);
}

export async function appendSupervisorObservation(
  observation: SupervisorObservationRecord
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO remote_agent_supervisor_observations
     (observation_id, incident_id, supervisor_id, assessment, evidence_refs, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (observation_id) DO NOTHING`,
    [
      observation.observationId,
      observation.incidentId,
      observation.supervisorId,
      observation.assessment,
      JSON.stringify(observation.evidenceRefs),
      observation.createdAt,
    ]
  );
  return result.rowCount === 1;
}

export async function listSupervisorObservations(
  incidentId: string
): Promise<SupervisorObservationRecord[]> {
  const result = await pool.query<SupervisorObservationRow>(
    `SELECT * FROM remote_agent_supervisor_observations
     WHERE incident_id = $1 ORDER BY created_at ASC, observation_id ASC`,
    [incidentId]
  );
  return result.rows.map(normalizeSupervisorObservation);
}

export async function claimSupervisorRepairLease(data: {
  incidentId: string;
  ownerId: string;
  leaseDurationMs: number;
}): Promise<SupervisorRepairLeaseRecord | null> {
  const isPostgres = getDatabase().dialect === 'postgres';
  const nowSql = isPostgres ? 'NOW()' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  const expiresSql = isPostgres
    ? "NOW() + ($3::bigint * INTERVAL '1 millisecond')"
    : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ($3 / 1000.0) || ' seconds')";
  const expiredSql = isPostgres
    ? 'remote_agent_supervisor_repair_leases.expires_at <= NOW()'
    : "julianday(remote_agent_supervisor_repair_leases.expires_at) <= julianday('now')";
  const result = await pool.query<SupervisorRepairLeaseRow>(
    `INSERT INTO remote_agent_supervisor_repair_leases
     (incident_id, owner_id, fencing_token, acquired_at, last_heartbeat_at, expires_at, released_at)
     SELECT $1, $2, 1, ${nowSql}, ${nowSql}, ${expiresSql}, NULL
     FROM remote_agent_supervisor_incidents
     WHERE incident_id = $1 AND status IN ('open', 'repairing')
     ON CONFLICT (incident_id) DO UPDATE SET
       owner_id = EXCLUDED.owner_id,
       fencing_token = remote_agent_supervisor_repair_leases.fencing_token + 1,
       acquired_at = EXCLUDED.acquired_at,
       last_heartbeat_at = EXCLUDED.last_heartbeat_at,
       expires_at = EXCLUDED.expires_at,
       released_at = NULL
     WHERE (remote_agent_supervisor_repair_leases.released_at IS NOT NULL
        OR ${expiredSql})
       AND EXISTS (
         SELECT 1 FROM remote_agent_supervisor_incidents i
         WHERE i.incident_id = remote_agent_supervisor_repair_leases.incident_id
           AND i.status IN ('open', 'repairing')
       )
     RETURNING *`,
    [data.incidentId, data.ownerId, data.leaseDurationMs]
  );
  const row = result.rows[0];
  return row ? normalizeSupervisorRepairLease(row) : null;
}

export async function heartbeatSupervisorRepairLease(data: {
  incidentId: string;
  ownerId: string;
  fencingToken: number;
  leaseDurationMs: number;
}): Promise<boolean> {
  const isPostgres = getDatabase().dialect === 'postgres';
  const nowSql = isPostgres ? 'NOW()' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  const expiresSql = isPostgres
    ? "NOW() + ($4::bigint * INTERVAL '1 millisecond')"
    : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ($4 / 1000.0) || ' seconds')";
  const activeSql = isPostgres ? 'expires_at > NOW()' : "julianday(expires_at) > julianday('now')";
  const result = await pool.query(
    `UPDATE remote_agent_supervisor_repair_leases
     SET last_heartbeat_at = ${nowSql}, expires_at = ${expiresSql}
     WHERE incident_id = $1 AND owner_id = $2 AND fencing_token = $3
       AND released_at IS NULL AND ${activeSql}`,
    [data.incidentId, data.ownerId, data.fencingToken, data.leaseDurationMs]
  );
  return result.rowCount === 1;
}

export async function authorizeSupervisorMutation(data: {
  incidentId: string;
  ownerId: string;
  fencingToken: number;
}): Promise<boolean> {
  const activeSql =
    getDatabase().dialect === 'postgres'
      ? 'l.expires_at > NOW()'
      : "julianday(l.expires_at) > julianday('now')";
  const result = await pool.query(
    `SELECT l.incident_id FROM remote_agent_supervisor_repair_leases l
     JOIN remote_agent_supervisor_incidents i ON i.incident_id = l.incident_id
     WHERE l.incident_id = $1 AND l.owner_id = $2 AND l.fencing_token = $3
       AND l.released_at IS NULL AND ${activeSql}
       AND i.status IN ('open', 'repairing')`,
    [data.incidentId, data.ownerId, data.fencingToken]
  );
  return result.rowCount === 1;
}

export async function appendSupervisorAction(action: SupervisorActionRecord): Promise<boolean> {
  const db = getDatabase();
  const activeSql =
    db.dialect === 'postgres'
      ? 'l.expires_at > NOW()'
      : "julianday(l.expires_at) > julianday('now')";
  try {
    return await db.withTransaction(async query => {
      const authorized = await query(
        `SELECT l.incident_id FROM remote_agent_supervisor_repair_leases l
         JOIN remote_agent_supervisor_incidents i ON i.incident_id = l.incident_id
         WHERE l.incident_id = $1 AND l.owner_id = $2 AND l.fencing_token = $3
           AND l.released_at IS NULL AND ${activeSql}
           AND i.status IN ('open', 'repairing')`,
        [action.incidentId, action.ownerId, action.fencingToken]
      );
      if (authorized.rowCount !== 1) return false;
      const inserted = await query(
        `INSERT INTO remote_agent_supervisor_actions
         (action_id, incident_id, owner_id, fencing_token, action_type, outcome, evidence_refs, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (action_id) DO NOTHING`,
        [
          action.actionId,
          action.incidentId,
          action.ownerId,
          action.fencingToken,
          action.actionType,
          action.outcome,
          JSON.stringify(action.evidenceRefs),
          action.createdAt,
        ]
      );
      if (inserted.rowCount !== 1) return false;
      const closed = await query(
        `UPDATE remote_agent_supervisor_incidents
         SET status = 'recovered', updated_at = $2
         WHERE incident_id = $1 AND status IN ('open', 'repairing')`,
        [action.incidentId, action.createdAt]
      );
      if (closed.rowCount !== 1) {
        throw new Error('supervisor_incident_close_conflict');
      }
      return true;
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'supervisor_incident_close_conflict') {
      return false;
    }
    throw error;
  }
}

export async function releaseSupervisorRepairLease(data: {
  incidentId: string;
  ownerId: string;
  fencingToken: number;
  releasedAt: string;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE remote_agent_supervisor_repair_leases
     SET released_at = $4
     WHERE incident_id = $1 AND owner_id = $2 AND fencing_token = $3
       AND released_at IS NULL`,
    [data.incidentId, data.ownerId, data.fencingToken, data.releasedAt]
  );
  return result.rowCount === 1;
}

export type CauldronDrainMode = 'normal' | 'draining';

export interface CauldronDrainState {
  mode: CauldronDrainMode;
  activeLeaseCount: number;
  activeRunCount: number;
  activeRunIds: string[];
  drained: boolean;
  updatedAt: string | null;
}

function numericCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

export async function getCauldronDrainState(
  observedAt = new Date().toISOString()
): Promise<CauldronDrainState> {
  return getDatabase().withTransaction(async query => {
    const control = await query<{ mode: CauldronDrainMode; updated_at: string | Date | null }>(
      'SELECT mode, updated_at FROM remote_agent_cauldron_control WHERE id = 1'
    );
    const leases = await query<{ active_lease_count: number | string }>(
      `SELECT COUNT(*) AS active_lease_count
       FROM remote_agent_run_leases l
       JOIN remote_agent_workflow_runs r ON r.id = l.run_id
       WHERE l.released_at IS NULL AND l.expires_at > $1 AND r.status = 'running'`,
      [observedAt]
    );
    const runs = await query<{ active_run_count: number | string }>(
      `SELECT COUNT(*) AS active_run_count
       FROM remote_agent_workflow_runs
       WHERE status IN ('pending', 'running', 'waiting_provider', 'paused')`,
      []
    );
    const runIds = await query<{ id: string }>(
      `SELECT id FROM remote_agent_workflow_runs
       WHERE status IN ('pending', 'running', 'waiting_provider', 'paused')
       ORDER BY started_at ASC, id ASC`,
      []
    );
    const controlRow = control.rows[0];
    const mode = controlRow?.mode ?? 'normal';
    const activeLeaseCount = numericCount(leases.rows[0]?.active_lease_count);
    const activeRunCount = numericCount(runs.rows[0]?.active_run_count);
    return {
      mode,
      activeLeaseCount,
      activeRunCount,
      activeRunIds: runIds.rows.map(row => row.id),
      drained: mode === 'draining' && activeLeaseCount === 0 && activeRunCount === 0,
      updatedAt:
        controlRow?.updated_at instanceof Date
          ? controlRow.updated_at.toISOString()
          : (controlRow?.updated_at ?? null),
    };
  });
}

export async function setCauldronDrainMode(data: {
  mode: CauldronDrainMode;
  actor: string;
  reason: string | null;
  updatedAt: string;
}): Promise<{ changed: boolean; mode: CauldronDrainMode }> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const lockSuffix = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const current = await query<{ mode: CauldronDrainMode }>(
      `SELECT mode FROM remote_agent_cauldron_control WHERE id = 1${lockSuffix}`
    );
    const currentMode = current.rows[0]?.mode ?? 'normal';
    if (currentMode === data.mode) return { changed: false, mode: data.mode };
    await query(
      `INSERT INTO remote_agent_cauldron_control (id, mode, updated_at, updated_by)
       VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         mode = EXCLUDED.mode,
         updated_at = EXCLUDED.updated_at,
         updated_by = EXCLUDED.updated_by`,
      [data.mode, data.updatedAt, data.actor]
    );
    await query(
      `INSERT INTO remote_agent_cauldron_control_events
       (from_mode, to_mode, actor, reason, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [currentMode, data.mode, data.actor, data.reason, data.updatedAt]
    );
    return { changed: true, mode: data.mode };
  });
}

interface ExpiredRunLeaseRow {
  run_id: string;
  workflow_name: string;
  working_path: string | null;
  owner_id: string;
  lease_token: string;
  expires_at: string | Date;
}

export async function listExpiredRunLeases(expiredAt: string): Promise<ExpiredRunLeaseRecord[]> {
  const result = await pool.query<ExpiredRunLeaseRow>(
    `SELECT r.id AS run_id, r.workflow_name, r.working_path,
            l.owner_id, l.lease_token, l.expires_at
     FROM remote_agent_workflow_runs r
     JOIN remote_agent_run_leases l ON l.run_id = r.id
     WHERE r.status = 'running'
       AND l.released_at IS NULL
       AND l.expires_at <= $1
     ORDER BY l.expires_at ASC, r.id ASC`,
    [expiredAt]
  );
  return result.rows.map(row => ({
    runId: row.run_id,
    workflowName: row.workflow_name,
    workingPath: row.working_path,
    ownerId: row.owner_id,
    leaseToken: row.lease_token,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
  }));
}

/**
 * Compare-and-swap an expired leased run into recoverable interruption.
 * A heartbeat, cancellation, or terminal transition that wins first makes this a no-op.
 */
export async function interruptExpiredRunLease(data: {
  runId: string;
  leaseToken: string;
  expiredAt: string;
  interruptedAt: string;
}): Promise<boolean> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const lockSuffix = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const candidate = await query<{ status: string }>(
      `SELECT r.status
       FROM remote_agent_workflow_runs r
       JOIN remote_agent_run_leases l ON l.run_id = r.id
       WHERE r.id = $1 AND l.lease_token = $2 AND l.expires_at <= $3
         AND l.released_at IS NULL AND r.status = 'running'${lockSuffix}`,
      [data.runId, data.leaseToken, data.expiredAt]
    );
    if (!candidate.rows[0]) return false;

    const update = await query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'interrupted',
           metadata = ${db.sql.jsonMerge('metadata', 1)}
       WHERE id = $2 AND status = 'running'`,
      [
        JSON.stringify({
          interruption_reason: 'worker_lease_expired',
          interrupted_at: data.interruptedAt,
        }),
        data.runId,
      ]
    );
    if (update.rowCount !== 1) return false;

    await query<{ run_id: string }>(
      `INSERT INTO remote_agent_run_outcomes
       (run_id, execution_state, deliverable_state, validation_state, recovery_state,
        route_state, primary_reason, reason_codes, evidence_refs, updated_at)
       VALUES ($1, 'interrupted', 'none', 'not_run', 'recoverable',
               'current', 'worker_lease_expired', $2, $3, $4)
       ON CONFLICT (run_id) DO UPDATE SET
         execution_state = EXCLUDED.execution_state,
         recovery_state = EXCLUDED.recovery_state,
         primary_reason = EXCLUDED.primary_reason,
         reason_codes = EXCLUDED.reason_codes,
         evidence_refs = EXCLUDED.evidence_refs,
         updated_at = EXCLUDED.updated_at
       WHERE remote_agent_run_outcomes.updated_at <= EXCLUDED.updated_at
       RETURNING run_id`,
      [
        data.runId,
        JSON.stringify(['worker_lease_expired']),
        JSON.stringify([`lease:${data.leaseToken}`]),
        data.interruptedAt,
      ]
    );
    await query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, data)
       SELECT $1, 'workflow_interrupted', $2
       WHERE NOT EXISTS (
         SELECT 1 FROM remote_agent_workflow_events
         WHERE workflow_run_id = $1 AND event_type = 'workflow_interrupted'
       )`,
      [
        data.runId,
        JSON.stringify({
          reason_code: 'worker_lease_expired',
          interrupted_at: data.interruptedAt,
        }),
      ]
    );
    await query(
      `UPDATE remote_agent_run_leases
       SET released_at = $3
       WHERE run_id = $1 AND lease_token = $2 AND released_at IS NULL`,
      [data.runId, data.leaseToken, data.interruptedAt]
    );
    return true;
  });
}

/** Persist the attempt before invoking a provider. Duplicate IDs/numbers are rejected. */
export async function createProviderAttempt(attempt: ProviderAttemptRecord): Promise<boolean> {
  const result = await pool.query<{ attempt_id: string }>(
    `INSERT INTO remote_agent_provider_attempts
     (attempt_id, run_id, node_id, attempt_number, provider, model,
      declared_provider, declared_model, required_capabilities, started_at,
      completed_at, served_model_id, outcome_class, reason_code, resume_at,
      supersedes_attempt_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT DO NOTHING
     RETURNING attempt_id`,
    [
      attempt.attemptId,
      attempt.runId,
      attempt.nodeId,
      attempt.attemptNumber,
      attempt.provider,
      attempt.model,
      attempt.declaredProvider,
      attempt.declaredModel,
      JSON.stringify(attempt.requiredCapabilities),
      attempt.startedAt,
      attempt.completedAt,
      attempt.servedModelId,
      attempt.outcomeClass,
      attempt.reasonCode,
      attempt.resumeAt,
      attempt.supersedesAttemptId,
    ]
  );
  return result.rows.length === 1;
}

export async function completeProviderAttempt(data: {
  attemptId: string;
  completedAt: string;
  servedModelId: string | null;
  outcomeClass: ProviderAttemptRecord['outcomeClass'];
  reasonCode: ProviderAttemptRecord['reasonCode'];
  resumeAt: string | null;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE remote_agent_provider_attempts
     SET completed_at = $2, served_model_id = $3, outcome_class = $4,
         reason_code = $5, resume_at = $6
     WHERE attempt_id = $1 AND completed_at IS NULL`,
    [
      data.attemptId,
      data.completedAt,
      data.servedModelId,
      data.outcomeClass,
      data.reasonCode,
      data.resumeAt,
    ]
  );
  return result.rowCount === 1;
}

export async function listProviderAttempts(
  runId: string,
  nodeId?: string
): Promise<ProviderAttemptRecord[]> {
  const result = nodeId
    ? await pool.query<ProviderAttemptRow>(
        `SELECT * FROM remote_agent_provider_attempts
         WHERE run_id = $1 AND node_id = $2 ORDER BY attempt_number ASC`,
        [runId, nodeId]
      )
    : await pool.query<ProviderAttemptRow>(
        `SELECT * FROM remote_agent_provider_attempts
         WHERE run_id = $1 ORDER BY node_id ASC, attempt_number ASC`,
        [runId]
      );
  return result.rows.map(normalizeProviderAttempt);
}

export async function upsertRunOutcome(
  runId: string,
  outcome: RunOutcome,
  updatedAt: string
): Promise<boolean> {
  const result = await pool.query<{ run_id: string }>(
    `INSERT INTO remote_agent_run_outcomes
     (run_id, execution_state, deliverable_state, validation_state, recovery_state,
      route_state, primary_reason, reason_codes, evidence_refs, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (run_id) DO UPDATE SET
       execution_state = EXCLUDED.execution_state,
       deliverable_state = EXCLUDED.deliverable_state,
       validation_state = EXCLUDED.validation_state,
       recovery_state = EXCLUDED.recovery_state,
       route_state = EXCLUDED.route_state,
       primary_reason = EXCLUDED.primary_reason,
       reason_codes = EXCLUDED.reason_codes,
       evidence_refs = EXCLUDED.evidence_refs,
       updated_at = EXCLUDED.updated_at
     WHERE remote_agent_run_outcomes.updated_at <= EXCLUDED.updated_at
     RETURNING run_id`,
    [
      runId,
      outcome.executionState,
      outcome.deliverableState,
      outcome.validationState,
      outcome.recoveryState,
      outcome.routeState,
      outcome.primaryReason,
      JSON.stringify(outcome.reasonCodes),
      JSON.stringify(outcome.evidenceRefs),
      updatedAt,
    ]
  );
  return result.rows.length === 1;
}

export async function getRunOutcome(runId: string): Promise<RunOutcome | null> {
  const result = await pool.query<RunOutcomeRow>(
    'SELECT * FROM remote_agent_run_outcomes WHERE run_id = $1',
    [runId]
  );
  const row = result.rows[0];
  return row ? normalizeRunOutcome(row) : null;
}

export async function scheduleProviderWait(wait: ScheduledProviderWaitRecord): Promise<boolean> {
  if (
    wait.state !== 'scheduled' ||
    wait.claimOwnerId !== null ||
    wait.claimToken !== null ||
    wait.claimedAt !== null ||
    wait.cancelledAt !== null ||
    wait.completedAt !== null
  ) {
    throw new Error('New provider waits must be unclaimed and scheduled');
  }
  const result = await pool.query<{ wait_id: string }>(
    `INSERT INTO remote_agent_scheduled_waits
     (wait_id, run_id, attempt_id, provider, reason_code, resume_at, state,
      claim_owner_id, claim_token, created_at, claimed_at, cancelled_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', NULL, NULL, $7, NULL, NULL, NULL)
     ON CONFLICT DO NOTHING
     RETURNING wait_id`,
    [
      wait.waitId,
      wait.runId,
      wait.attemptId,
      wait.provider,
      wait.reasonCode,
      wait.resumeAt,
      wait.createdAt,
    ]
  );
  return result.rows.length === 1;
}

export async function listDueProviderWaits(
  dueAt: string,
  limit: number
): Promise<ScheduledProviderWaitRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Provider wait limit must be an integer between 1 and 1000');
  }
  const result = await pool.query<ScheduledProviderWaitRow>(
    `SELECT * FROM remote_agent_scheduled_waits
     WHERE state = 'scheduled' AND resume_at <= $1
     ORDER BY resume_at ASC, wait_id ASC LIMIT $2`,
    [dueAt, limit]
  );
  return result.rows.map(normalizeScheduledProviderWait);
}

export async function claimProviderWait(data: {
  waitId: string;
  ownerId: string;
  claimToken: string;
  claimedAt: string;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE remote_agent_scheduled_waits
     SET state = 'claimed', claim_owner_id = $2, claim_token = $3, claimed_at = $4
     WHERE wait_id = $1 AND state = 'scheduled' AND resume_at <= $4
       AND EXISTS (
         SELECT 1 FROM remote_agent_workflow_runs r
         WHERE r.id = remote_agent_scheduled_waits.run_id
           AND r.status = 'waiting_provider'
       )`,
    [data.waitId, data.ownerId, data.claimToken, data.claimedAt]
  );
  return result.rowCount === 1;
}

/** Return a failed scheduler claim to the durable queue for a bounded retry. */
export async function releaseProviderWaitClaim(data: {
  waitId: string;
  claimToken: string;
  resumeAt: string;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE remote_agent_scheduled_waits
     SET state = 'scheduled', resume_at = $3,
         claim_owner_id = NULL, claim_token = NULL, claimed_at = NULL
     WHERE wait_id = $1 AND claim_token = $2 AND state = 'claimed'`,
    [data.waitId, data.claimToken, data.resumeAt]
  );
  return result.rowCount === 1;
}

/** Operator cancellation wins over scheduled or already-claimed resumes. */
export async function cancelProviderWaits(runId: string, cancelledAt: string): Promise<number> {
  const result = await pool.query(
    `UPDATE remote_agent_scheduled_waits
     SET state = 'cancelled', cancelled_at = $2
     WHERE run_id = $1 AND state IN ('scheduled', 'claimed')`,
    [runId, cancelledAt]
  );
  return result.rowCount;
}

export async function completeProviderWait(data: {
  waitId: string;
  claimToken: string;
  completedAt: string;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE remote_agent_scheduled_waits
     SET state = 'completed', completed_at = $3
     WHERE wait_id = $1 AND claim_token = $2 AND state = 'claimed'`,
    [data.waitId, data.claimToken, data.completedAt]
  );
  return result.rowCount === 1;
}

export async function getWorkflowRunStatus(id: string): Promise<string | null> {
  try {
    const result = await pool.query<{ status: string }>(
      'SELECT status FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    return result.rows[0]?.status ?? null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_status_failed');
    throw new Error(`Failed to get workflow run status: ${err.message}`);
  }
}

export async function getActiveWorkflowRun(conversationId: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE (conversation_id = $1 OR parent_conversation_id = $2) AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
      [conversationId, conversationId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_active_failed');
    throw new Error(`Failed to get active workflow run: ${err.message}`);
  }
}

/**
 * Find a paused workflow run for a conversation (or its parent).
 * Used by the message handler to detect approval gates awaiting a natural-language response.
 * Non-throwing: returns null on DB error so the caller can fall through to normal routing.
 */
export async function getPausedWorkflowRun(conversationId: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE (conversation_id = $1 OR parent_conversation_id = $2) AND status = 'paused'
       ORDER BY started_at DESC LIMIT 1`,
      [conversationId, conversationId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, conversationId }, 'db.workflow_run_get_paused_failed');
    return null;
  }
}

/**
 * Find the workflow run currently holding the lock on `workingPath`.
 *
 * The lock is held by any row in `(running, paused)` or `pending` younger
 * than `STALE_PENDING_AGE_MS` (orphaned pre-creates beyond that window are
 * ignored -- they're from crashed or resume-replaced dispatches).
 *
 * When called from a dispatch that already pre-created its own row, pass
 * `excludeId` and `selfStartedAt` so:
 *   1. Self is never returned.
 *   2. If two dispatches both have rows, the deterministic older-wins
 *      tiebreaker `(started_at, id)` ensures both agree on which is "first."
 *      The newer dispatch sees the older row and aborts; the older dispatch
 *      sees nothing.
 *
 * Returns the holding row, or null if the path is free.
 */
export const STALE_PENDING_AGE_MS = 5 * 60 * 1000; // 5 minutes

export async function getActiveWorkflowRunByPath(
  workingPath: string,
  self?: { id: string; startedAt: Date }
): Promise<WorkflowRun | null> {
  const isPostgres = getDatabaseType() === 'postgresql';
  const stalePendingCutoff = isPostgres
    ? `NOW() - INTERVAL '${String(STALE_PENDING_AGE_MS)} milliseconds'`
    : `datetime('now', '-${String(Math.floor(STALE_PENDING_AGE_MS / 1000))} seconds')`;

  // Build params + clauses dynamically. Self exclusion + tiebreaker travel
  // together -- the tiebreaker references both ids and timestamps.
  const params: unknown[] = [workingPath];
  const clauses: string[] = [
    'working_path = $1',
    `(status IN ('running', 'paused') OR (status = 'pending' AND started_at > ${stalePendingCutoff}))`,
  ];
  if (self !== undefined) {
    params.push(self.id);
    clauses.push(`id != $${String(params.length)}`);
  }
  if (self !== undefined) {
    // Older-wins tiebreaker. (started_at, id) is a total order so both
    // dispatches always agree on which is "first." Without this, two rows
    // with similar timestamps could mutually see each other and both abort.
    //
    // Serialize Date to ISO string -- bun:sqlite rejects Date bindings.
    //
    // Format-aware comparison:
    //   PostgreSQL: started_at is TIMESTAMPTZ; cast the ISO param to
    //     timestamptz so the comparison is chronological, not lexical.
    //   SQLite: started_at is TEXT in "YYYY-MM-DD HH:MM:SS" format. Our
    //     ISO param has "YYYY-MM-DDTHH:MM:SS.mmmZ". Lexical comparison is
    //     WRONG: char 11 is space (0x20) in the column vs T (0x54) in the
    //     param, so every column value lex-sorts before every ISO param --
    //     making `started_at < $param` always TRUE regardless of actual
    //     time. Wrap both sides in datetime() to force chronological
    //     comparison via SQLite's date/time functions.
    params.push(self.startedAt.toISOString());
    const startedAtParam = `$${String(params.length)}`;
    const idParam = `$${String(params.length - 1)}`;
    const colExpr = isPostgres ? 'started_at' : 'datetime(started_at)';
    const paramExpr = isPostgres ? `${startedAtParam}::timestamptz` : `datetime(${startedAtParam})`;
    clauses.push(`(${colExpr} < ${paramExpr} OR (${colExpr} = ${paramExpr} AND id < ${idParam}))`);
  }

  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE ${clauses.join(' AND ')}
       ORDER BY started_at ASC, id ASC LIMIT 1`,
      params
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workingPath }, 'db.workflow_run_get_active_by_path_failed');
    throw new Error(`Failed to get active workflow run by path: ${err.message}`);
  }
}

export async function findLatestRunByWorkingPath(workingPath: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE working_path = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [workingPath]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workingPath }, 'db.workflow_run_find_latest_by_path_failed');
    throw new Error(`Failed to find latest workflow run by path: ${err.message}`);
  }
}

export async function getRunningWorkflows(): Promise<
  { id: string; conversation_id: string; workflow_name: string; started_at: string }[]
> {
  try {
    const result = await pool.query<{
      id: string;
      conversation_id: string;
      workflow_name: string;
      started_at: string;
    }>(
      "SELECT id, conversation_id, workflow_name, started_at FROM remote_agent_workflow_runs WHERE status = 'running' ORDER BY started_at ASC LIMIT 100",
      []
    );
    return [...result.rows];
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_runs_get_running_failed');
    return []; // Non-critical: don't break health check
  }
}

export async function findResumableRun(
  workflowName: string,
  workingPath: string
): Promise<WorkflowRun | null> {
  const dialect = getDialect();
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE workflow_name = $1
         AND working_path = $2
         AND (
           status IN ('failed', 'paused')
           OR (status = 'running' AND (last_activity_at IS NULL OR last_activity_at < ${dialect.nowMinusDays(3)}))
         )
       ORDER BY started_at DESC
       LIMIT 1`,
      [workflowName, workingPath, 1]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, errorType: err.constructor.name, workflowName, workingPath },
      'db.workflow_run_find_resumable_failed'
    );
    throw new Error(`Failed to find resumable run: ${err.message}`);
  }
}

/**
 * Find a resumable (failed/paused) run for a workflow by parent conversation ID.
 * Used by the web orchestrator to detect approved runs that need foreground resume
 * (background dispatch would create a new worktree and lose the resumable run).
 */
export async function findResumableRunByParentConversation(
  workflowName: string,
  parentConversationId: string
): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE workflow_name = $1
         AND parent_conversation_id = $2
         AND status IN ('failed', 'paused')
       ORDER BY started_at DESC
       LIMIT 1`,
      [workflowName, parentConversationId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, workflowName, parentConversationId },
      'db.workflow_run_find_resumable_by_parent_failed'
    );
    throw new Error(`Failed to find resumable run by parent conversation: ${err.message}`);
  }
}

export async function resumeWorkflowRun(id: string): Promise<WorkflowRun> {
  const dialect = getDatabase().sql;

  // Split into UPDATE + SELECT to support both PostgreSQL and SQLite
  // (SQLite does not support RETURNING on UPDATE statements)
  // Each phase has its own try/catch to avoid string-sniffing own errors in a shared catch.
  let updateResult: Awaited<ReturnType<typeof pool.query>>;
  try {
    // Refresh started_at to NOW so the resumed row competes fairly with
    // currently-active rows in getActiveWorkflowRunByPath's older-wins
    // tiebreaker. Without this, a resumed row carries its original
    // (potentially hours-old) started_at and would sort ahead of any
    // currently-running holder, slipping past the path lock and causing
    // two active workflows on the same working_path.
    //
    // We accept losing the original creation time here -- `started_at` for
    // an active row semantically means "when did this active phase start."
    // The original creation time can be recovered from workflow_events
    // history if needed for analytics.
    updateResult = await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'running',
           completed_at = NULL,
           started_at = ${dialect.now()},
           last_activity_at = ${dialect.now()}
       WHERE id = $1
         AND status IN ('failed', 'paused', 'waiting_provider', 'interrupted')`,
      [id]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_resume_failed');
    throw new Error(`Failed to resume workflow run: ${err.message}`);
  }

  if (updateResult.rowCount === 0) {
    // Logical race: run was deleted or already activated between find and resume
    getLog().warn({ workflowRunId: id }, 'db.workflow_run_resume_not_found');
    throw new Error(`Workflow run is not resumable (id: ${id})`);
  }

  let selectResult: Awaited<ReturnType<typeof pool.query<WorkflowRun>>>;
  try {
    selectResult = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_resume_select_failed');
    throw new Error(`Failed to read workflow run after update: ${err.message}`);
  }

  const row = selectResult.rows[0];
  if (!row) {
    getLog().error({ workflowRunId: id }, 'db.workflow_run_resume_vanished');
    throw new Error(`Workflow run vanished after update (id: ${id})`);
  }
  return normalizeWorkflowRun(row);
}

/**
 * Find the most recent workflow run for a worker platform conversation ID.
 * Joins with conversations table to resolve platform_conversation_id -> DB id.
 */
export async function getWorkflowRunByWorkerPlatformId(
  platformConversationId: string
): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT r.* FROM remote_agent_workflow_runs r
       JOIN remote_agent_conversations c ON r.conversation_id = c.id
       WHERE c.platform_conversation_id = $1
       ORDER BY r.started_at DESC LIMIT 1`,
      [platformConversationId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_by_worker_platform_id_failed');
    throw new Error(`Failed to get workflow run by worker platform ID: ${err.message}`);
  }
}

/**
 * Partially update a workflow run.
 * - Dynamically builds SQL from provided fields
 * - Auto-sets completed_at when status becomes 'completed' or 'failed'
 * - Merges metadata with existing (does not replace)
 * - No-op if updates object is empty
 */
export async function updateWorkflowRun(
  id: string,
  updates: Partial<Pick<WorkflowRun, 'status' | 'metadata'>>
): Promise<void> {
  const dialect = getDialect();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  // Helper to add parameterized clause
  function addParam(clause: string, value: unknown): void {
    values.push(value);
    setClauses.push(clause.replace('?', `$${values.length}`));
  }

  if (updates.status !== undefined) {
    addParam('status = ?', updates.status);
    // Auto-set completed_at for terminal-like statuses, but skip when
    // transitioning to 'failed' for approval resume (not a real completion)
    const isApprovalTransition =
      updates.status === 'failed' &&
      (updates.metadata?.approval_response !== undefined ||
        updates.metadata?.loop_user_input !== undefined);
    if (
      !isApprovalTransition &&
      (updates.status === 'completed' ||
        updates.status === 'failed' ||
        updates.status === 'escalated' ||
        updates.status === 'cancelled')
    ) {
      // For escalated (re-label of an already-failed terminal run), preserve any
      // existing completed_at rather than rewriting it to "now".
      setClauses.push(`completed_at = COALESCE(completed_at, ${dialect.now()})`);
    }
  }
  if (updates.metadata !== undefined) {
    // Use dialect helper for JSON merge - need to calculate the param index
    const paramIndex = values.length + 1;
    values.push(JSON.stringify(updates.metadata));
    setClauses.push(`metadata = ${dialect.jsonMerge('metadata', paramIndex)}`);
  }

  if (setClauses.length === 0) return;

  values.push(id);
  const idParam = `$${values.length}`;

  try {
    const result = await pool.query(
      `UPDATE remote_agent_workflow_runs SET ${setClauses.join(', ')} WHERE id = ${idParam}`,
      values
    );
    if (result.rowCount === 0) {
      getLog().warn({ workflowRunId: id }, 'db.workflow_run_update_no_match');
      throw new Error(`Workflow run not found (id: ${id})`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workflow run not found')) throw error;
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_update_failed');
    throw new Error(`Failed to update workflow run: ${err.message}`);
  }
}

async function persistTerminalWorkflowRun(
  id: string,
  status: 'completed' | 'failed' | 'cancelled',
  metadata: Record<string, unknown>,
  terminal: TerminalWorkflowPersistence
): Promise<void> {
  const db = getDatabase();
  const dialect = db.sql;
  await db.withTransaction(async query => {
    const lockSuffix = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const runResult = await query<{ status: string }>(
      `SELECT status FROM remote_agent_workflow_runs WHERE id = $1${lockSuffix}`,
      [id]
    );
    const currentStatus = runResult.rows[0]?.status;
    if (!currentStatus) throw new Error(`Workflow run not found (id: ${id})`);
    const cancellableStatus =
      status === 'cancelled' &&
      ['pending', 'running', 'waiting_provider', 'paused', 'interrupted'].includes(currentStatus);
    if (currentStatus !== 'running' && currentStatus !== status && !cancellableStatus) {
      throw new Error(
        `terminal_status_conflict: run ${id} is ${currentStatus}, cannot finalize as ${status}`
      );
    }

    const outcome = terminal.outcome;
    let outcomeAlreadyPersisted = false;
    if (currentStatus === status) {
      const existingOutcomeResult = await query<RunOutcomeRow>(
        'SELECT * FROM remote_agent_run_outcomes WHERE run_id = $1',
        [id]
      );
      const existingOutcomeRow = existingOutcomeResult.rows[0];
      if (existingOutcomeRow) {
        if (!runOutcomesEqual(normalizeRunOutcome(existingOutcomeRow), outcome)) {
          throw new Error(`terminal_outcome_conflict: immutable outcome differs for run ${id}`);
        }
        outcomeAlreadyPersisted = true;
      }
    }

    const outcomeResult = outcomeAlreadyPersisted
      ? { rows: [{ run_id: id }], rowCount: 1 }
      : await query<{ run_id: string }>(
          `INSERT INTO remote_agent_run_outcomes
       (run_id, execution_state, deliverable_state, validation_state, recovery_state,
        route_state, primary_reason, reason_codes, evidence_refs, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (run_id) DO UPDATE SET
         execution_state = EXCLUDED.execution_state,
         deliverable_state = EXCLUDED.deliverable_state,
         validation_state = EXCLUDED.validation_state,
         recovery_state = EXCLUDED.recovery_state,
         route_state = EXCLUDED.route_state,
         primary_reason = EXCLUDED.primary_reason,
         reason_codes = EXCLUDED.reason_codes,
         evidence_refs = EXCLUDED.evidence_refs,
         updated_at = EXCLUDED.updated_at
       WHERE remote_agent_run_outcomes.updated_at <= EXCLUDED.updated_at
       RETURNING run_id`,
          [
            id,
            outcome.executionState,
            outcome.deliverableState,
            outcome.validationState,
            outcome.recoveryState,
            outcome.routeState,
            outcome.primaryReason,
            JSON.stringify(outcome.reasonCodes),
            JSON.stringify(outcome.evidenceRefs),
            terminal.updatedAt,
          ]
        );
    if (outcomeResult.rows.length !== 1) {
      throw new Error(`terminal_outcome_conflict: newer outcome already exists for run ${id}`);
    }

    if (currentStatus === 'running' || cancellableStatus) {
      const updateResult = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = $1, completed_at = ${dialect.now()},
             metadata = ${dialect.jsonMerge('metadata', 2)}
         WHERE id = $3 AND status = $4`,
        [status, JSON.stringify(metadata), id, currentStatus]
      );
      if (updateResult.rowCount !== 1) {
        throw new Error(`terminal_status_conflict: run ${id} changed during finalization`);
      }
    }

    if (status === 'cancelled') {
      await query(
        `UPDATE remote_agent_scheduled_waits
         SET state = 'cancelled', cancelled_at = $2
         WHERE run_id = $1 AND state IN ('scheduled', 'claimed')`,
        [id, terminal.updatedAt]
      );
    }

    const eventType =
      status === 'completed'
        ? 'workflow_completed'
        : status === 'cancelled'
          ? 'workflow_cancelled'
          : 'workflow_failed';
    await query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (
         SELECT 1 FROM remote_agent_workflow_events
         WHERE workflow_run_id = $1 AND event_type = $2
       )`,
      [id, eventType, terminal.stepName ?? null, JSON.stringify(terminal.eventData)]
    );
  });
}

export async function completeWorkflowRun(
  id: string,
  metadata?: Record<string, unknown>,
  terminal?: TerminalWorkflowPersistence
): Promise<void> {
  if (terminal) {
    try {
      await persistTerminalWorkflowRun(id, 'completed', metadata ?? {}, terminal);
      return;
    } catch (error) {
      const err = error as Error;
      getLog().error({ err }, 'db.workflow_run_terminal_complete_failed');
      throw new Error(`Failed to complete workflow run: ${err.message}`);
    }
  }
  const dialect = getDialect();
  let result: Awaited<ReturnType<IDatabase['query']>>;
  try {
    if (metadata) {
      result = await pool.query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'completed', completed_at = ${dialect.now()}, metadata = ${dialect.jsonMerge('metadata', 2)}
         WHERE id = $1 AND status = 'running'`,
        [id, JSON.stringify(metadata)]
      );
    } else {
      result = await pool.query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'completed', completed_at = ${dialect.now()}
         WHERE id = $1 AND status = 'running'`,
        [id]
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_complete_failed');
    throw new Error(`Failed to complete workflow run: ${err.message}`);
  }
  if (result.rowCount === 0) {
    getLog().warn({ workflowRunId: id }, 'db.workflow_run_complete_no_match');
    throw new Error(`Workflow run not found or not in running state (id: ${id})`);
  }
}

export async function failWorkflowRun(
  id: string,
  error: string,
  terminal?: TerminalWorkflowPersistence
): Promise<void> {
  if (terminal) {
    try {
      await persistTerminalWorkflowRun(
        id,
        'failed',
        { error, ...(terminal.metadata ?? {}) },
        terminal
      );
      return;
    } catch (dbError) {
      const err = dbError as Error;
      getLog().error({ err }, 'db.workflow_run_terminal_fail_failed');
      throw new Error(`Failed to fail workflow run: ${err.message}`);
    }
  }
  const dialect = getDialect();
  let result: Awaited<ReturnType<IDatabase['query']>>;
  try {
    result = await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'failed', completed_at = ${dialect.now()}, metadata = ${dialect.jsonMerge('metadata', 2)}
       WHERE id = $1 AND status = 'running'`,
      [id, JSON.stringify({ error })]
    );
  } catch (dbError) {
    const err = dbError as Error;
    getLog().error({ err }, 'db.workflow_run_mark_failed_error');
    throw new Error(`Failed to fail workflow run: ${err.message}`);
  }
  if (result.rowCount === 0) {
    getLog().warn({ workflowRunId: id }, 'db.workflow_run_fail_no_match');
    throw new Error(`Workflow run not found or not in running state (id: ${id})`);
  }
}

interface TerminalMismatchRow {
  id: string;
  status: string;
  execution_state: string | null;
  route_state: string | null;
  terminal_event: string | null;
}

type ReconciledTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'escalated';

function terminalStatusFromOutcome(row: TerminalMismatchRow): ReconciledTerminalStatus | null {
  if (row.execution_state === 'completed') return 'completed';
  if (row.execution_state === 'cancelled') return 'cancelled';
  if (row.execution_state === 'failed') {
    return row.route_state === 'escalated' ? 'escalated' : 'failed';
  }
  return null;
}

function terminalStatusFromEvent(eventType: string | null): ReconciledTerminalStatus | null {
  if (eventType === 'workflow_completed') return 'completed';
  if (eventType === 'workflow_failed') return 'failed';
  if (eventType === 'workflow_cancelled') return 'cancelled';
  return null;
}

/**
 * Repair historical terminal event/status gaps created before atomic finalization.
 * Contradictory durable evidence is reported and left untouched.
 */
export async function reconcileTerminalWorkflowRuns(
  reconciledAt = new Date().toISOString()
): Promise<{ scanned: number; repaired: number; conflicts: number }> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const result = await query<TerminalMismatchRow>(
      `WITH candidates AS (
         SELECT r.id, r.status, o.execution_state, o.route_state,
           (SELECT e.event_type
            FROM remote_agent_workflow_events e
            WHERE e.workflow_run_id = r.id
              AND e.event_type IN ('workflow_completed', 'workflow_failed', 'workflow_cancelled')
            ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS terminal_event
         FROM remote_agent_workflow_runs r
         LEFT JOIN remote_agent_run_outcomes o ON o.run_id = r.id
       )
       SELECT * FROM candidates
       WHERE
         (status IN ('completed', 'failed', 'cancelled', 'escalated') AND
           (execution_state IS NULL OR
            (status <> 'escalated' AND terminal_event IS NULL)))
         OR (status NOT IN ('completed', 'failed', 'cancelled', 'escalated') AND
           (execution_state IN ('completed', 'failed', 'cancelled') OR terminal_event IS NOT NULL))
         OR (status = 'completed' AND execution_state IS NOT NULL AND execution_state <> 'completed')
         OR (status = 'failed' AND execution_state IS NOT NULL AND execution_state <> 'failed')
         OR (status = 'cancelled' AND execution_state IS NOT NULL AND execution_state <> 'cancelled')
         OR (status = 'escalated' AND
           (execution_state IS NOT NULL AND execution_state <> 'failed' OR
            route_state IS NULL OR route_state <> 'escalated'))
         OR (terminal_event = 'workflow_completed' AND execution_state IS NOT NULL AND execution_state <> 'completed')
         OR (terminal_event = 'workflow_failed' AND execution_state IS NOT NULL AND execution_state <> 'failed')
         OR (terminal_event = 'workflow_cancelled' AND execution_state IS NOT NULL AND execution_state <> 'cancelled')`
    );

    let repaired = 0;
    let conflicts = 0;
    const terminalStatuses = new Set<ReconciledTerminalStatus>([
      'completed',
      'failed',
      'cancelled',
      'escalated',
    ]);

    for (const row of result.rows) {
      const statusTarget = terminalStatuses.has(row.status as ReconciledTerminalStatus)
        ? (row.status as ReconciledTerminalStatus)
        : null;
      const outcomeTarget = terminalStatusFromOutcome(row);
      const eventTarget = terminalStatusFromEvent(row.terminal_event);
      const targets = new Set(
        [statusTarget, outcomeTarget, eventTarget].filter(
          (value): value is ReconciledTerminalStatus => value !== null
        )
      );
      if (targets.size !== 1) {
        conflicts += 1;
        continue;
      }
      const target = [...targets][0];

      if (!outcomeTarget) {
        const executionState = target === 'escalated' ? 'failed' : target;
        const routeState = target === 'escalated' ? 'escalated' : 'current';
        const primaryReason =
          target === 'completed'
            ? 'execution_completed'
            : target === 'cancelled'
              ? 'cancelled_by_operator'
              : target === 'escalated'
                ? 'gate_rejection_with_successor'
                : 'execution_failed';
        await query(
          `INSERT INTO remote_agent_run_outcomes
           (run_id, execution_state, deliverable_state, validation_state, recovery_state,
            route_state, primary_reason, reason_codes, evidence_refs, updated_at)
           VALUES ($1, $2, 'none', 'not_run', $3, $4, $5, $6, $7, $8)
           ON CONFLICT (run_id) DO NOTHING`,
          [
            row.id,
            executionState,
            target === 'failed' || target === 'escalated' ? 'recoverable' : 'not_needed',
            routeState,
            primaryReason,
            JSON.stringify([primaryReason]),
            JSON.stringify([`reconciled:${row.terminal_event ?? row.status}`]),
            reconciledAt,
          ]
        );
      }

      if (!statusTarget) {
        const update = await query(
          `UPDATE remote_agent_workflow_runs
           SET status = $1, completed_at = COALESCE(completed_at, ${db.sql.now()})
           WHERE id = $2 AND status NOT IN ('completed', 'failed', 'cancelled', 'escalated')`,
          [target, row.id]
        );
        if (update.rowCount !== 1) {
          conflicts += 1;
          continue;
        }
      }

      if (!eventTarget && target !== 'escalated') {
        const eventType =
          target === 'completed'
            ? 'workflow_completed'
            : target === 'cancelled'
              ? 'workflow_cancelled'
              : 'workflow_failed';
        await query(
          `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, data)
           SELECT $1, $2, $3
           WHERE NOT EXISTS (
             SELECT 1 FROM remote_agent_workflow_events
             WHERE workflow_run_id = $1 AND event_type = $2
           )`,
          [
            row.id,
            eventType,
            JSON.stringify({
              reconciled: true,
              reason_code: 'status_persist_failed',
              reconciled_at: reconciledAt,
            }),
          ]
        );
      }
      repaired += 1;
    }

    return { scanned: result.rows.length, repaired, conflicts };
  });
}

export async function cancelWorkflowRun(
  id: string,
  terminal?: TerminalWorkflowPersistence
): Promise<void> {
  if (terminal) {
    try {
      await persistTerminalWorkflowRun(id, 'cancelled', terminal.metadata ?? {}, terminal);
      return;
    } catch (error) {
      const err = error as Error;
      getLog().error({ err }, 'db.workflow_run_terminal_cancel_failed');
      throw new Error(`Failed to cancel workflow run: ${err.message}`);
    }
  }
  const dialect = getDialect();
  try {
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'cancelled', completed_at = ${dialect.now()}
       WHERE id = $1`,
      [id]
    );
    await cancelProviderWaits(id, new Date().toISOString());
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_cancel_failed');
    throw new Error(`Failed to cancel workflow run: ${err.message}`);
  }
}

/**
 * Pause a running workflow run via an operator request (HTTP POST /pause).
 * Distinct from `pauseWorkflowRun` (approval-gate pause): no ApprovalContext
 * is required and no `metadata.approval` is written. Sets status to 'paused'
 * only when the run is currently 'running'. Does NOT set completed_at -- the
 * run is not finished.
 *
 * Throws when the run is missing or not in the running state so the route
 * handler can map to 404/422/409 status codes.
 */
export async function pauseWorkflowRunByOperator(id: string): Promise<void> {
  const dialect = getDialect();
  try {
    const result = await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'paused', metadata = ${dialect.jsonMerge('metadata', 2)}
       WHERE id = $1 AND status = 'running'`,
      [id, JSON.stringify({ paused_by: 'operator', paused_at: new Date().toISOString() })]
    );
    if (result.rowCount === 0) {
      getLog().warn({ workflowRunId: id }, 'db.workflow_run_pause_operator_no_match');
      throw new Error(`Workflow run not found or not in running state (id: ${id})`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workflow run not found')) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_pause_operator_failed');
    throw new Error(`Failed to pause workflow run: ${err.message}`);
  }
}

/**
 * Resume a paused workflow run (sets status back to 'running').
 * Used by both operator-paused and approval-gate flows that need to wake the
 * run cleanly. Throws when the run is missing or not in the paused state.
 */
export async function resumeWorkflowRunFromPause(id: string): Promise<void> {
  try {
    const result = await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'running'
       WHERE id = $1 AND status = 'paused'`,
      [id]
    );
    if (result.rowCount === 0) {
      getLog().warn({ workflowRunId: id }, 'db.workflow_run_resume_no_match');
      throw new Error(`Workflow run not found or not in paused state (id: ${id})`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workflow run not found')) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_resume_failed');
    throw new Error(`Failed to resume workflow run: ${err.message}`);
  }
}

/**
 * Pause a running workflow run for human approval.
 * Sets status to 'paused' and stores approval context in metadata.
 * Does NOT set completed_at -- the run is not finished.
 */
export async function pauseWorkflowRun(
  id: string,
  approvalContext: ApprovalContext
): Promise<void> {
  const dialect = getDialect();
  try {
    const result = await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'paused', metadata = ${dialect.jsonMerge('metadata', 2)}
       WHERE id = $1 AND status = 'running'`,
      [id, JSON.stringify({ approval: approvalContext })]
    );
    if (result.rowCount === 0) {
      getLog().warn({ workflowRunId: id }, 'db.workflow_run_pause_no_match');
      throw new Error(`Workflow run not found or not in running state (id: ${id})`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workflow run not found')) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_pause_failed');
    throw new Error(`Failed to pause workflow run: ${err.message}`);
  }
}

/**
 * Enriched workflow run with joined data for the dashboard Command Center.
 */
export interface DashboardWorkflowRun extends WorkflowRun {
  codebase_name: string | null;
  platform_type: string | null;
  worker_platform_id: string | null;
  parent_platform_id: string | null;
  // Step-level progress (from latest step_started/step_completed event)
  current_step_name: string | null;
  total_steps: number | null;
  current_step_status: 'running' | 'completed' | 'failed' | null;
  // Parallel agent progress (from parallel_agent_* events)
  agents_completed: number | null;
  agents_failed: number | null;
  agents_total: number | null;
}

/** Options for listing dashboard runs with server-side search, filtering, and pagination. */
export interface ListDashboardRunsOptions {
  status?: WorkflowRunStatus;
  codebaseId?: string;
  search?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
  /** When false (default), hides archived runs from results. */
  includeArchived?: boolean;
}

/** Response envelope for paginated dashboard runs. */
export interface DashboardRunsResult {
  runs: DashboardWorkflowRun[];
  total: number;
  counts: {
    all: number;
    running: number;
    completed: number;
    failed: number;
    escalated: number;
    cancelled: number;
    pending: number;
    paused: number;
  };
}

/**
 * Build WHERE clauses shared between the list and count queries.
 * Returns the clauses array and values array (mutated in place).
 */
function buildDashboardWhereClauses(
  options: ListDashboardRunsOptions | undefined,
  values: unknown[]
): string[] {
  const whereClauses: string[] = [];

  if (options?.status) {
    values.push(options.status);
    whereClauses.push(`r.status = $${String(values.length)}`);
  }
  if (options?.codebaseId) {
    values.push(options.codebaseId);
    whereClauses.push(`r.codebase_id = $${String(values.length)}`);
  }
  if (options?.search) {
    const pattern = `%${options.search}%`;
    values.push(pattern, pattern);
    whereClauses.push(
      `(r.workflow_name LIKE $${String(values.length - 1)} OR r.user_message LIKE $${String(values.length)})`
    );
  }
  if (options?.after) {
    values.push(options.after);
    whereClauses.push(`r.started_at >= $${String(values.length)}`);
  }
  if (options?.before) {
    values.push(options.before);
    whereClauses.push(`r.started_at < $${String(values.length)}`);
  }
  if (!options?.includeArchived) {
    whereClauses.push('r.archived_at IS NULL');
  }

  return whereClauses;
}

/**
 * Returns a SQL fragment to extract and cast an integer from a JSON data column.
 * Handles SQLite (`json_extract`) and PostgreSQL (`->>`/`::INTEGER`) dialects.
 */
function jsonIntExtract(col: string, key: string): string {
  return getDatabaseType() === 'postgresql'
    ? `(${col}->>'${key}')::INTEGER`
    : `CAST(json_extract(${col}, '$.${key}') AS INTEGER)`;
}

/**
 * List workflow runs with enriched JOINs for the dashboard Command Center.
 * Supports server-side search, status/date filtering, and offset-based pagination.
 * Returns runs, total matching count, and per-status counts for the filter bar.
 */
export async function listDashboardRuns(
  options?: ListDashboardRunsOptions
): Promise<DashboardRunsResult> {
  // Build shared WHERE for both queries
  const listValues: unknown[] = [];
  const whereClauses = buildDashboardWhereClauses(options, listValues);

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  listValues.push(limit);
  const limitParam = `$${String(listValues.length)}`;
  listValues.push(offset);
  const offsetParam = `$${String(listValues.length)}`;

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Build count query with the same base filters MINUS the status filter.
  // This lets us compute per-status counts across the full filtered set.
  const countValues: unknown[] = [];
  const countWhereClauses = buildDashboardWhereClauses(
    options ? { ...options, status: undefined } : undefined,
    countValues
  );
  const countWhereStr =
    countWhereClauses.length > 0 ? `WHERE ${countWhereClauses.join(' AND ')}` : '';

  try {
    const [listResult, countResult] = await Promise.all([
      pool.query<DashboardWorkflowRun>(
        `SELECT r.*,
                c.platform_type,
                c.platform_conversation_id AS worker_platform_id,
                pc.platform_conversation_id AS parent_platform_id,
                cb.name AS codebase_name,
                (SELECT e.step_name
                 FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'step_started'
                 ORDER BY e.created_at DESC LIMIT 1) AS current_step_name,
                (SELECT ${jsonIntExtract('e.data', 'total_steps')}
                 FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'step_started'
                 ORDER BY e.created_at DESC LIMIT 1) AS total_steps,
                CASE (SELECT e2.event_type
                      FROM remote_agent_workflow_events e2
                      WHERE e2.workflow_run_id = r.id
                        AND e2.event_type IN ('step_completed','step_failed','step_started')
                      ORDER BY e2.created_at DESC LIMIT 1)
                  WHEN 'step_completed' THEN 'completed'
                  WHEN 'step_failed' THEN 'failed'
                  WHEN 'step_started' THEN 'running'
                  ELSE NULL
                END AS current_step_status,
                (SELECT COUNT(*) FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_completed') AS agents_completed,
                (SELECT COUNT(*) FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_failed') AS agents_failed,
                (SELECT ${jsonIntExtract('e.data', 'totalAgents')}
                 FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_started'
                 ORDER BY e.created_at DESC LIMIT 1) AS agents_total
         FROM remote_agent_workflow_runs r
         LEFT JOIN remote_agent_conversations c ON r.conversation_id = c.id
         LEFT JOIN remote_agent_conversations pc ON r.parent_conversation_id = pc.id
         LEFT JOIN remote_agent_codebases cb ON r.codebase_id = cb.id
         ${whereStr}
         ORDER BY r.started_at DESC
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        listValues
      ),
      pool.query<{ status: string; cnt: string }>(
        `SELECT r.status, COUNT(*) AS cnt
         FROM remote_agent_workflow_runs r
         ${countWhereStr}
         GROUP BY r.status`,
        countValues
      ),
    ]);

    const counts = {
      all: 0,
      running: 0,
      completed: 0,
      failed: 0,
      escalated: 0,
      cancelled: 0,
      pending: 0,
      paused: 0,
    };
    for (const row of countResult.rows) {
      const n = Number(row.cnt);
      counts.all += n;
      if (row.status in counts) {
        counts[row.status as keyof Omit<typeof counts, 'all'>] = n;
      }
    }

    // Total for the current filter (with status applied)
    const total = options?.status
      ? (counts[options.status as keyof typeof counts] ?? 0)
      : counts.all;

    return { runs: listResult.rows.map(normalizeWorkflowRun), total, counts };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'list_dashboard_runs_failed');
    throw new Error(`Failed to list dashboard runs: ${err.message}`);
  }
}

/**
 * List workflow runs with optional filters.
 */
export async function listWorkflowRuns(options?: {
  conversationId?: string;
  status?: WorkflowRunStatus | WorkflowRunStatus[];
  limit?: number;
  codebaseId?: string;
  includeArchived?: boolean;
}): Promise<WorkflowRun[]> {
  const whereClauses: string[] = [];
  const values: unknown[] = [];

  if (options?.conversationId) {
    values.push(options.conversationId);
    whereClauses.push(`conversation_id = $${String(values.length)}`);
  }
  if (options?.status !== undefined) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    if (statuses.length > 0) {
      const startIdx = values.length + 1;
      values.push(...statuses);
      const placeholders = statuses.map((_, i) => `$${String(startIdx + i)}`).join(', ');
      whereClauses.push(`status IN (${placeholders})`);
    }
  }
  if (options?.codebaseId) {
    values.push(options.codebaseId);
    whereClauses.push(
      `conversation_id IN (SELECT id FROM remote_agent_conversations WHERE codebase_id = $${String(values.length)})`
    );
  }
  if (!options?.includeArchived) {
    whereClauses.push('archived_at IS NULL');
  }

  const limit = options?.limit ?? 50;
  values.push(limit);
  const limitParam = `$${String(values.length)}`;

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs ${whereStr} ORDER BY started_at DESC LIMIT ${limitParam}`,
      values
    );
    return result.rows.map(normalizeWorkflowRun);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_list_failed');
    throw new Error(`Failed to list workflow runs: ${err.message}`);
  }
}

/**
 * Sum metadata.total_tokens across runs whose activity timestamp falls inside
 * the given window (sinceMs .. now).
 *
 * Activity timestamp = COALESCE(last_activity_at, started_at) -- matches the
 * fallback used by the runs API quota-window summary.
 *
 * This is a DEDICATED full-window aggregation; it is NOT bounded by the
 * runs-list pagination LIMIT. Callers (currently `computeQuotaWindow` in the
 * server runs API) use this for the derived Max-20x quota summary so the
 * `windowTokens` figure reflects ALL in-window runs, not just the current
 * page (which under-reports whenever in-window runs spill past the page).
 *
 * Returns 0 when no run in the window has a `metadata.total_tokens` value.
 */
export async function sumWorkflowTokensInWindow(options: {
  sinceMs: number;
  codebaseId?: string;
}): Promise<number> {
  const isPostgres = getDatabaseType() === 'postgresql';
  const values: unknown[] = [];

  // Serialize as ISO so bun:sqlite accepts it (no Date bindings).
  const sinceIso = new Date(options.sinceMs).toISOString();
  values.push(sinceIso);
  const sinceParam = `$${String(values.length)}`;

  // Activity comparison. SQLite stores timestamps as TEXT in
  // "YYYY-MM-DD HH:MM:SS" format; lexical comparison vs an ISO "T"-separated
  // string is wrong (see `findActiveWorkflowRunByPath` for the same gotcha).
  // Wrap both sides in datetime() for SQLite; cast to timestamptz for PG.
  const activityExpr = isPostgres
    ? 'COALESCE(last_activity_at, started_at)'
    : 'datetime(COALESCE(last_activity_at, started_at))';
  const sinceExpr = isPostgres ? `${sinceParam}::timestamptz` : `datetime(${sinceParam})`;

  // total_tokens JSONB extraction (mirrors jsonIntExtract; widened to BIGINT
  // on PG so large sums do not overflow INT4).
  const tokenExpr = isPostgres
    ? "(metadata->>'total_tokens')::BIGINT"
    : "CAST(json_extract(metadata, '$.total_tokens') AS INTEGER)";

  const whereClauses: string[] = [
    `${activityExpr} >= ${sinceExpr}`,
    'archived_at IS NULL',
    `${tokenExpr} IS NOT NULL`,
  ];
  if (options.codebaseId) {
    values.push(options.codebaseId);
    whereClauses.push(
      `conversation_id IN (SELECT id FROM remote_agent_conversations WHERE codebase_id = $${String(values.length)})`
    );
  }

  try {
    const result = await pool.query<{ sum_tokens: string | number | null }>(
      `SELECT COALESCE(SUM(${tokenExpr}), 0) AS sum_tokens
       FROM remote_agent_workflow_runs
       WHERE ${whereClauses.join(' AND ')}`,
      values
    );
    const raw = result.rows[0]?.sum_tokens;
    if (raw === null || raw === undefined) return 0;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_token_window_sum_failed');
    throw new Error(`Failed to sum workflow tokens in window: ${err.message}`);
  }
}

/**
 * Update parent_conversation_id on a workflow run.
 * Non-critical -- logs error but does not throw.
 */
export async function updateWorkflowRunParent(
  runId: string,
  parentConversationId: string
): Promise<void> {
  try {
    await pool.query(
      'UPDATE remote_agent_workflow_runs SET parent_conversation_id = $1 WHERE id = $2',
      [parentConversationId, runId]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId, parentConversationId }, 'db.workflow_run_update_parent_failed');
    // Non-critical -- don't throw
  }
}

/**
 * Update last_activity_at timestamp for a workflow run.
 * Used for activity-based staleness detection.
 * Throws on failure so callers can track consecutive failures.
 */
export async function updateWorkflowActivity(id: string): Promise<void> {
  const dialect = getDialect();
  await pool.query(
    `UPDATE remote_agent_workflow_runs SET last_activity_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
}

/** Compatibility wrapper for legacy callers. Only expired leased runs are interrupted. */
export async function failOrphanedRuns(): Promise<{ count: number }> {
  try {
    const now = new Date().toISOString();
    const candidates = await listExpiredRunLeases(now);
    let count = 0;
    for (const candidate of candidates) {
      if (
        await interruptExpiredRunLease({
          runId: candidate.runId,
          leaseToken: candidate.leaseToken,
          expiredAt: now,
          interruptedAt: now,
        })
      ) {
        count += 1;
      }
    }
    if (count > 0) {
      getLog().info({ count }, 'db.orphaned_workflow_runs_interrupted');
    }
    return { count };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.orphaned_workflow_runs_reconcile_failed');
    throw new Error(`Failed to reconcile orphaned workflow runs: ${err.message}`);
  }
}

/**
 * Cancel all 'running' workflow runs with no activity in the last `staleSinceMinutes` minutes.
 * Returns the count and IDs of cancelled runs for event-logging by the caller.
 */
export async function cancelStaleWorkflowRuns(
  staleSinceMinutes: number
): Promise<{ count: number; ids: string[] }> {
  if (!Number.isInteger(staleSinceMinutes) || staleSinceMinutes < 1) {
    throw new Error(
      `Invalid staleSinceMinutes: ${String(staleSinceMinutes)} (must be a positive integer)`
    );
  }
  const dialect = getDialect();
  const cutoff =
    getDatabaseType() === 'postgresql'
      ? `NOW() - INTERVAL '${String(staleSinceMinutes)} minutes'`
      : `datetime('now', '-${String(staleSinceMinutes)} minutes')`;

  // SELECT first (SQLite does not support RETURNING on UPDATE)
  let ids: string[];
  try {
    const selectResult = await pool.query<{ id: string }>(
      `SELECT id FROM remote_agent_workflow_runs
       WHERE status = 'running'
         AND (last_activity_at IS NULL OR last_activity_at < ${cutoff})`,
      []
    );
    ids = selectResult.rows.map(r => r.id);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, staleSinceMinutes }, 'db.workflow_runs_cancel_stale_select_failed');
    throw new Error(`Failed to query stale workflow runs: ${err.message}`);
  }

  if (ids.length === 0) return { count: 0, ids: [] };

  try {
    const placeholders = ids.map((_, i) => `$${String(i + 1)}`).join(', ');
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'cancelled', completed_at = ${dialect.now()}
       WHERE id IN (${placeholders})`,
      ids
    );
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, staleSinceMinutes, count: ids.length },
      'db.workflow_runs_cancel_stale_update_failed'
    );
    throw new Error(`Failed to cancel stale workflow runs: ${err.message}`);
  }

  getLog().info({ count: ids.length, staleSinceMinutes }, 'db.workflow_runs_stale_cancelled');
  return { count: ids.length, ids };
}

/**
 * Delete terminal workflow runs older than the given number of days.
 * Returns the count of deleted runs.
 */
export async function deleteOldWorkflowRuns(olderThanDays: number): Promise<{ count: number }> {
  // Validate olderThanDays is a safe non-negative integer before SQL interpolation.
  // The dialect has no "date subtract" helper, so we must interpolate -- but only after validation.
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
    throw new Error(
      `Invalid olderThanDays: ${String(olderThanDays)} (must be a non-negative integer)`
    );
  }
  const cutoff =
    getDatabaseType() === 'postgresql'
      ? `NOW() - INTERVAL '${String(olderThanDays)} days'`
      : `datetime('now', '-${String(olderThanDays)} days')`;
  try {
    await pool.query('BEGIN', []);
    // Delete events first (FK reference)
    await pool.query(
      `DELETE FROM remote_agent_workflow_events WHERE workflow_run_id IN (
        SELECT id FROM remote_agent_workflow_runs
        WHERE status IN ('completed', 'failed', 'escalated', 'cancelled')
          AND started_at < ${cutoff}
      )`,
      []
    );
    const result = await pool.query(
      `DELETE FROM remote_agent_workflow_runs
       WHERE status IN ('completed', 'failed', 'escalated', 'cancelled')
         AND started_at < ${cutoff}`,
      []
    );
    await pool.query('COMMIT', []);
    return { count: result.rowCount ?? 0 };
  } catch (error) {
    await rollback();
    const err = error as Error;
    getLog().error({ err, olderThanDays }, 'db.workflow_runs_cleanup_failed');
    throw new Error(`Failed to clean up old workflow runs: ${err.message}`);
  }
}

/**
 * Delete a workflow run and its associated events.
 * Only terminal runs can be deleted. By default requires archived_at IS NOT NULL.
 * Pass force=true to bypass the archive guard (operator-confirmed override).
 */
export async function deleteWorkflowRun(id: string, force = false): Promise<void> {
  try {
    await pool.query('BEGIN', []);
    // Guard: verify run exists and is terminal before deleting
    const check = await pool.query<{ status: string; archived_at: Date | null }>(
      'SELECT status, archived_at FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    if (check.rows.length === 0) {
      throw new WorkflowRunGuardError(`Workflow run not found: ${id}`);
    }
    if (!TERMINAL_WORKFLOW_STATUSES.includes(check.rows[0].status as WorkflowRunStatus)) {
      throw new WorkflowRunGuardError(
        `Cannot delete workflow run in '${check.rows[0].status}' status -- cancel it first`
      );
    }
    if (!force && check.rows[0].archived_at == null) {
      throw new WorkflowRunGuardError(
        'Archive the run first before deleting (or pass force=true to bypass)'
      );
    }
    await pool.query('DELETE FROM remote_agent_workflow_events WHERE workflow_run_id = $1', [id]);
    await pool.query('DELETE FROM remote_agent_workflow_runs WHERE id = $1', [id]);
    await pool.query('COMMIT', []);
  } catch (error) {
    await rollback();
    if (error instanceof WorkflowRunGuardError) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_delete_failed');
    throw new Error(`Failed to delete workflow run: ${err.message}`);
  }
}

/**
 * Archive a workflow run (soft-hide from default dashboard view).
 * Running runs cannot be archived -- cancel first.
 * Idempotent: re-archiving an already-archived run is a no-op.
 */
export async function archiveWorkflowRun(
  id: string,
  archivedBy = 'operator',
  reason?: string
): Promise<void> {
  const dialect = getDialect();
  try {
    const check = await pool.query<{ status: string; archived_at: Date | null }>(
      'SELECT status, archived_at FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    if (check.rows.length === 0) {
      throw new WorkflowRunGuardError(`Workflow run not found: ${id}`);
    }
    if (check.rows[0].status === 'running' || check.rows[0].status === 'pending') {
      throw new WorkflowRunGuardError(
        `Cannot archive workflow run in '${check.rows[0].status}' status -- cancel first, then archive`
      );
    }
    if (check.rows[0].archived_at != null) {
      // Already archived -- idempotent no-op
      return;
    }
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET archived_at = ${dialect.now()}, archived_by = $1, archive_reason = $2
       WHERE id = $3`,
      [archivedBy, reason ?? null, id]
    );
    getLog().info(
      { workflowRunId: id, archivedBy, reason, action: 'archive' },
      'workflow_run.archived'
    );
  } catch (error) {
    if (error instanceof WorkflowRunGuardError) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_archive_failed');
    throw new Error(`Failed to archive workflow run: ${err.message}`);
  }
}

/**
 * Unarchive a workflow run (restore to default dashboard view).
 * Idempotent: unarchiving an active run is a no-op.
 */
export async function unarchiveWorkflowRun(id: string): Promise<void> {
  try {
    const check = await pool.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    if (check.rows.length === 0) {
      throw new WorkflowRunGuardError(`Workflow run not found: ${id}`);
    }
    if (check.rows[0].archived_at == null) {
      // Already active -- idempotent no-op
      return;
    }
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET archived_at = NULL, archived_by = NULL, archive_reason = NULL
       WHERE id = $1`,
      [id]
    );
    getLog().info({ workflowRunId: id, action: 'unarchive' }, 'workflow_run.unarchived');
  } catch (error) {
    if (error instanceof WorkflowRunGuardError) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_unarchive_failed');
    throw new Error(`Failed to unarchive workflow run: ${err.message}`);
  }
}

/** Result from bulk archive operation. */
export interface BulkArchiveResult {
  archivedCount: number;
  runIds: string[];
}

/**
 * Bulk-archive all runs matching the given status (and optional olderThan cutoff).
 * Skips running/pending runs and already-archived runs (idempotent).
 */
export async function bulkArchiveWorkflowRuns(options: {
  status: 'failed' | 'cancelled' | 'completed';
  olderThan?: string;
  archivedBy?: string;
}): Promise<BulkArchiveResult> {
  const dialect = getDialect();
  const { status, olderThan, archivedBy = 'operator' } = options;

  const values: unknown[] = [status, archivedBy];
  let olderThanClause = '';
  if (olderThan) {
    values.push(olderThan);
    olderThanClause = `AND started_at < $${String(values.length)}`;
  }

  try {
    // Collect IDs first so we can return them
    const selectResult = await pool.query<{ id: string }>(
      `SELECT id FROM remote_agent_workflow_runs
       WHERE status = $1
         AND archived_at IS NULL
         ${olderThanClause}`,
      olderThan ? [status, olderThan] : [status]
    );
    const runIds = selectResult.rows.map(r => r.id);
    if (runIds.length === 0) {
      return { archivedCount: 0, runIds: [] };
    }

    const placeholders = runIds.map((_, i) => `$${String(i + 3)}`).join(', ');
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET archived_at = ${dialect.now()}, archived_by = $2, archive_reason = NULL
       WHERE id IN (${placeholders})`,
      [status, archivedBy, ...runIds]
    );
    getLog().info(
      { archivedCount: runIds.length, status, archivedBy, action: 'bulk_archive' },
      'workflow_run.bulk_archived'
    );
    return { archivedCount: runIds.length, runIds };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, status }, 'db.workflow_run_bulk_archive_failed');
    throw new Error(`Failed to bulk archive workflow runs: ${err.message}`);
  }
}

/** Result from bulk delete operation. */
export interface BulkDeleteResult {
  deletedCount: number;
  runIds: string[];
}

/**
 * Bulk-delete archived runs with status='failed' (and optional olderThan cutoff).
 * dryRun=true returns the list without deleting.
 * Cascades to workflow_events via ON DELETE CASCADE.
 * Worktree directories on disk are NOT touched.
 */
export async function bulkDeleteArchivedFailedRuns(options: {
  olderThan?: string;
  dryRun?: boolean;
}): Promise<BulkDeleteResult> {
  const { olderThan, dryRun = false } = options;

  const values: unknown[] = [];
  let olderThanClause = '';
  if (olderThan) {
    values.push(olderThan);
    olderThanClause = `AND started_at < $${String(values.length)}`;
  }

  try {
    const selectResult = await pool.query<{ id: string }>(
      `SELECT id FROM remote_agent_workflow_runs
       WHERE status = 'failed'
         AND archived_at IS NOT NULL
         ${olderThanClause}`,
      values
    );
    const runIds = selectResult.rows.map(r => r.id);
    if (runIds.length === 0 || dryRun) {
      getLog().info(
        { count: runIds.length, dryRun, action: 'bulk_delete_failed' },
        'workflow_run.bulk_delete_failed_preview'
      );
      return { deletedCount: runIds.length, runIds };
    }

    const placeholders = runIds.map((_, i) => `$${String(i + 1)}`).join(', ');
    await pool.query('BEGIN', []);
    await pool.query(
      `DELETE FROM remote_agent_workflow_events WHERE workflow_run_id IN (${placeholders})`,
      runIds
    );
    const deleteResult = await pool.query(
      `DELETE FROM remote_agent_workflow_runs WHERE id IN (${placeholders})`,
      runIds
    );
    await pool.query('COMMIT', []);
    const deletedCount = deleteResult.rowCount ?? runIds.length;
    getLog().info(
      { deletedCount, action: 'bulk_delete_failed' },
      'workflow_run.bulk_deleted_failed'
    );
    return { deletedCount, runIds };
  } catch (error) {
    await rollback();
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_bulk_delete_failed_error');
    throw new Error(`Failed to bulk delete failed workflow runs: ${err.message}`);
  }
}
