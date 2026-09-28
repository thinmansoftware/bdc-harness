-- M-20260928c: exact-commit CE scope approvals in the append-only audit log.
ALTER TABLE board_audit_events ADD COLUMN IF NOT EXISTS subject_key TEXT;

DO $$
DECLARE constraint_name TEXT;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'board_audit_events' AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%event_type%'
    AND pg_get_constraintdef(con.oid) LIKE '%xo_lease_acquired%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE board_audit_events DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE board_audit_events ADD CONSTRAINT board_audit_events_event_type_check CHECK (
  event_type IN (
    'xo_lease_acquired','xo_lease_acquire_rejected','xo_lease_renewed',
    'xo_lease_renew_rejected','xo_lease_released','xo_lease_release_rejected',
    'board_recipient_resolved','board_recipient_deferred','canonical_motion_frozen',
    'canonical_approval_accepted','canonical_approval_rejected',
    'motion_notification_enqueued','motion_notification_deduplicated',
    'board_alias_resolved','board_petition_delivered',
    'execution_claim_authority_rejected','manual_initiation_recorded',
    'ce_scope_approval_recorded','ce_scope_approval_revoked','ce_scope_approval_rejected'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_board_audit_events_subject
  ON board_audit_events(event_type, subject_key) WHERE subject_key IS NOT NULL;
