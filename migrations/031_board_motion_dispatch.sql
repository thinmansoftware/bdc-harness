-- M-27A: board motion pointer dispatch and late-bound board alias delivery.

ALTER TABLE agent_dispatch_messages
  ADD COLUMN IF NOT EXISTS recipient_alias TEXT CHECK (recipient_alias IS NULL OR recipient_alias = 'board'),
  ADD COLUMN IF NOT EXISTS motion_id TEXT,
  ADD COLUMN IF NOT EXISTS motion_revision_sha TEXT CHECK (
    motion_revision_sha IS NULL OR motion_revision_sha ~ '^[0-9a-f]{40}$'
  ),
  ADD COLUMN IF NOT EXISTS resolved_recipient TEXT,
  ADD COLUMN IF NOT EXISTS resolved_xo_lease_id TEXT,
  ADD COLUMN IF NOT EXISTS resolved_xo_fencing_token BIGINT CHECK (
    resolved_xo_fencing_token IS NULL OR resolved_xo_fencing_token > 0
  ),
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_dispatch_board_pending
  ON agent_dispatch_messages(recipient_alias, status, created_at);

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'agent_dispatch_messages'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%task_type%'
    AND pg_get_constraintdef(con.oid) LIKE '%agent_message%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE agent_dispatch_messages DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE agent_dispatch_messages
  ADD CONSTRAINT agent_dispatch_messages_task_type_check
  CHECK (task_type IN ('agent_message', 'run_review', 'draft_spec', 'run_report', 'board_motion'));

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
      'board_petition_delivered'
    )
  );
