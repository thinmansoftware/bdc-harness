-- M-27B: exclusive execution claims.
-- Independent fenced claim ledger for board-approved production actions.
-- No foreign key to the Dispatch message table and no Dispatch identifier/token column.

CREATE TABLE IF NOT EXISTS board_execution_claims (
  claim_id TEXT PRIMARY KEY,
  motion_id TEXT NOT NULL,
  action_kind TEXT NOT NULL CHECK (action_kind = 'production_deploy'),
  environment TEXT NOT NULL CHECK (environment = 'production'),
  target_sha TEXT NOT NULL CHECK (target_sha ~ '^[0-9a-f]{40}$'),
  action_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  motion_file_path TEXT NOT NULL,
  motion_revision_sha TEXT NOT NULL CHECK (motion_revision_sha ~ '^[0-9a-f]{40}$'),
  claimant_principal TEXT NOT NULL,
  claimant_xo_holder_id TEXT NOT NULL,
  claimant_xo_lease_id TEXT NOT NULL,
  claimant_xo_fencing_token BIGINT NOT NULL CHECK (claimant_xo_fencing_token > 0),
  execution_fencing_token BIGINT NOT NULL CHECK (execution_fencing_token > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'completed')),
  reconciliation_status TEXT NOT NULL CHECK (
    reconciliation_status IN ('clear', 'required', 'resolved_retryable', 'resolved_completed')
  ),
  effect_attempt_id TEXT,
  effect_attempt_state TEXT NOT NULL CHECK (
    effect_attempt_state IN ('none', 'armed', 'completed', 'reconciled')
  ),
  effect_armed_at TIMESTAMPTZ,
  acquired_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  external_effect_reference TEXT,
  completion_evidence_json JSONB,
  reconciliation_evidence_json JSONB,
  CONSTRAINT board_execution_claims_action_identity_unique
    UNIQUE (motion_id, action_kind, environment, target_sha),
  CONSTRAINT board_execution_claims_status_reconciliation_pair CHECK (
    (status = 'active' AND reconciliation_status IN ('clear', 'required'))
    OR (status = 'released' AND reconciliation_status IN ('clear', 'resolved_retryable'))
    OR (status = 'completed' AND reconciliation_status IN ('clear', 'resolved_completed'))
  ),
  CONSTRAINT board_execution_claims_arm_iff_required CHECK (
    (reconciliation_status = 'required') = (effect_attempt_state = 'armed')
  ),
  CONSTRAINT board_execution_claims_armed_attempt_present CHECK (
    effect_attempt_state <> 'armed'
    OR (effect_attempt_id IS NOT NULL AND effect_armed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_board_execution_claims_active
  ON board_execution_claims(status, reconciliation_status, expires_at);

CREATE TABLE IF NOT EXISTS board_execution_claim_events (
  event_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES board_execution_claims(claim_id),
  event_sequence BIGINT NOT NULL CHECK (event_sequence > 0),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'claim_acquired',
      'claim_conflict',
      'claim_renewed',
      'claim_taken_over',
      'claim_released',
      'claim_stale_rejected',
      'claim_effect_armed',
      'claim_reconciliation_required',
      'claim_reconciled_retryable',
      'claim_reconciled_completed',
      'claim_completed'
    )
  ),
  actor_principal TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('xo', 'john', 'system')),
  xo_lease_id TEXT,
  xo_fencing_token BIGINT CHECK (xo_fencing_token IS NULL OR xo_fencing_token > 0),
  execution_fencing_token BIGINT CHECK (execution_fencing_token IS NULL OR execution_fencing_token > 0),
  details_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT board_execution_claim_events_sequence_unique UNIQUE (claim_id, event_sequence)
);

CREATE INDEX IF NOT EXISTS idx_board_execution_claim_events_claim
  ON board_execution_claim_events(claim_id, created_at);

CREATE OR REPLACE FUNCTION prevent_board_execution_claim_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'board_execution_claim_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_board_execution_claim_events_no_update ON board_execution_claim_events;
CREATE TRIGGER trg_board_execution_claim_events_no_update
  BEFORE UPDATE ON board_execution_claim_events
  FOR EACH ROW EXECUTE FUNCTION prevent_board_execution_claim_event_mutation();

DROP TRIGGER IF EXISTS trg_board_execution_claim_events_no_delete ON board_execution_claim_events;
CREATE TRIGGER trg_board_execution_claim_events_no_delete
  BEFORE DELETE ON board_execution_claim_events
  FOR EACH ROW EXECUTE FUNCTION prevent_board_execution_claim_event_mutation();

-- Pre-claim authority rejections and manual initiation are recorded on the
-- append-only board_audit_events store, not a fake claim event. Extend the
-- foundation closed event_type check with the two M-27B pre-claim events.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'board_audit_events'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%event_type%'
    AND pg_get_constraintdef(con.oid) LIKE '%xo_lease_acquired%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE board_audit_events DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE board_audit_events
  ADD CONSTRAINT board_audit_events_event_type_check
  CHECK (
    event_type IN (
      'xo_lease_acquired',
      'xo_lease_acquire_rejected',
      'xo_lease_renewed',
      'xo_lease_renew_rejected',
      'xo_lease_released',
      'xo_lease_release_rejected',
      'board_recipient_resolved',
      'board_recipient_deferred',
      'canonical_motion_frozen',
      'canonical_approval_accepted',
      'canonical_approval_rejected',
      'motion_notification_enqueued',
      'motion_notification_deduplicated',
      'board_alias_resolved',
      'board_petition_delivered',
      'execution_claim_authority_rejected',
      'manual_initiation_recorded'
    )
  );
