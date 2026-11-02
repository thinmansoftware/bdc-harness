-- Board authority foundation: fenced XO lease and append-only audit.

CREATE TABLE IF NOT EXISTS board_xo_leases (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_id UUID NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  seat_id TEXT NOT NULL CHECK (seat_id IN ('john', 'general', 'xo')),
  holder_id TEXT NOT NULL,
  holder_token_hash TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  acquired_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_board_xo_leases_active
  ON board_xo_leases(expires_at)
  WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS board_audit_events (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (
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
      'canonical_approval_rejected'
    )
  ),
  actor_principal_id TEXT,
  actor_seat_id TEXT CHECK (actor_seat_id IS NULL OR actor_seat_id IN ('john', 'general', 'xo')),
  xo_lease_id UUID,
  xo_fencing_token BIGINT CHECK (xo_fencing_token IS NULL OR xo_fencing_token > 0),
  motion_id TEXT,
  motion_revision_sha TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_board_audit_events_created
  ON board_audit_events(created_at);

CREATE INDEX IF NOT EXISTS idx_board_audit_events_motion
  ON board_audit_events(motion_id, motion_revision_sha)
  WHERE motion_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_board_audit_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'board_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_board_audit_events_no_update ON board_audit_events;
CREATE TRIGGER trg_board_audit_events_no_update
  BEFORE UPDATE ON board_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_board_audit_event_mutation();

DROP TRIGGER IF EXISTS trg_board_audit_events_no_delete ON board_audit_events;
CREATE TRIGGER trg_board_audit_events_no_delete
  BEFORE DELETE ON board_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_board_audit_event_mutation();
