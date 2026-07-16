import { AsyncLocalStorage } from 'node:async_hooks';
import type { IDatabase, QueryResult } from './adapters/types';

export type OverseerControlPlaneQuery = <T>(
  sql: string,
  params?: unknown[]
) => Promise<QueryResult<T>>;

const transactionContext = new AsyncLocalStorage<IDatabase>();
let transactionTail: Promise<void> = Promise.resolve();

export async function withOverseerControlPlaneImmediateTransaction<T>(
  database: IDatabase,
  fn: (query: OverseerControlPlaneQuery) => Promise<T>
): Promise<T> {
  if (database.dialect !== 'sqlite') {
    throw new Error('overseer_control_plane_immediate_transaction_wrong_dialect');
  }
  if (transactionContext.getStore() === database) {
    throw new Error('overseer_control_plane_immediate_transaction_nested');
  }

  const prior = transactionTail;
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  transactionTail = prior.then(() => current);
  await prior;

  try {
    return await transactionContext.run(database, async () => {
      await database.query('BEGIN IMMEDIATE');
      try {
        const result = await fn(database.query.bind(database));
        await database.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await database.query('ROLLBACK');
        } catch {
          // Preserve the original transaction failure.
        }
        throw error;
      }
    });
  } finally {
    release();
  }
}

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS overseer_parent_commitments (
    parent_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING','COMPLETED','FAILED','CANCELLED')),
    owner_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL UNIQUE,
    fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
    admitted_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at) = admitted_at),
    heartbeat_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', heartbeat_at) = heartbeat_at),
    lease_expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) = lease_expires_at),
    released_at TEXT CHECK (released_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', released_at) = released_at),
    terminal_reason TEXT,
    CHECK (julianday(lease_expires_at) > julianday(heartbeat_at)),
    CHECK (
      (state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING') AND released_at IS NULL AND terminal_reason IS NULL) OR
      (state IN ('COMPLETED','FAILED','CANCELLED') AND released_at IS NOT NULL AND length(trim(terminal_reason)) > 0)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS overseer_parent_children (
    parent_id TEXT NOT NULL REFERENCES overseer_parent_commitments(parent_id),
    child_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
    created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
    terminal_at TEXT CHECK (terminal_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', terminal_at) = terminal_at),
    PRIMARY KEY (parent_id, child_id),
    CHECK (
      (state IN ('PENDING','RUNNING') AND terminal_at IS NULL) OR
      (state IN ('COMPLETED','FAILED','CANCELLED') AND terminal_at IS NOT NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS overseer_repository_mutation_leases (
    repository TEXT PRIMARY KEY,
    lease_id TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    action_kind TEXT NOT NULL,
    capability TEXT NOT NULL,
    fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
    state TEXT NOT NULL CHECK (state IN ('ACTIVE','RELEASED','EXPIRED')),
    acquired_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', acquired_at) = acquired_at),
    heartbeat_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', heartbeat_at) = heartbeat_at),
    expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at),
    released_at TEXT CHECK (released_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', released_at) = released_at),
    CHECK (julianday(expires_at) > julianday(heartbeat_at)),
    CHECK (
      (state = 'ACTIVE' AND released_at IS NULL) OR
      (state IN ('RELEASED','EXPIRED') AND released_at IS NOT NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS overseer_verifier_registries (
    registry_digest TEXT PRIMARY KEY CHECK (length(registry_digest) = 64 AND registry_digest NOT GLOB '*[^0-9a-f]*'),
    schema_version TEXT NOT NULL CHECK (schema_version = 'overseer-verifier-registry-v1'),
    frozen_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', frozen_at) = frozen_at),
    created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
    source_artifact_path TEXT NOT NULL,
    source_git_blob TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS overseer_verifier_entries (
    registry_digest TEXT NOT NULL REFERENCES overseer_verifier_registries(registry_digest),
    verifier_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model_family TEXT NOT NULL,
    roles_json TEXT NOT NULL CHECK (json_valid(roles_json)),
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
    PRIMARY KEY (registry_digest, verifier_id)
  )`,
  `CREATE TABLE IF NOT EXISTS overseer_fusion_budget_reservations (
    reservation_id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL UNIQUE,
    proposal_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    call_kind TEXT NOT NULL CHECK (call_kind IN ('PRIMARY','RETRY','FALLBACK','INDIRECT')),
    utc_day TEXT NOT NULL CHECK (utc_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    utc_month TEXT NOT NULL CHECK (utc_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    requested_microusd INTEGER NOT NULL CHECK (requested_microusd BETWEEN 1 AND 3000000),
    actual_microusd INTEGER CHECK (actual_microusd IS NULL OR actual_microusd >= 0),
    status TEXT NOT NULL CHECK (status IN ('RESERVED','IN_FLIGHT','RECONCILED','RELEASED')),
    reserved_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', reserved_at) = reserved_at),
    call_started_at TEXT CHECK (call_started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', call_started_at) = call_started_at),
    reconciled_at TEXT CHECK (reconciled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', reconciled_at) = reconciled_at),
    released_at TEXT CHECK (released_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', released_at) = released_at),
    release_reason TEXT,
    CHECK (
      (status = 'RESERVED' AND call_started_at IS NULL AND actual_microusd IS NULL AND reconciled_at IS NULL AND released_at IS NULL AND release_reason IS NULL) OR
      (status = 'IN_FLIGHT' AND call_started_at IS NOT NULL AND actual_microusd IS NULL AND reconciled_at IS NULL AND released_at IS NULL AND release_reason IS NULL) OR
      (status = 'RECONCILED' AND call_started_at IS NOT NULL AND actual_microusd IS NOT NULL AND reconciled_at IS NOT NULL AND released_at IS NULL AND release_reason IS NULL) OR
      (status = 'RELEASED' AND call_started_at IS NULL AND actual_microusd IS NULL AND reconciled_at IS NULL AND released_at IS NOT NULL AND length(trim(release_reason)) > 0)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS overseer_control_events (
    event_id TEXT PRIMARY KEY CHECK (event_id LIKE 'ocp-event-%'),
    resource_kind TEXT NOT NULL CHECK (resource_kind IN ('PARENT','CHILD','REPOSITORY_LEASE','VERIFIER_REGISTRY','FUSION_BUDGET')),
    resource_key TEXT NOT NULL,
    event_kind TEXT NOT NULL CHECK (event_kind IN ('ADMITTED','HEARTBEAT','STATE_CHANGED','CHILD_LINKED','CRASH_RECONCILED','LEASE_ACQUIRED','LEASE_TAKEN_OVER','LEASE_RELEASED','REGISTRY_FROZEN','BUDGET_RESERVED','BUDGET_CALL_STARTED','BUDGET_RECONCILED','BUDGET_OVERAGE_RECORDED','BUDGET_RELEASED')),
    actor TEXT NOT NULL,
    event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
    previous_event_digest TEXT CHECK (previous_event_digest IS NULL OR (length(previous_event_digest) = 64 AND previous_event_digest NOT GLOB '*[^0-9a-f]*')),
    event_digest TEXT NOT NULL UNIQUE CHECK (length(event_digest) = 64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
    UNIQUE (resource_kind, resource_key, event_sequence),
    CHECK ((event_sequence = 1 AND previous_event_digest IS NULL) OR event_sequence > 1)
  )`,
  `CREATE TRIGGER IF NOT EXISTS overseer_control_events_validate_chain
    BEFORE INSERT ON overseer_control_events BEGIN
      SELECT CASE WHEN NEW.event_sequence > 1 AND NOT EXISTS (
        SELECT 1 FROM overseer_control_events previous
        WHERE previous.resource_kind = NEW.resource_kind
          AND previous.resource_key = NEW.resource_key
          AND previous.event_sequence = NEW.event_sequence - 1
          AND previous.event_digest = NEW.previous_event_digest
      ) THEN RAISE(ABORT, 'overseer control event predecessor mismatch') END;
    END`,
] as const;

const APPEND_ONLY_TABLES = [
  'overseer_verifier_registries',
  'overseer_verifier_entries',
  'overseer_control_events',
] as const;

const DELETE_REJECT_TABLES = [
  'overseer_parent_commitments',
  'overseer_parent_children',
  'overseer_repository_mutation_leases',
  'overseer_fusion_budget_reservations',
  ...APPEND_ONLY_TABLES,
] as const;

function sqliteColumnsUnchanged(columns: readonly string[]): string {
  return columns.map(column => `NEW.${column} IS OLD.${column}`).join(' AND ');
}

const MUTABLE_UPDATE_GUARDS = [
  {
    table: 'overseer_parent_commitments',
    allowed: [
      `${sqliteColumnsUnchanged([
        'parent_id',
        'state',
        'owner_id',
        'correlation_id',
        'fencing_token',
        'admitted_at',
        'released_at',
        'terminal_reason',
      ])} AND OLD.state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING')
       AND NEW.heartbeat_at >= OLD.heartbeat_at
       AND CAST(strftime('%s',NEW.lease_expires_at) AS INTEGER) =
         CAST(strftime('%s',NEW.heartbeat_at) AS INTEGER) + 300`,
      `${sqliteColumnsUnchanged([
        'parent_id',
        'owner_id',
        'correlation_id',
        'fencing_token',
        'admitted_at',
        'heartbeat_at',
        'lease_expires_at',
        'released_at',
        'terminal_reason',
      ])} AND OLD.state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING')
       AND NEW.state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING')`,
      `${sqliteColumnsUnchanged([
        'parent_id',
        'owner_id',
        'correlation_id',
        'admitted_at',
        'heartbeat_at',
        'lease_expires_at',
      ])} AND OLD.state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING')
       AND NEW.state IN ('COMPLETED','FAILED','CANCELLED')
       AND NEW.fencing_token = OLD.fencing_token + 1
       AND NEW.released_at IS NOT NULL AND NEW.terminal_reason IS NOT NULL`,
    ],
  },
  {
    table: 'overseer_parent_children',
    allowed: [
      `${sqliteColumnsUnchanged(['parent_id', 'child_id', 'created_at', 'terminal_at'])}
       AND OLD.state = 'PENDING' AND NEW.state = 'RUNNING'`,
      `${sqliteColumnsUnchanged(['parent_id', 'child_id', 'created_at'])}
       AND OLD.state IN ('PENDING','RUNNING')
       AND NEW.state IN ('COMPLETED','FAILED','CANCELLED')
       AND OLD.terminal_at IS NULL AND NEW.terminal_at IS NOT NULL`,
    ],
  },
  {
    table: 'overseer_repository_mutation_leases',
    allowed: [
      `${sqliteColumnsUnchanged([
        'repository',
        'lease_id',
        'owner_id',
        'execution_id',
        'action_kind',
        'capability',
        'fencing_token',
        'state',
        'acquired_at',
        'released_at',
      ])} AND OLD.state = 'ACTIVE'
       AND NEW.heartbeat_at >= OLD.heartbeat_at
       AND CAST(strftime('%s',NEW.expires_at) AS INTEGER) =
         CAST(strftime('%s',NEW.heartbeat_at) AS INTEGER) + 300`,
      `${sqliteColumnsUnchanged([
        'repository',
        'lease_id',
        'owner_id',
        'execution_id',
        'action_kind',
        'capability',
        'fencing_token',
        'acquired_at',
        'heartbeat_at',
        'expires_at',
      ])} AND OLD.state = 'ACTIVE' AND NEW.state = 'RELEASED'
       AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL`,
      `NEW.repository IS OLD.repository
       AND NEW.fencing_token = OLD.fencing_token + 1
       AND NEW.state = 'ACTIVE'
       AND NEW.acquired_at IS NEW.heartbeat_at
       AND CAST(strftime('%s',NEW.expires_at) AS INTEGER) =
         CAST(strftime('%s',NEW.heartbeat_at) AS INTEGER) + 300
       AND NEW.released_at IS NULL
       AND (OLD.state <> 'ACTIVE' OR
         CAST(strftime('%s','now') AS INTEGER) >= CAST(strftime('%s',OLD.expires_at) AS INTEGER))`,
    ],
  },
  {
    table: 'overseer_fusion_budget_reservations',
    allowed: [
      `${sqliteColumnsUnchanged([
        'reservation_id',
        'call_id',
        'proposal_id',
        'execution_id',
        'provider',
        'model',
        'call_kind',
        'utc_day',
        'utc_month',
        'requested_microusd',
        'actual_microusd',
        'reserved_at',
        'reconciled_at',
        'released_at',
        'release_reason',
      ])} AND OLD.status = 'RESERVED' AND NEW.status = 'IN_FLIGHT'
       AND OLD.call_started_at IS NULL AND NEW.call_started_at IS NOT NULL`,
      `${sqliteColumnsUnchanged([
        'reservation_id',
        'call_id',
        'proposal_id',
        'execution_id',
        'provider',
        'model',
        'call_kind',
        'utc_day',
        'utc_month',
        'requested_microusd',
        'reserved_at',
        'call_started_at',
        'released_at',
        'release_reason',
      ])} AND OLD.status = 'IN_FLIGHT' AND NEW.status = 'RECONCILED'
       AND NEW.actual_microusd IS NOT NULL AND NEW.reconciled_at IS NOT NULL`,
      `${sqliteColumnsUnchanged([
        'reservation_id',
        'call_id',
        'proposal_id',
        'execution_id',
        'provider',
        'model',
        'call_kind',
        'utc_day',
        'utc_month',
        'requested_microusd',
        'actual_microusd',
        'reserved_at',
        'call_started_at',
        'reconciled_at',
      ])} AND OLD.status = 'RESERVED' AND NEW.status = 'RELEASED'
       AND NEW.released_at IS NOT NULL
       AND NEW.release_reason IN ('call_cancelled_before_start','authorization_revoked_before_start','provider_unavailable_before_start')`,
    ],
  },
] as const;

export async function installOverseerControlPlaneSqlite(database: IDatabase): Promise<void> {
  if (database.dialect !== 'sqlite') {
    throw new Error('overseer_control_plane_sqlite_installer_wrong_dialect');
  }
  for (const statement of SQLITE_STATEMENTS) await database.query(statement);
  for (const table of DELETE_REJECT_TABLES) {
    await database.query(
      `CREATE TRIGGER IF NOT EXISTS ${table}_reject_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} rejects delete'); END`
    );
  }
  for (const table of APPEND_ONLY_TABLES) {
    await database.query(
      `CREATE TRIGGER IF NOT EXISTS ${table}_reject_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`
    );
  }
  for (const guard of MUTABLE_UPDATE_GUARDS) {
    await database.query(`DROP TRIGGER IF EXISTS ${guard.table}_validate_update`);
    await database.query(
      `CREATE TRIGGER ${guard.table}_validate_update BEFORE UPDATE ON ${guard.table}
       WHEN NOT ((${guard.allowed.join(') OR (')}))
       BEGIN SELECT RAISE(ABORT, '${guard.table} rejects non-CAS update'); END`
    );
  }
}

export const OVERSEER_CONTROL_PLANE_TABLES = [
  'overseer_parent_commitments',
  'overseer_parent_children',
  'overseer_repository_mutation_leases',
  'overseer_verifier_registries',
  'overseer_verifier_entries',
  'overseer_fusion_budget_reservations',
  'overseer_control_events',
] as const;
