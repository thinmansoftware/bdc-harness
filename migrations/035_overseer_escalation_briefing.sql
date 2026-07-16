-- M-42 Slice 3 durable operator cards and delivery receipts.

CREATE TABLE IF NOT EXISTS overseer_operator_cards (
  card_id TEXT PRIMARY KEY CHECK (card_id ~ '^[0-9a-f]{64}$'),
  identity_version TEXT NOT NULL CHECK (identity_version = 'overseer-actionable-event-v1'),
  canonical_event_identity JSONB NOT NULL,
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  payload JSONB NOT NULL,
  run_id TEXT NOT NULL,
  wo_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  branch TEXT,
  pr_url TEXT,
  pr_number INTEGER CHECK (pr_number > 0),
  head_sha TEXT,
  base_branch TEXT,
  base_sha TEXT,
  checks JSONB NOT NULL,
  mergeability TEXT NOT NULL,
  blocker TEXT NOT NULL,
  mechanical_evidence JSONB NOT NULL,
  recovery_attempted JSONB NOT NULL,
  proposed_remediation JSONB NOT NULL,
  next_permitted_action TEXT NOT NULL,
  responsible_actor TEXT NOT NULL,
  actionable_event_at TIMESTAMPTZ NOT NULL,
  required_ruling TEXT,
  evidence_links JSONB NOT NULL,
  lifecycle_classification TEXT NOT NULL,
  governance_classification TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS overseer_operator_card_delivery_jobs (
  card_id TEXT NOT NULL REFERENCES overseer_operator_cards(card_id),
  channel TEXT NOT NULL CHECK (channel IN ('dispatch', 'builder_monitor', 'notion')),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'leased', 'succeeded', 'exhausted', 'indeterminate'
  )),
  attempts_started INTEGER NOT NULL DEFAULT 0 CHECK (attempts_started BETWEEN 0 AND 3),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  fencing_token BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (card_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_overseer_operator_card_jobs_due
  ON overseer_operator_card_delivery_jobs(state, next_attempt_at, channel);

CREATE TABLE IF NOT EXISTS overseer_operator_card_delivery_receipts (
  receipt_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES overseer_operator_cards(card_id),
  channel TEXT NOT NULL CHECK (channel IN ('dispatch', 'builder_monitor', 'notion')),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  phase TEXT NOT NULL CHECK (phase IN ('started', 'terminal')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  outcome TEXT CHECK (outcome IN (
    'succeeded', 'transient_failure', 'permanent_failure', 'indeterminate'
  )),
  sanitized_status TEXT,
  error_class TEXT,
  next_attempt_at TIMESTAMPTZ,
  provider_receipt_id TEXT,
  fencing_token BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (card_id, channel, attempt_number, phase),
  CHECK (
    (phase = 'started' AND completed_at IS NULL AND outcome IS NULL)
    OR (phase = 'terminal' AND completed_at IS NOT NULL AND outcome IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_overseer_operator_card_receipts_card
  ON overseer_operator_card_delivery_receipts(card_id, channel, attempt_number, phase);

CREATE OR REPLACE FUNCTION prevent_overseer_briefing_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_overseer_operator_cards_no_update ON overseer_operator_cards;
CREATE TRIGGER trg_overseer_operator_cards_no_update
  BEFORE UPDATE ON overseer_operator_cards
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_briefing_mutation();
DROP TRIGGER IF EXISTS trg_overseer_operator_cards_no_delete ON overseer_operator_cards;
CREATE TRIGGER trg_overseer_operator_cards_no_delete
  BEFORE DELETE ON overseer_operator_cards
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_briefing_mutation();

DROP TRIGGER IF EXISTS trg_overseer_operator_card_delivery_receipts_no_update
  ON overseer_operator_card_delivery_receipts;
CREATE TRIGGER trg_overseer_operator_card_delivery_receipts_no_update
  BEFORE UPDATE ON overseer_operator_card_delivery_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_briefing_mutation();
DROP TRIGGER IF EXISTS trg_overseer_operator_card_delivery_receipts_no_delete
  ON overseer_operator_card_delivery_receipts;
CREATE TRIGGER trg_overseer_operator_card_delivery_receipts_no_delete
  BEFORE DELETE ON overseer_operator_card_delivery_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_briefing_mutation();
