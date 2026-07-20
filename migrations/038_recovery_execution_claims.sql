-- Recovery-scoped execution claims for Overseer repair/refire fencing.
-- Additive sibling to board_execution_claims; no XO lease or board-motion authority.

CREATE TABLE IF NOT EXISTS remote_agent_recovery_execution_claims (
  claim_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  wo_id TEXT NOT NULL,
  source_run_id TEXT,
  target_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  action_key TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('overseer', 'conductor', 'manual')),
  execution_fencing_token BIGINT NOT NULL CHECK (execution_fencing_token > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'completed')),
  effect_attempt_id TEXT,
  effect_attempt_state TEXT NOT NULL CHECK (
    effect_attempt_state IN ('none', 'armed', 'completed', 'released')
  ),
  acquired_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  external_effect_reference TEXT,
  completion_evidence_json JSONB,
  CONSTRAINT recovery_execution_claims_identity_unique
    UNIQUE (repository, wo_id, source_run_id, target_digest, scope_digest),
  CONSTRAINT recovery_execution_claims_attempt_state CHECK (
    (effect_attempt_state = 'none' AND effect_attempt_id IS NULL)
    OR (effect_attempt_state IN ('armed', 'completed', 'released') AND effect_attempt_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_recovery_execution_claims_active
  ON remote_agent_recovery_execution_claims(status, expires_at);

CREATE TABLE IF NOT EXISTS remote_agent_recovery_execution_claim_events (
  event_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES remote_agent_recovery_execution_claims(claim_id),
  event_sequence BIGINT NOT NULL CHECK (event_sequence > 0),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'claim_acquired',
      'claim_conflict',
      'claim_reactivated',
      'claim_taken_over',
      'claim_effect_armed',
      'claim_released',
      'claim_completed'
    )
  ),
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('overseer', 'conductor', 'manual')),
  execution_fencing_token BIGINT CHECK (execution_fencing_token IS NULL OR execution_fencing_token > 0),
  details_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT recovery_execution_claim_events_sequence_unique UNIQUE (claim_id, event_sequence)
);

CREATE INDEX IF NOT EXISTS idx_recovery_execution_claim_events_claim
  ON remote_agent_recovery_execution_claim_events(claim_id, created_at);

CREATE OR REPLACE FUNCTION prevent_recovery_execution_claim_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'remote_agent_recovery_execution_claim_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recovery_execution_claim_events_no_update
  ON remote_agent_recovery_execution_claim_events;
CREATE TRIGGER trg_recovery_execution_claim_events_no_update
  BEFORE UPDATE ON remote_agent_recovery_execution_claim_events
  FOR EACH ROW EXECUTE FUNCTION prevent_recovery_execution_claim_event_mutation();

DROP TRIGGER IF EXISTS trg_recovery_execution_claim_events_no_delete
  ON remote_agent_recovery_execution_claim_events;
CREATE TRIGGER trg_recovery_execution_claim_events_no_delete
  BEFORE DELETE ON remote_agent_recovery_execution_claim_events
  FOR EACH ROW EXECUTE FUNCTION prevent_recovery_execution_claim_event_mutation();
