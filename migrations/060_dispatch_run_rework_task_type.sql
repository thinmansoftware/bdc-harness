-- Migration 060 (WO-HARNESS-OVERSEER-REWORK-LOOP-01): widens the
-- agent_dispatch_messages.task_type CHECK to accept 'run_rework'.
--
-- Migration 059 seeds the 'overseer-rework' dispatch_principals row but does
-- NOT touch the task_type CHECK constraint on agent_dispatch_messages, so an
-- existing (pre-057) Postgres database still rejects any run_rework insert
-- with a check-constraint violation even after 057 runs. 000_combined.sql
-- already carries 'run_rework' in its CHECK because it is the fresh-schema
-- definition, not a migration -- it never runs against an existing database.
--
-- SCHEMA-QUALIFIED LOOKUP (same fix as migration 055, PR #868 review):
-- to_regclass('agent_dispatch_messages') resolves the table through the
-- CURRENT connection's search_path, the same way every other statement in
-- this migration (and the app itself) resolves it, so conrelid always points
-- at the same table the ALTER TABLE below operates on.
DO $$
DECLARE
  target_oid oid := to_regclass('agent_dispatch_messages');
  constraint_name text;
BEGIN
  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'migration 060: agent_dispatch_messages not found via to_regclass on current search_path';
  END IF;

  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  WHERE c.conrelid = target_oid
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%task_type%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE agent_dispatch_messages DROP CONSTRAINT %I', constraint_name);
  END IF;
  ALTER TABLE agent_dispatch_messages ADD CHECK (
    task_type IN ('agent_message', 'run_review', 'run_rework', 'draft_spec', 'run_report', 'board_motion')
  );
END $$;
