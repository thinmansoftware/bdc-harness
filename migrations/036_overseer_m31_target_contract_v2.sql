-- M-31 independent tagged-target contract v2 (M-42 Slice 2B).
-- This migration creates evidence and permit state only. It grants no effect authority.

CREATE TABLE IF NOT EXISTS overseer_m31_snapshots_v2 (
  snapshot_id TEXT PRIMARY KEY CHECK (snapshot_id ~ '^m31v2-snapshot-[0-9a-f-]{36}$'),
  schema_version TEXT NOT NULL CHECK (schema_version = 'm31-target-v2'),
  repository TEXT NOT NULL CHECK (length(repository) > 0),
  capture_started_at TIMESTAMPTZ NOT NULL,
  capture_completed_at TIMESTAMPTZ NOT NULL,
  operator_actor TEXT NOT NULL,
  operator_model TEXT NOT NULL,
  read_only_query_method TEXT NOT NULL,
  evidence_artifact_path TEXT NOT NULL,
  git_object_format TEXT NOT NULL CHECK (git_object_format IN ('sha1', 'sha256')),
  evidence_git_blob TEXT NOT NULL UNIQUE CHECK (evidence_git_blob ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  predecessor_snapshot_id TEXT,
  predecessor_evidence_git_blob TEXT CHECK (predecessor_evidence_git_blob IS NULL OR predecessor_evidence_git_blob ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (capture_completed_at >= capture_started_at),
  CHECK ((predecessor_snapshot_id IS NULL) = (predecessor_evidence_git_blob IS NULL)),
  CHECK ((git_object_format = 'sha1' AND length(evidence_git_blob) = 40) OR (git_object_format = 'sha256' AND length(evidence_git_blob) = 64)),
  UNIQUE (snapshot_id, evidence_git_blob, repository),
  FOREIGN KEY (predecessor_snapshot_id, predecessor_evidence_git_blob, repository)
    REFERENCES overseer_m31_snapshots_v2(snapshot_id, evidence_git_blob, repository)
);
CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_snapshots_v2_one_genesis
  ON overseer_m31_snapshots_v2(repository) WHERE predecessor_snapshot_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_snapshots_v2_one_successor
  ON overseer_m31_snapshots_v2(repository, predecessor_snapshot_id) WHERE predecessor_snapshot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS overseer_m31_snapshots_v2_repository ON overseer_m31_snapshots_v2(repository, created_at);

CREATE TABLE IF NOT EXISTS overseer_m31_target_members_v2 (
  snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots_v2(snapshot_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('workflow_run', 'issue', 'work_order', 'pull_request')),
  target_key TEXT NOT NULL,
  target_identity_json JSONB NOT NULL,
  target_digest TEXT NOT NULL CHECK (target_digest ~ '^[0-9a-f]{64}$'),
  evidence_artifact_path TEXT NOT NULL,
  git_object_format TEXT NOT NULL CHECK (git_object_format IN ('sha1', 'sha256')),
  evidence_git_blob TEXT NOT NULL CHECK (evidence_git_blob ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  observed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (snapshot_id, ordinal),
  UNIQUE (snapshot_id, target_kind, target_key),
  CHECK ((git_object_format = 'sha1' AND length(evidence_git_blob) = 40) OR (git_object_format = 'sha256' AND length(evidence_git_blob) = 64))
);

CREATE TABLE IF NOT EXISTS overseer_m31_discrepancies_v2 (
  discrepancy_id TEXT PRIMARY KEY CHECK (discrepancy_id ~ '^m31v2-discrepancy-[0-9a-f-]{36}$'),
  snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots_v2(snapshot_id),
  evidence_git_blob TEXT NOT NULL CHECK (evidence_git_blob ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  affected_targets_json JSONB NOT NULL,
  conflict_json JSONB NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  resolution_json JSONB,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  predecessor_discrepancy_id TEXT REFERENCES overseer_m31_discrepancies_v2(discrepancy_id),
  CHECK ((resolution_json IS NULL AND resolved_by IS NULL AND resolved_at IS NULL) OR
         (resolution_json IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)),
  CHECK (resolution_json IS NULL OR (
    jsonb_typeof(resolution_json) = 'object' AND
    resolution_json = jsonb_build_object(
      'resolves_discrepancy_id', resolution_json->>'resolves_discrepancy_id',
      'resolution_code', resolution_json->>'resolution_code',
      'evidence_digest', resolution_json->>'evidence_digest'
    ) AND
    length(resolution_json->>'resolution_code') > 0 AND
    resolution_json->>'evidence_digest' ~ '^[0-9a-f]{64}$'
  ))
);
CREATE INDEX IF NOT EXISTS overseer_m31_discrepancies_v2_snapshot ON overseer_m31_discrepancies_v2(snapshot_id, recorded_at);
CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_discrepancies_v2_one_successor
  ON overseer_m31_discrepancies_v2(predecessor_discrepancy_id)
  WHERE predecessor_discrepancy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_discrepancies_v2_one_resolution
  ON overseer_m31_discrepancies_v2((resolution_json->>'resolves_discrepancy_id'))
  WHERE resolution_json IS NOT NULL;

CREATE TABLE IF NOT EXISTS overseer_m31_action_proposals_v2 (
  proposal_id TEXT PRIMARY KEY CHECK (proposal_id ~ '^m31v2-proposal-[0-9a-f-]{36}$'),
  repository TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('workflow_run', 'issue', 'work_order', 'pull_request')),
  target_key TEXT NOT NULL,
  target_identity_json JSONB NOT NULL,
  target_digest TEXT NOT NULL CHECK (target_digest ~ '^[0-9a-f]{64}$'),
  snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots_v2(snapshot_id),
  evidence_path TEXT NOT NULL,
  evidence_git_blob TEXT NOT NULL CHECK (evidence_git_blob ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('MERGE','CLOSE','REOPEN','REFRESH','REBASE','PUSH','RETARGET','REPAIR','REFIRE','COMMENT','LABEL','ASSIGN','REVIEW','STAGING_MUTATION','PRODUCTION_MUTATION','DEPLOY')),
  action_parameters_json JSONB NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
  execution_id TEXT NOT NULL UNIQUE CHECK (execution_id ~ '^m31v2-execution-[0-9a-f-]{36}$'),
  capability TEXT NOT NULL,
  policy_digest TEXT NOT NULL CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
  verifier_registry_digest TEXT NOT NULL CHECK (verifier_registry_digest ~ '^[0-9a-f]{64}$'),
  CHECK (
    (target_kind = 'workflow_run' AND action_kind IN ('REPAIR','REFIRE')) OR
    (target_kind = 'issue' AND action_kind IN ('CLOSE','REOPEN','COMMENT','LABEL','ASSIGN')) OR
    (target_kind = 'work_order' AND action_kind IN ('CLOSE','REOPEN','COMMENT','LABEL','ASSIGN')) OR
    (target_kind = 'pull_request' AND action_kind IN ('MERGE','CLOSE','REOPEN','REFRESH','REBASE','REPAIR','COMMENT','LABEL','ASSIGN'))
  )
);
CREATE INDEX IF NOT EXISTS overseer_m31_action_proposals_v2_target ON overseer_m31_action_proposals_v2(repository, target_kind, target_key);

CREATE TABLE IF NOT EXISTS overseer_m31_execution_receipts_v2 (
  receipt_event_id TEXT PRIMARY KEY CHECK (receipt_event_id ~ '^m31v2-receipt-[0-9a-f-]{36}$'),
  proposal_id TEXT NOT NULL REFERENCES overseer_m31_action_proposals_v2(proposal_id),
  execution_id TEXT NOT NULL,
  event_sequence BIGINT NOT NULL CHECK (event_sequence > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('permit_issued','effect_reserved','effect_succeeded','effect_failed','effect_indeterminate','effect_reconciled_succeeded','effect_reconciled_failed')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('workflow_run', 'issue', 'work_order', 'pull_request')),
  target_key TEXT NOT NULL,
  target_digest TEXT NOT NULL CHECK (target_digest ~ '^[0-9a-f]{64}$'),
  live_observation_json JSONB,
  live_observation_digest TEXT CHECK (live_observation_digest IS NULL OR live_observation_digest ~ '^[0-9a-f]{64}$'),
  revalidated_at TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  adapter_name TEXT,
  provider_operation TEXT,
  external_effect_reference TEXT,
  reason TEXT NOT NULL,
  evidence_json JSONB NOT NULL,
  previous_event_digest TEXT CHECK (previous_event_digest IS NULL OR previous_event_digest ~ '^[0-9a-f]{64}$'),
  event_digest TEXT NOT NULL UNIQUE CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (proposal_id, event_sequence),
  CHECK ((event_sequence = 1 AND event_type = 'permit_issued') OR
         (event_sequence = 2 AND event_type = 'effect_reserved') OR
         (event_sequence = 3 AND event_type IN ('effect_succeeded','effect_failed','effect_indeterminate')) OR
         (event_sequence = 4 AND event_type IN ('effect_reconciled_succeeded','effect_reconciled_failed'))),
  CHECK ((live_observation_json IS NULL) = (live_observation_digest IS NULL)),
  CHECK ((revalidated_at IS NULL) = (valid_until IS NULL)),
  CHECK (valid_until IS NULL OR valid_until > revalidated_at),
  CHECK (
    (event_sequence = 1 AND live_observation_json IS NOT NULL AND adapter_name IS NULL AND provider_operation IS NULL) OR
    (event_sequence = 2 AND live_observation_json IS NULL AND adapter_name IS NOT NULL AND provider_operation IS NOT NULL) OR
    (event_sequence IN (3,4) AND live_observation_json IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_receipts_v2_one_permit ON overseer_m31_execution_receipts_v2(execution_id) WHERE event_type = 'permit_issued';
CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_receipts_v2_one_reservation ON overseer_m31_execution_receipts_v2(execution_id) WHERE event_type = 'effect_reserved';
CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_receipts_v2_one_primary ON overseer_m31_execution_receipts_v2(execution_id) WHERE event_type IN ('effect_succeeded','effect_failed','effect_indeterminate');
CREATE UNIQUE INDEX IF NOT EXISTS overseer_m31_receipts_v2_one_reconciliation ON overseer_m31_execution_receipts_v2(execution_id) WHERE event_type IN ('effect_reconciled_succeeded','effect_reconciled_failed');

CREATE OR REPLACE FUNCTION reject_overseer_m31_v2_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_overseer_m31_discrepancy_v2_append() RETURNS trigger AS $$
DECLARE
  repo TEXT;
  current_tip TEXT;
  resolved_open overseer_m31_discrepancies_v2%ROWTYPE;
BEGIN
  SELECT repository INTO repo FROM overseer_m31_snapshots_v2 WHERE snapshot_id = NEW.snapshot_id;
  IF repo IS NULL THEN RAISE EXCEPTION 'discrepancy snapshot missing'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(repo, 0));
  SELECT d.discrepancy_id INTO current_tip
    FROM overseer_m31_discrepancies_v2 d
    JOIN overseer_m31_snapshots_v2 s ON s.snapshot_id = d.snapshot_id
   WHERE s.repository = repo
     AND NOT EXISTS (SELECT 1 FROM overseer_m31_discrepancies_v2 child WHERE child.predecessor_discrepancy_id = d.discrepancy_id)
   ORDER BY d.recorded_at DESC, d.discrepancy_id DESC LIMIT 1;
  IF NEW.predecessor_discrepancy_id IS DISTINCT FROM current_tip THEN
    RAISE EXCEPTION 'discrepancy predecessor stale';
  END IF;
  IF NEW.resolution_json IS NOT NULL THEN
    SELECT * INTO resolved_open FROM overseer_m31_discrepancies_v2
     WHERE discrepancy_id = NEW.resolution_json->>'resolves_discrepancy_id';
    IF NOT FOUND THEN RAISE EXCEPTION 'discrepancy resolution missing'; END IF;
    IF resolved_open.resolution_json IS NOT NULL THEN RAISE EXCEPTION 'cannot resolve a resolution row'; END IF;
    IF resolved_open.snapshot_id <> NEW.snapshot_id OR
       resolved_open.affected_targets_json <> NEW.affected_targets_json OR
       resolved_open.conflict_json <> NEW.conflict_json THEN
      RAISE EXCEPTION 'discrepancy resolution mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_overseer_m31_receipt_v2_append() RETURNS trigger AS $$
DECLARE
  proposal overseer_m31_action_proposals_v2%ROWTYPE;
  previous overseer_m31_execution_receipts_v2%ROWTYPE;
BEGIN
  SELECT * INTO proposal FROM overseer_m31_action_proposals_v2 WHERE proposal_id=NEW.proposal_id;
  IF NOT FOUND OR proposal.execution_id <> NEW.execution_id OR
     proposal.target_kind <> NEW.target_kind OR proposal.target_key <> NEW.target_key OR
     proposal.target_digest <> NEW.target_digest THEN
    RAISE EXCEPTION 'receipt target drift';
  END IF;
  IF NEW.event_sequence = 1 THEN
    IF NEW.previous_event_digest IS NOT NULL THEN RAISE EXCEPTION 'permit previous digest must be null'; END IF;
  ELSE
    SELECT * INTO previous FROM overseer_m31_execution_receipts_v2
     WHERE execution_id=NEW.execution_id AND event_sequence=NEW.event_sequence-1;
    IF NOT FOUND OR previous.event_digest IS DISTINCT FROM NEW.previous_event_digest THEN
      RAISE EXCEPTION 'receipt chain predecessor mismatch';
    END IF;
    IF NEW.event_sequence = 4 AND previous.event_type <> 'effect_indeterminate' THEN
      RAISE EXCEPTION 'reconciliation requires indeterminate outcome';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER overseer_m31_discrepancies_v2_validate_append
  BEFORE INSERT ON overseer_m31_discrepancies_v2
  FOR EACH ROW EXECUTE FUNCTION validate_overseer_m31_discrepancy_v2_append();
CREATE OR REPLACE TRIGGER overseer_m31_execution_receipts_v2_validate_append
  BEFORE INSERT ON overseer_m31_execution_receipts_v2
  FOR EACH ROW EXECUTE FUNCTION validate_overseer_m31_receipt_v2_append();

CREATE OR REPLACE TRIGGER overseer_m31_snapshots_v2_append_only BEFORE UPDATE OR DELETE ON overseer_m31_snapshots_v2 FOR EACH ROW EXECUTE FUNCTION reject_overseer_m31_v2_mutation();
CREATE OR REPLACE TRIGGER overseer_m31_target_members_v2_append_only BEFORE UPDATE OR DELETE ON overseer_m31_target_members_v2 FOR EACH ROW EXECUTE FUNCTION reject_overseer_m31_v2_mutation();
CREATE OR REPLACE TRIGGER overseer_m31_discrepancies_v2_append_only BEFORE UPDATE OR DELETE ON overseer_m31_discrepancies_v2 FOR EACH ROW EXECUTE FUNCTION reject_overseer_m31_v2_mutation();
CREATE OR REPLACE TRIGGER overseer_m31_action_proposals_v2_append_only BEFORE UPDATE OR DELETE ON overseer_m31_action_proposals_v2 FOR EACH ROW EXECUTE FUNCTION reject_overseer_m31_v2_mutation();
CREATE OR REPLACE TRIGGER overseer_m31_execution_receipts_v2_append_only BEFORE UPDATE OR DELETE ON overseer_m31_execution_receipts_v2 FOR EACH ROW EXECUTE FUNCTION reject_overseer_m31_v2_mutation();
