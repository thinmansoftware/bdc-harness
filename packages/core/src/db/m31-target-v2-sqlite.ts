import type { IDatabase } from './adapters/types';

const SQLITE_V2_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS overseer_m31_snapshots_v2 (
    snapshot_id TEXT PRIMARY KEY CHECK (snapshot_id LIKE 'm31v2-snapshot-%'),
    schema_version TEXT NOT NULL CHECK (schema_version = 'm31-target-v2'),
    repository TEXT NOT NULL CHECK (length(repository) > 0),
    capture_started_at TEXT NOT NULL,
    capture_completed_at TEXT NOT NULL,
    operator_actor TEXT NOT NULL,
    operator_model TEXT NOT NULL,
    read_only_query_method TEXT NOT NULL,
    evidence_artifact_path TEXT NOT NULL,
    git_object_format TEXT NOT NULL CHECK (git_object_format IN ('sha1', 'sha256')),
    evidence_git_blob TEXT NOT NULL UNIQUE CHECK (length(evidence_git_blob) IN (40, 64) AND evidence_git_blob NOT GLOB '*[^0-9a-f]*'),
    predecessor_snapshot_id TEXT,
    predecessor_evidence_git_blob TEXT CHECK (predecessor_evidence_git_blob IS NULL OR (length(predecessor_evidence_git_blob) IN (40, 64) AND predecessor_evidence_git_blob NOT GLOB '*[^0-9a-f]*')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (julianday(capture_completed_at) >= julianday(capture_started_at)),
    CHECK ((predecessor_snapshot_id IS NULL) = (predecessor_evidence_git_blob IS NULL)),
    CHECK ((git_object_format = 'sha1' AND length(evidence_git_blob) = 40) OR (git_object_format = 'sha256' AND length(evidence_git_blob) = 64)),
    UNIQUE (snapshot_id, evidence_git_blob, repository),
    FOREIGN KEY (predecessor_snapshot_id, predecessor_evidence_git_blob, repository)
      REFERENCES overseer_m31_snapshots_v2(snapshot_id, evidence_git_blob, repository)
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_snapshots_v2_one_genesis ON overseer_m31_snapshots_v2(repository) WHERE predecessor_snapshot_id IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_snapshots_v2_one_successor ON overseer_m31_snapshots_v2(repository, predecessor_snapshot_id) WHERE predecessor_snapshot_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS overseer_m31_snapshots_v2_repository ON overseer_m31_snapshots_v2(repository, created_at)',
  `CREATE TABLE IF NOT EXISTS overseer_m31_target_members_v2 (
    snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots_v2(snapshot_id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('workflow_run', 'issue', 'work_order', 'pull_request')),
    target_key TEXT NOT NULL,
    target_identity_json TEXT NOT NULL CHECK (json_valid(target_identity_json)),
    target_digest TEXT NOT NULL CHECK (length(target_digest) = 64 AND target_digest NOT GLOB '*[^0-9a-f]*'),
    evidence_artifact_path TEXT NOT NULL,
    git_object_format TEXT NOT NULL CHECK (git_object_format IN ('sha1', 'sha256')),
    evidence_git_blob TEXT NOT NULL CHECK (length(evidence_git_blob) IN (40, 64) AND evidence_git_blob NOT GLOB '*[^0-9a-f]*'),
    observed_at TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, ordinal),
    UNIQUE (snapshot_id, target_kind, target_key),
    CHECK ((git_object_format = 'sha1' AND length(evidence_git_blob) = 40) OR (git_object_format = 'sha256' AND length(evidence_git_blob) = 64))
  )`,
  `CREATE TABLE IF NOT EXISTS overseer_m31_discrepancies_v2 (
    discrepancy_id TEXT PRIMARY KEY CHECK (discrepancy_id LIKE 'm31v2-discrepancy-%'),
    snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots_v2(snapshot_id),
    evidence_git_blob TEXT NOT NULL CHECK (length(evidence_git_blob) IN (40, 64) AND evidence_git_blob NOT GLOB '*[^0-9a-f]*'),
    affected_targets_json TEXT NOT NULL CHECK (json_valid(affected_targets_json)),
    conflict_json TEXT NOT NULL CHECK (json_valid(conflict_json)),
    recorded_by TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
    resolved_by TEXT,
    resolved_at TEXT,
    predecessor_discrepancy_id TEXT REFERENCES overseer_m31_discrepancies_v2(discrepancy_id),
    CHECK ((resolution_json IS NULL AND resolved_by IS NULL AND resolved_at IS NULL) OR (resolution_json IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)),
    CHECK (resolution_json IS NULL OR (
      json_type(resolution_json) = 'object' AND
      json_type(resolution_json, '$.resolves_discrepancy_id') = 'text' AND
      json_type(resolution_json, '$.resolution_code') = 'text' AND
      length(json_extract(resolution_json, '$.resolution_code')) > 0 AND
      json_type(resolution_json, '$.evidence_digest') = 'text' AND
      length(json_extract(resolution_json, '$.evidence_digest')) = 64 AND
      json_extract(resolution_json, '$.evidence_digest') NOT GLOB '*[^0-9a-f]*'
    ))
  )`,
  'CREATE INDEX IF NOT EXISTS overseer_m31_discrepancies_v2_snapshot ON overseer_m31_discrepancies_v2(snapshot_id, recorded_at)',
  'CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_discrepancies_v2_one_successor ON overseer_m31_discrepancies_v2(predecessor_discrepancy_id) WHERE predecessor_discrepancy_id IS NOT NULL',
  "CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_discrepancies_v2_one_resolution ON overseer_m31_discrepancies_v2(json_extract(resolution_json, '$.resolves_discrepancy_id')) WHERE resolution_json IS NOT NULL",
  `CREATE TRIGGER IF NOT EXISTS overseer_m31_discrepancies_v2_validate_append
    BEFORE INSERT ON overseer_m31_discrepancies_v2 BEGIN
      SELECT CASE WHEN COALESCE(NEW.predecessor_discrepancy_id, '') <> COALESCE((
        SELECT d.discrepancy_id FROM overseer_m31_discrepancies_v2 d
        JOIN overseer_m31_snapshots_v2 s ON s.snapshot_id=d.snapshot_id
        WHERE s.repository=(SELECT repository FROM overseer_m31_snapshots_v2 WHERE snapshot_id=NEW.snapshot_id)
          AND NOT EXISTS (SELECT 1 FROM overseer_m31_discrepancies_v2 child WHERE child.predecessor_discrepancy_id=d.discrepancy_id)
        ORDER BY d.recorded_at DESC,d.discrepancy_id DESC LIMIT 1
      ), '') THEN RAISE(ABORT, 'discrepancy predecessor stale') END;
      SELECT CASE WHEN NEW.resolution_json IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM overseer_m31_discrepancies_v2 open
        WHERE open.discrepancy_id=json_extract(NEW.resolution_json, '$.resolves_discrepancy_id')
          AND open.resolution_json IS NULL
          AND open.snapshot_id=NEW.snapshot_id
          AND open.affected_targets_json=NEW.affected_targets_json
          AND open.conflict_json=NEW.conflict_json
      ) THEN RAISE(ABORT, 'discrepancy resolution mismatch') END;
    END`,
  `CREATE TABLE IF NOT EXISTS overseer_m31_action_proposals_v2 (
    proposal_id TEXT PRIMARY KEY CHECK (proposal_id LIKE 'm31v2-proposal-%'),
    repository TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('workflow_run', 'issue', 'work_order', 'pull_request')),
    target_key TEXT NOT NULL,
    target_identity_json TEXT NOT NULL CHECK (json_valid(target_identity_json)),
    target_digest TEXT NOT NULL CHECK (length(target_digest) = 64 AND target_digest NOT GLOB '*[^0-9a-f]*'),
    snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots_v2(snapshot_id),
    evidence_path TEXT NOT NULL,
    evidence_git_blob TEXT NOT NULL CHECK (length(evidence_git_blob) IN (40, 64) AND evidence_git_blob NOT GLOB '*[^0-9a-f]*'),
    action_kind TEXT NOT NULL CHECK (action_kind IN ('MERGE','CLOSE','REOPEN','REFRESH','REBASE','PUSH','RETARGET','REPAIR','REFIRE','COMMENT','LABEL','ASSIGN','REVIEW','STAGING_MUTATION','PRODUCTION_MUTATION','DEPLOY')),
    action_parameters_json TEXT NOT NULL CHECK (json_valid(action_parameters_json)),
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL CHECK (julianday(expires_at) > julianday(created_at)),
    execution_id TEXT NOT NULL UNIQUE CHECK (execution_id LIKE 'm31v2-execution-%'),
    capability TEXT NOT NULL,
    policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
    verifier_registry_digest TEXT NOT NULL CHECK (length(verifier_registry_digest) = 64 AND verifier_registry_digest NOT GLOB '*[^0-9a-f]*'),
    CHECK (
      (target_kind = 'workflow_run' AND action_kind IN ('REPAIR','REFIRE')) OR
      (target_kind = 'issue' AND action_kind IN ('CLOSE','REOPEN','COMMENT','LABEL','ASSIGN')) OR
      (target_kind = 'work_order' AND action_kind IN ('CLOSE','REOPEN','COMMENT','LABEL','ASSIGN')) OR
      (target_kind = 'pull_request' AND action_kind IN ('MERGE','CLOSE','REOPEN','REFRESH','REBASE','REPAIR','COMMENT','LABEL','ASSIGN'))
    )
  )`,
  'CREATE INDEX IF NOT EXISTS overseer_m31_action_proposals_v2_target ON overseer_m31_action_proposals_v2(repository, target_kind, target_key)',
  `CREATE TABLE IF NOT EXISTS overseer_m31_execution_receipts_v2 (
    receipt_event_id TEXT PRIMARY KEY CHECK (receipt_event_id LIKE 'm31v2-receipt-%'),
    proposal_id TEXT NOT NULL REFERENCES overseer_m31_action_proposals_v2(proposal_id),
    execution_id TEXT NOT NULL,
    event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
    event_type TEXT NOT NULL CHECK (event_type IN ('permit_issued','effect_reserved','effect_succeeded','effect_failed','effect_indeterminate','effect_reconciled_succeeded','effect_reconciled_failed')),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('workflow_run', 'issue', 'work_order', 'pull_request')),
    target_key TEXT NOT NULL,
    target_digest TEXT NOT NULL CHECK (length(target_digest) = 64 AND target_digest NOT GLOB '*[^0-9a-f]*'),
    live_observation_json TEXT CHECK (live_observation_json IS NULL OR json_valid(live_observation_json)),
    live_observation_digest TEXT CHECK (live_observation_digest IS NULL OR (length(live_observation_digest) = 64 AND live_observation_digest NOT GLOB '*[^0-9a-f]*')),
    revalidated_at TEXT,
    valid_until TEXT,
    adapter_name TEXT,
    provider_operation TEXT,
    external_effect_reference TEXT,
    reason TEXT NOT NULL,
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
    previous_event_digest TEXT CHECK (previous_event_digest IS NULL OR (length(previous_event_digest) = 64 AND previous_event_digest NOT GLOB '*[^0-9a-f]*')),
    event_digest TEXT NOT NULL UNIQUE CHECK (length(event_digest) = 64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    UNIQUE (proposal_id, event_sequence),
    CHECK ((event_sequence = 1 AND event_type = 'permit_issued') OR (event_sequence = 2 AND event_type = 'effect_reserved') OR (event_sequence = 3 AND event_type IN ('effect_succeeded','effect_failed','effect_indeterminate')) OR (event_sequence = 4 AND event_type IN ('effect_reconciled_succeeded','effect_reconciled_failed'))),
    CHECK ((live_observation_json IS NULL) = (live_observation_digest IS NULL)),
    CHECK ((revalidated_at IS NULL) = (valid_until IS NULL)),
    CHECK (valid_until IS NULL OR julianday(valid_until) > julianday(revalidated_at)),
    CHECK (
      (event_sequence = 1 AND live_observation_json IS NOT NULL AND adapter_name IS NULL AND provider_operation IS NULL) OR
      (event_sequence = 2 AND live_observation_json IS NULL AND adapter_name IS NOT NULL AND provider_operation IS NOT NULL) OR
      (event_sequence IN (3,4) AND live_observation_json IS NULL)
    )
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_receipts_v2_one_permit ON overseer_m31_execution_receipts_v2(execution_id) WHERE event_type = 'permit_issued'",
  "CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_receipts_v2_one_reservation ON overseer_m31_execution_receipts_v2(execution_id) WHERE event_type = 'effect_reserved'",
  "CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_receipts_v2_one_primary ON overseer_m31_execution_receipts_v2(execution_id) WHERE event_type IN ('effect_succeeded','effect_failed','effect_indeterminate')",
  "CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_receipts_v2_one_reconciliation ON overseer_m31_execution_receipts_v2(execution_id) WHERE event_type IN ('effect_reconciled_succeeded','effect_reconciled_failed')",
  `CREATE TRIGGER IF NOT EXISTS overseer_m31_execution_receipts_v2_validate_append
    BEFORE INSERT ON overseer_m31_execution_receipts_v2 BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM overseer_m31_action_proposals_v2 p
        WHERE p.proposal_id=NEW.proposal_id AND p.execution_id=NEW.execution_id
          AND p.target_kind=NEW.target_kind AND p.target_key=NEW.target_key
          AND p.target_digest=NEW.target_digest
      ) THEN RAISE(ABORT, 'receipt target drift') END;
      SELECT CASE WHEN NEW.event_sequence=1 AND NEW.previous_event_digest IS NOT NULL
        THEN RAISE(ABORT, 'permit previous digest must be null') END;
      SELECT CASE WHEN NEW.event_sequence>1 AND NOT EXISTS (
        SELECT 1 FROM overseer_m31_execution_receipts_v2 previous
        WHERE previous.execution_id=NEW.execution_id
          AND previous.event_sequence=NEW.event_sequence-1
          AND previous.event_digest=NEW.previous_event_digest
      ) THEN RAISE(ABORT, 'receipt chain predecessor mismatch') END;
      SELECT CASE WHEN NEW.event_sequence=4 AND NOT EXISTS (
        SELECT 1 FROM overseer_m31_execution_receipts_v2 previous
        WHERE previous.execution_id=NEW.execution_id
          AND previous.event_sequence=3
          AND previous.event_type='effect_indeterminate'
      ) THEN RAISE(ABORT, 'reconciliation requires indeterminate outcome') END;
    END`,
] as const;

const APPEND_ONLY_TABLES = [
  'overseer_m31_snapshots_v2',
  'overseer_m31_target_members_v2',
  'overseer_m31_discrepancies_v2',
  'overseer_m31_action_proposals_v2',
  'overseer_m31_execution_receipts_v2',
] as const;

export async function installM31TargetV2Sqlite(db: IDatabase): Promise<void> {
  if (db.dialect !== 'sqlite') throw new Error('m31_target_v2_sqlite_installer_wrong_dialect');
  for (const sql of SQLITE_V2_STATEMENTS) await db.query(sql);
  for (const table of APPEND_ONLY_TABLES) {
    await db.query(
      `CREATE TRIGGER IF NOT EXISTS ${table}_reject_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`
    );
    await db.query(
      `CREATE TRIGGER IF NOT EXISTS ${table}_reject_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`
    );
  }
}

export const M31_TARGET_V2_TABLES = APPEND_ONLY_TABLES;
