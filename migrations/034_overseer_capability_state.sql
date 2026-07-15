-- M-42 Slice 1 Overseer capability state and immutable gate events.
--
-- Capabilities are seeded disabled with closed circuits and unconfigured digest
-- sentinels. The events table is append-only. The state table is intentionally
-- mutable only through narrow application operations.

CREATE TABLE IF NOT EXISTS overseer_capability_state (
  capability TEXT PRIMARY KEY CHECK (capability IN (
    'escalation', 'repair', 'branch', 'lifecycle', 'merge'
  )),
  action_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  circuit_state TEXT NOT NULL DEFAULT 'closed' CHECK (circuit_state IN ('closed', 'open')),
  circuit_reason TEXT,
  circuit_opened_at TIMESTAMP WITH TIME ZONE,
  policy_digest TEXT NOT NULL CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
  verifier_registry_digest TEXT NOT NULL
    CHECK (verifier_registry_digest ~ '^[0-9a-f]{64}$'),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS overseer_capability_events (
  event_id TEXT PRIMARY KEY,
  capability TEXT NOT NULL CHECK (capability IN (
    'escalation', 'repair', 'branch', 'lifecycle', 'merge'
  )),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'gate_allowed', 'gate_denied', 'circuit_opened', 'circuit_reset', 'adapter_attempt'
  )),
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  proposal_id TEXT REFERENCES overseer_m31_action_proposals(proposal_id),
  execution_id TEXT REFERENCES overseer_m31_action_proposals(execution_id),
  policy_digest TEXT NOT NULL CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
  verifier_registry_digest TEXT NOT NULL
    CHECK (verifier_registry_digest ~ '^[0-9a-f]{64}$'),
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_overseer_capability_events_capability
  ON overseer_capability_events(capability, created_at);

-- One execution may cross a fake mutation boundary at most once. The partial
-- unique index is the persistent compare-and-set used by fake adapters; it
-- closes replay races across concurrent tasks and process restarts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_overseer_capability_events_adapter_execution
  ON overseer_capability_events(execution_id)
  WHERE event_type = 'adapter_attempt' AND execution_id IS NOT NULL;

INSERT INTO overseer_capability_state (
  capability, action_enabled, circuit_state, circuit_reason, circuit_opened_at,
  policy_digest, verifier_registry_digest, updated_at, updated_by
) VALUES
  ('escalation', FALSE, 'closed', NULL, NULL,
   '0000000000000000000000000000000000000000000000000000000000000000',
   '0000000000000000000000000000000000000000000000000000000000000000',
   NOW(), 'migration-034'),
  ('repair', FALSE, 'closed', NULL, NULL,
   '0000000000000000000000000000000000000000000000000000000000000000',
   '0000000000000000000000000000000000000000000000000000000000000000',
   NOW(), 'migration-034'),
  ('branch', FALSE, 'closed', NULL, NULL,
   '0000000000000000000000000000000000000000000000000000000000000000',
   '0000000000000000000000000000000000000000000000000000000000000000',
   NOW(), 'migration-034'),
  ('lifecycle', FALSE, 'closed', NULL, NULL,
   '0000000000000000000000000000000000000000000000000000000000000000',
   '0000000000000000000000000000000000000000000000000000000000000000',
   NOW(), 'migration-034'),
  ('merge', FALSE, 'closed', NULL, NULL,
   '0000000000000000000000000000000000000000000000000000000000000000',
   '0000000000000000000000000000000000000000000000000000000000000000',
   NOW(), 'migration-034')
ON CONFLICT (capability) DO NOTHING;

CREATE OR REPLACE FUNCTION prevent_overseer_capability_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_overseer_capability_events_no_update ON overseer_capability_events;
CREATE TRIGGER trg_overseer_capability_events_no_update
  BEFORE UPDATE ON overseer_capability_events
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_capability_event_mutation();

DROP TRIGGER IF EXISTS trg_overseer_capability_events_no_delete ON overseer_capability_events;
CREATE TRIGGER trg_overseer_capability_events_no_delete
  BEFORE DELETE ON overseer_capability_events
  FOR EACH ROW EXECUTE FUNCTION prevent_overseer_capability_event_mutation();
