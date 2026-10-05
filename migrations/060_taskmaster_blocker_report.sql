-- Migration 060: widen tm_journal.action_type to include blocker_report
-- (WO-HARNESS-TASKMASTER-BLOCKER-REPORT-TO-DO-01). Supersedes the verb CHECK
-- from migration 045. The grade CHECK is unchanged.
--
-- SCHEMA-QUALIFIED LOOKUP: to_regclass('tm_journal') resolves through the
-- current connection's search_path, matching migration 055. The action_type
-- predicate matches migration 045 so the grade CHECK (which does not contain
-- the token 'action_type') is left in place.
DO $$
DECLARE
  target_oid oid := to_regclass('tm_journal');
  constraint_name text;
BEGIN
  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'migration 060: tm_journal not found via to_regclass on current search_path';
  END IF;

  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  WHERE c.conrelid = target_oid
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%action_type%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tm_journal DROP CONSTRAINT %I', constraint_name);
  END IF;
  ALTER TABLE tm_journal ADD CHECK (
    action_type IN ('deliver_ruling', 'nudge', 'escalate_p0', 'digest', 'fire_cauldron', 'blocker_report')
  );
END $$;
