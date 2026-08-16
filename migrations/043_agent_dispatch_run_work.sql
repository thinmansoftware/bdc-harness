-- M-131 / WO-HARNESS-CAULDRON-DESKTOP-CURSOR-GROK-LANES-01:
-- add the fenced desktop execution task to the existing Dispatch queue.

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
  CHECK (
    task_type IN (
      'agent_message',
      'run_review',
      'draft_spec',
      'run_report',
      'board_motion',
      'run_work'
    )
  );
