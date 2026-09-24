-- WO-HARNESS-OVERSEER-REWORK-LOOP-01: worker-poll recipient for run_rework.
-- Same shape as 056_dispatch_astra_mailbox.sql. Also widens the task_type
-- check so an existing database accepts run_rework rows.
INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
VALUES
  ('overseer-rework', 'Overseer Rework Dispatcher', 'worker_poll', TRUE)
ON CONFLICT (principal_id) DO NOTHING;

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
  CHECK (task_type IN ('agent_message', 'run_review', 'run_rework', 'draft_spec', 'run_report', 'board_motion'));
