-- M-31 Overseer merge-steward evidence, proposal, and permit substrate (M-42 Slice 2).
--
-- Five append-only tables that capture immutable live-state snapshots, explicit
-- sorted PR membership, discrepancies, exact expiring action proposals, and
-- single-use compare-and-consume execution receipts. This substrate prepares a
-- short-lived, single-use action permit ONLY after an exact live-state
-- revalidation inside the M-31 60-second validity window. It performs no
-- provider mutation: receipts forbid any provider atomic operation and snapshots
-- forbid a succeeded mutation or succeeded paid Fusion call.
--
-- Prior art: migrations/029_board_authority_foundation.sql (append-only audit)
-- and migrations/032_board_execution_claims.sql (fenced single-use execution).
-- Booleans are stored as SMALLINT (0/1) for PostgreSQL/SQLite parity.

-- ---------------------------------------------------------------------------
-- Table 1: immutable snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS overseer_m31_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  repository TEXT NOT NULL,
  capture_started_at TIMESTAMPTZ NOT NULL,
  capture_completed_at TIMESTAMPTZ NOT NULL,
  operator_actor TEXT NOT NULL,
  operator_model TEXT NOT NULL,
  read_only_query_method TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  predecessor_snapshot_id TEXT REFERENCES overseer_m31_snapshots(snapshot_id),
  predecessor_evidence_git_blob TEXT
    CHECK (predecessor_evidence_git_blob IS NULL
      OR predecessor_evidence_git_blob ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  artifact_path TEXT NOT NULL,
  git_object_format TEXT NOT NULL CHECK (git_object_format IN ('sha1', 'sha256')),
  evidence_git_blob TEXT NOT NULL UNIQUE
    CHECK (evidence_git_blob ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  mutation_attempted SMALLINT NOT NULL CHECK (mutation_attempted IN (0, 1)),
  mutation_succeeded SMALLINT NOT NULL CHECK (mutation_succeeded = 0),
  fusion_calls_attempted INTEGER NOT NULL CHECK (fusion_calls_attempted >= 0),
  fusion_calls_succeeded INTEGER NOT NULL CHECK (fusion_calls_succeeded = 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT overseer_m31_snapshots_predecessor_pair CHECK (
    (predecessor_snapshot_id IS NULL) = (predecessor_evidence_git_blob IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_overseer_m31_snapshots_repo
  ON overseer_m31_snapshots(repository, created_at);
CREATE INDEX IF NOT EXISTS idx_overseer_m31_snapshots_predecessor
  ON overseer_m31_snapshots(predecessor_snapshot_id)
  WHERE predecessor_snapshot_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Table 2: explicit sorted snapshot membership
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS overseer_m31_snapshot_members (
  snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots(snapshot_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  pr_number INTEGER NOT NULL CHECK (pr_number > 0),
  head_sha TEXT NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  base_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  state TEXT NOT NULL,
  checks_json JSONB NOT NULL,
  check_source_sha TEXT NOT NULL CHECK (check_source_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  checks_observed_at TIMESTAMPTZ NOT NULL,
  review_state TEXT NOT NULL,
  mergeability TEXT NOT NULL,
  merge_state_status TEXT NOT NULL,
  linked_work_evidence_json JSONB NOT NULL,
  evidence_artifact_path TEXT NOT NULL,
  git_object_format TEXT NOT NULL CHECK (git_object_format IN ('sha1', 'sha256')),
  evidence_git_blob TEXT NOT NULL CHECK (evidence_git_blob ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  observed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (snapshot_id, ordinal),
  CONSTRAINT overseer_m31_snapshot_members_pr_unique UNIQUE (snapshot_id, pr_number)
);

CREATE INDEX IF NOT EXISTS idx_overseer_m31_snapshot_members_snapshot
  ON overseer_m31_snapshot_members(snapshot_id, ordinal);

-- ---------------------------------------------------------------------------
-- Table 3: append-only discrepancies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS overseer_m31_discrepancies (
  discrepancy_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots(snapshot_id),
  evidence_git_blob TEXT NOT NULL CHECK (evidence_git_blob ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  affected_rows_json JSONB NOT NULL,
  observed_conflict TEXT NOT NULL,
  recorder TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  resolution TEXT,
  predecessor_discrepancy_id TEXT REFERENCES overseer_m31_discrepancies(discrepancy_id)
);

CREATE INDEX IF NOT EXISTS idx_overseer_m31_discrepancies_snapshot
  ON overseer_m31_discrepancies(snapshot_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_overseer_m31_discrepancies_unresolved
  ON overseer_m31_discrepancies(snapshot_id) WHERE resolution IS NULL;

-- ---------------------------------------------------------------------------
-- Table 4: immutable, expiring, exact-state action proposals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS overseer_m31_action_proposals (
  proposal_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  pr_number INTEGER NOT NULL CHECK (pr_number > 0),
  head_sha TEXT NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  base_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots(snapshot_id),
  evidence_path TEXT NOT NULL,
  evidence_git_blob TEXT NOT NULL CHECK (evidence_git_blob ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  action_kind TEXT NOT NULL CHECK (action_kind IN (
    'MERGE', 'CLOSE', 'REOPEN', 'REFRESH', 'REBASE', 'PUSH', 'RETARGET',
    'REPAIR', 'REFIRE', 'COMMENT', 'LABEL', 'ASSIGN', 'REVIEW',
    'STAGING_MUTATION', 'PRODUCTION_MUTATION', 'DEPLOY'
  )),
  action_parameters_json JSONB NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  execution_id TEXT NOT NULL UNIQUE,
  capability TEXT NOT NULL,
  policy_digest TEXT NOT NULL CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
  verifier_registry_digest TEXT NOT NULL CHECK (verifier_registry_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT overseer_m31_action_proposals_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_overseer_m31_action_proposals_repo
  ON overseer_m31_action_proposals(repository, pr_number);
CREATE INDEX IF NOT EXISTS idx_overseer_m31_action_proposals_snapshot
  ON overseer_m31_action_proposals(snapshot_id);

-- ---------------------------------------------------------------------------
-- Table 5: single-use compare-and-consume execution receipts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS overseer_m31_execution_receipts (
  receipt_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES overseer_m31_action_proposals(proposal_id),
  execution_id TEXT NOT NULL UNIQUE,
  snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots(snapshot_id),
  live_observation_json JSONB NOT NULL,
  live_observation_digest TEXT NOT NULL CHECK (live_observation_digest ~ '^[0-9a-f]{64}$'),
  revalidated_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  compare_result TEXT NOT NULL CHECK (compare_result = 'permit_issued'),
  provider_atomic_operation TEXT CHECK (provider_atomic_operation IS NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT overseer_m31_execution_receipts_validity_window CHECK (valid_until > revalidated_at)
);

CREATE INDEX IF NOT EXISTS idx_overseer_m31_execution_receipts_proposal
  ON overseer_m31_execution_receipts(proposal_id);

-- ---------------------------------------------------------------------------
-- Append-only enforcement for all five tables (no UPDATE, no DELETE).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_overseer_m31_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_overseer_m31_snapshots_no_update ON overseer_m31_snapshots;
CREATE TRIGGER trg_overseer_m31_snapshots_no_update
  BEFORE UPDATE ON overseer_m31_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_m31_mutation();
DROP TRIGGER IF EXISTS trg_overseer_m31_snapshots_no_delete ON overseer_m31_snapshots;
CREATE TRIGGER trg_overseer_m31_snapshots_no_delete
  BEFORE DELETE ON overseer_m31_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_m31_mutation();

DROP TRIGGER IF EXISTS trg_overseer_m31_snapshot_members_no_update ON overseer_m31_snapshot_members;
CREATE TRIGGER trg_overseer_m31_snapshot_members_no_update
  BEFORE UPDATE ON overseer_m31_snapshot_members
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_m31_mutation();
DROP TRIGGER IF EXISTS trg_overseer_m31_snapshot_members_no_delete ON overseer_m31_snapshot_members;
CREATE TRIGGER trg_overseer_m31_snapshot_members_no_delete
  BEFORE DELETE ON overseer_m31_snapshot_members
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_m31_mutation();

DROP TRIGGER IF EXISTS trg_overseer_m31_discrepancies_no_update ON overseer_m31_discrepancies;
CREATE TRIGGER trg_overseer_m31_discrepancies_no_update
  BEFORE UPDATE ON overseer_m31_discrepancies
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_m31_mutation();
DROP TRIGGER IF EXISTS trg_overseer_m31_discrepancies_no_delete ON overseer_m31_discrepancies;
CREATE TRIGGER trg_overseer_m31_discrepancies_no_delete
  BEFORE DELETE ON overseer_m31_discrepancies
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_m31_mutation();

DROP TRIGGER IF EXISTS trg_overseer_m31_action_proposals_no_update ON overseer_m31_action_proposals;
CREATE TRIGGER trg_overseer_m31_action_proposals_no_update
  BEFORE UPDATE ON overseer_m31_action_proposals
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_m31_mutation();
DROP TRIGGER IF EXISTS trg_overseer_m31_action_proposals_no_delete ON overseer_m31_action_proposals;
CREATE TRIGGER trg_overseer_m31_action_proposals_no_delete
  BEFORE DELETE ON overseer_m31_action_proposals
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_m31_mutation();

DROP TRIGGER IF EXISTS trg_overseer_m31_execution_receipts_no_update ON overseer_m31_execution_receipts;
CREATE TRIGGER trg_overseer_m31_execution_receipts_no_update
  BEFORE UPDATE ON overseer_m31_execution_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_m31_mutation();
DROP TRIGGER IF EXISTS trg_overseer_m31_execution_receipts_no_delete ON overseer_m31_execution_receipts;
CREATE TRIGGER trg_overseer_m31_execution_receipts_no_delete
  BEFORE DELETE ON overseer_m31_execution_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_m31_mutation();
