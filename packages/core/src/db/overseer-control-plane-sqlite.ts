/**
 * Isolated SQLite parity installer for the Overseer control plane
 * (WO-HARNESS-OVERSEER-CONTROL-PLANE-01).
 *
 * Mirrors migrations/037_overseer_control_plane.sql for file-backed SQLite. This
 * module is the ONLY place that issues BEGIN IMMEDIATE for control-plane
 * mutations; the shared SQLite adapter (deferred BEGIN) is intentionally not used.
 * Slice 8 owns registration of the reviewed schema into the shared adapter.
 */
import type { IDatabase, QueryResult } from './adapters/types';

/** Transaction-scoped query function passed to the immediate-transaction callback. */
export type ControlPlaneTxQuery = <U>(sql: string, params?: unknown[]) => Promise<QueryResult<U>>;

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS overseer_parent_commitments (
    parent_id TEXT PRIMARY KEY CHECK (length(parent_id) > 0),
    state TEXT NOT NULL CHECK (state IN (
      'BUILDING', 'REVIEW', 'STAGING', 'RECOVERY', 'ACTION_PENDING',
      'COMPLETED', 'FAILED', 'CANCELLED'
    )),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
    correlation_id TEXT NOT NULL UNIQUE CHECK (length(correlation_id) > 0),
    fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
    admitted_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    released_at TEXT,
    terminal_reason TEXT,
    CHECK (julianday(lease_expires_at) > julianday(heartbeat_at)),
    CHECK (
      (state IN ('BUILDING', 'REVIEW', 'STAGING', 'RECOVERY', 'ACTION_PENDING')
        AND released_at IS NULL AND terminal_reason IS NULL)
      OR
      (state IN ('COMPLETED', 'FAILED', 'CANCELLED')
        AND released_at IS NOT NULL AND terminal_reason IS NOT NULL
        AND length(terminal_reason) > 0)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS overseer_parent_commitments_active
    ON overseer_parent_commitments(state)
    WHERE state IN ('BUILDING', 'REVIEW', 'STAGING', 'RECOVERY', 'ACTION_PENDING')`,
  `CREATE TABLE IF NOT EXISTS overseer_parent_children (
    parent_id TEXT NOT NULL REFERENCES overseer_parent_commitments(parent_id),
    child_id TEXT NOT NULL UNIQUE CHECK (length(child_id) > 0),
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    created_at TEXT NOT NULL,
    terminal_at TEXT,
    PRIMARY KEY (parent_id, child_id),
    CHECK (
      (state IN ('PENDING', 'RUNNING') AND terminal_at IS NULL)
      OR
      (state IN ('COMPLETED', 'FAILED', 'CANCELLED') AND terminal_at IS NOT NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS overseer_repository_mutation_leases (
    repository TEXT PRIMARY KEY CHECK (length(repository) > 0),
    lease_id TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
    execution_id TEXT NOT NULL CHECK (length(execution_id) > 0),
    action_kind TEXT NOT NULL CHECK (length(action_kind) > 0),
    capability TEXT NOT NULL CHECK (length(capability) > 0),
    fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
    state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'RELEASED', 'EXPIRED')),
    acquired_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT,
    CHECK (
      (state = 'ACTIVE' AND released_at IS NULL AND julianday(expires_at) > julianday(heartbeat_at))
      OR
      (state IN ('RELEASED', 'EXPIRED') AND released_at IS NOT NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS overseer_verifier_registries (
    registry_digest TEXT PRIMARY KEY CHECK (length(registry_digest) = 64 AND registry_digest NOT GLOB '*[^0-9a-f]*'),
    schema_version TEXT NOT NULL CHECK (schema_version = 'overseer-verifier-registry-v1'),
    frozen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    source_artifact_path TEXT NOT NULL CHECK (length(source_artifact_path) > 0),
    source_git_blob TEXT NOT NULL CHECK (length(source_git_blob) > 0)
  )`,
  `CREATE TABLE IF NOT EXISTS overseer_verifier_entries (
    registry_digest TEXT NOT NULL REFERENCES overseer_verifier_registries(registry_digest),
    verifier_id TEXT NOT NULL CHECK (length(verifier_id) > 0 AND verifier_id NOT GLOB '*[^a-z0-9._/-]*' AND substr(verifier_id, 1, 1) GLOB '[a-z0-9]'),
    provider TEXT NOT NULL CHECK (length(provider) > 0 AND provider NOT GLOB '*[^a-z0-9._/-]*' AND substr(provider, 1, 1) GLOB '[a-z0-9]'),
    model_family TEXT NOT NULL CHECK (length(model_family) > 0 AND model_family NOT GLOB '*[^a-z0-9._/-]*' AND substr(model_family, 1, 1) GLOB '[a-z0-9]'),
    roles_json TEXT NOT NULL CHECK (json_valid(roles_json) AND json_type(roles_json) = 'array' AND json_array_length(roles_json) > 0),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    PRIMARY KEY (registry_digest, verifier_id)
  )`,
  `CREATE TRIGGER IF NOT EXISTS overseer_verifier_entries_roles_valid
    BEFORE INSERT ON overseer_verifier_entries BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.roles_json)
        WHERE json_each.value NOT IN ('REVIEWER', 'RED_TEAM', 'FUSION', 'MERGE_STEWARD')
      ) THEN RAISE(ABORT, 'invalid verifier role') END;
    END`,
  `CREATE TABLE IF NOT EXISTS overseer_fusion_budget_reservations (
    reservation_id TEXT PRIMARY KEY CHECK (length(reservation_id) > 0),
    call_id TEXT NOT NULL UNIQUE CHECK (length(call_id) > 0),
    proposal_id TEXT NOT NULL CHECK (length(proposal_id) > 0),
    execution_id TEXT NOT NULL CHECK (length(execution_id) > 0),
    provider TEXT NOT NULL CHECK (length(provider) > 0),
    model TEXT NOT NULL CHECK (length(model) > 0),
    call_kind TEXT NOT NULL CHECK (call_kind IN ('PRIMARY', 'RETRY', 'FALLBACK', 'INDIRECT')),
    utc_day TEXT NOT NULL CHECK (utc_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    utc_month TEXT NOT NULL CHECK (utc_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    requested_microusd INTEGER NOT NULL CHECK (requested_microusd BETWEEN 1 AND 3000000),
    actual_microusd INTEGER CHECK (actual_microusd IS NULL OR actual_microusd >= 0),
    status TEXT NOT NULL CHECK (status IN ('RESERVED', 'IN_FLIGHT', 'RECONCILED', 'RELEASED')),
    reserved_at TEXT NOT NULL,
    call_started_at TEXT,
    reconciled_at TEXT,
    released_at TEXT,
    CHECK (
      (status = 'RESERVED' AND call_started_at IS NULL AND actual_microusd IS NULL
        AND reconciled_at IS NULL AND released_at IS NULL)
      OR
      (status = 'IN_FLIGHT' AND call_started_at IS NOT NULL AND actual_microusd IS NULL
        AND reconciled_at IS NULL AND released_at IS NULL)
      OR
      (status = 'RECONCILED' AND call_started_at IS NOT NULL AND actual_microusd IS NOT NULL
        AND reconciled_at IS NOT NULL AND released_at IS NULL)
      OR
      (status = 'RELEASED' AND call_started_at IS NULL AND actual_microusd IS NULL
        AND reconciled_at IS NULL AND released_at IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS overseer_fusion_budget_day
    ON overseer_fusion_budget_reservations(utc_day)`,
  `CREATE INDEX IF NOT EXISTS overseer_fusion_budget_month
    ON overseer_fusion_budget_reservations(utc_month)`,
  `CREATE TABLE IF NOT EXISTS overseer_control_events (
    event_id TEXT PRIMARY KEY CHECK (event_id LIKE 'ocp-event-%' AND length(event_id) = 46 AND substr(event_id, 11) NOT GLOB '*[^0-9a-f-]*'),
    resource_kind TEXT NOT NULL CHECK (resource_kind IN (
      'PARENT', 'CHILD', 'REPOSITORY_LEASE', 'VERIFIER_REGISTRY', 'FUSION_BUDGET'
    )),
    resource_key TEXT NOT NULL CHECK (length(resource_key) > 0),
    event_kind TEXT NOT NULL CHECK (event_kind IN (
      'ADMITTED', 'HEARTBEAT', 'STATE_CHANGED', 'CHILD_LINKED', 'CRASH_RECONCILED',
      'LEASE_ACQUIRED', 'LEASE_TAKEN_OVER', 'LEASE_RELEASED', 'REGISTRY_FROZEN',
      'BUDGET_RESERVED', 'BUDGET_CALL_STARTED', 'BUDGET_RECONCILED',
      'BUDGET_OVERAGE_RECORDED', 'BUDGET_RELEASED'
    )),
    actor TEXT NOT NULL CHECK (length(actor) > 0),
    event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
    previous_event_digest TEXT CHECK (previous_event_digest IS NULL OR (length(previous_event_digest) = 64 AND previous_event_digest NOT GLOB '*[^0-9a-f]*')),
    event_digest TEXT NOT NULL UNIQUE CHECK (length(event_digest) = 64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    UNIQUE (resource_kind, resource_key, event_sequence),
    CHECK (
      (event_sequence = 1 AND previous_event_digest IS NULL)
      OR
      (event_sequence > 1 AND previous_event_digest IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS overseer_control_events_stream
    ON overseer_control_events(resource_kind, resource_key, event_sequence)`,
] as const;

const APPEND_ONLY_TABLES = [
  'overseer_verifier_registries',
  'overseer_verifier_entries',
  'overseer_control_events',
] as const;

// State/lease/budget tables reject DELETE and reject identity/regression updates.
const GUARDED_UPDATE_TRIGGERS: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS overseer_parent_commitments_guard_update
    BEFORE UPDATE ON overseer_parent_commitments BEGIN
      SELECT CASE
        WHEN NEW.parent_id <> OLD.parent_id OR NEW.correlation_id <> OLD.correlation_id
          OR NEW.admitted_at <> OLD.admitted_at
          THEN RAISE(ABORT, 'overseer_parent_commitments identity is immutable')
        WHEN NEW.fencing_token < OLD.fencing_token
          THEN RAISE(ABORT, 'overseer_parent_commitments fencing token cannot decrease')
        WHEN OLD.state IN ('COMPLETED', 'FAILED', 'CANCELLED')
          THEN RAISE(ABORT, 'overseer_parent_commitments terminal rows are immutable')
      END;
    END`,
  `CREATE TRIGGER IF NOT EXISTS overseer_parent_children_guard_update
    BEFORE UPDATE ON overseer_parent_children BEGIN
      SELECT CASE
        WHEN NEW.parent_id <> OLD.parent_id OR NEW.child_id <> OLD.child_id
          OR NEW.created_at <> OLD.created_at
          THEN RAISE(ABORT, 'overseer_parent_children identity is immutable')
        WHEN OLD.state IN ('COMPLETED', 'FAILED', 'CANCELLED')
          THEN RAISE(ABORT, 'overseer_parent_children terminal rows are immutable')
      END;
    END`,
  `CREATE TRIGGER IF NOT EXISTS overseer_repository_mutation_leases_guard_update
    BEFORE UPDATE ON overseer_repository_mutation_leases BEGIN
      SELECT CASE
        WHEN NEW.repository <> OLD.repository
          THEN RAISE(ABORT, 'overseer_repository_mutation_leases repository is immutable')
        WHEN NEW.fencing_token < OLD.fencing_token
          THEN RAISE(ABORT, 'overseer_repository_mutation_leases fencing token cannot decrease')
      END;
    END`,
  `CREATE TRIGGER IF NOT EXISTS overseer_fusion_budget_reservations_guard_update
    BEFORE UPDATE ON overseer_fusion_budget_reservations BEGIN
      SELECT CASE
        WHEN NEW.reservation_id <> OLD.reservation_id OR NEW.call_id <> OLD.call_id
          OR NEW.requested_microusd <> OLD.requested_microusd
          OR NEW.utc_day <> OLD.utc_day OR NEW.utc_month <> OLD.utc_month
          OR NEW.reserved_at <> OLD.reserved_at
          THEN RAISE(ABORT, 'overseer_fusion_budget_reservations identity is immutable')
        WHEN OLD.status IN ('RECONCILED', 'RELEASED')
          THEN RAISE(ABORT, 'overseer_fusion_budget_reservations terminal rows are immutable')
      END;
    END`,
];

const NO_DELETE_TABLES = [
  'overseer_parent_commitments',
  'overseer_parent_children',
  'overseer_repository_mutation_leases',
  'overseer_fusion_budget_reservations',
] as const;

export const OVERSEER_CONTROL_PLANE_TABLES = [
  'overseer_parent_commitments',
  'overseer_parent_children',
  'overseer_repository_mutation_leases',
  'overseer_verifier_registries',
  'overseer_verifier_entries',
  'overseer_fusion_budget_reservations',
  'overseer_control_events',
] as const;

/**
 * Install the control-plane schema into a file-backed SQLite database. Rejects a
 * non-SQLite database. Idempotent (every statement uses IF NOT EXISTS).
 */
export async function installOverseerControlPlaneSqlite(db: IDatabase): Promise<void> {
  if (db.dialect !== 'sqlite') {
    throw new Error('overseer_control_plane_sqlite_installer_wrong_dialect');
  }
  for (const sql of SQLITE_STATEMENTS) await db.query(sql);
  for (const table of APPEND_ONLY_TABLES) {
    await db.query(
      `CREATE TRIGGER IF NOT EXISTS ${table}_reject_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`
    );
    await db.query(
      `CREATE TRIGGER IF NOT EXISTS ${table}_reject_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`
    );
  }
  for (const table of NO_DELETE_TABLES) {
    await db.query(
      `CREATE TRIGGER IF NOT EXISTS ${table}_reject_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} rows cannot be deleted'); END`
    );
  }
  for (const sql of GUARDED_UPDATE_TRIGGERS) await db.query(sql);
}

// Per-database in-progress guard so a reentrant (nested) call is rejected rather
// than corrupting an open SQLite write transaction.
const activeImmediateTransactions = new WeakSet<IDatabase>();

/**
 * Run `fn` inside a SQLite `BEGIN IMMEDIATE` transaction. This is the ONLY helper
 * that issues BEGIN IMMEDIATE for control-plane mutations. It commits on success
 * and rolls back on any thrown error. It rejects a non-SQLite database and rejects
 * nested (reentrant) use on the same database.
 */
export async function withOverseerControlPlaneImmediateTransaction<T>(
  database: IDatabase,
  fn: (query: ControlPlaneTxQuery) => Promise<T>
): Promise<T> {
  if (database.dialect !== 'sqlite') {
    throw new Error('overseer_control_plane_immediate_transaction_wrong_dialect');
  }
  if (activeImmediateTransactions.has(database)) {
    throw new Error('overseer_control_plane_immediate_transaction_nested');
  }
  activeImmediateTransactions.add(database);
  try {
    await database.query('BEGIN IMMEDIATE');
    try {
      const result = await fn(database.query.bind(database) as ControlPlaneTxQuery);
      await database.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await database.query('ROLLBACK');
      } catch {
        /* rollback best-effort; original error is surfaced */
      }
      throw error;
    }
  } finally {
    activeImmediateTransactions.delete(database);
  }
}
