-- Migration 067: admit the seventh Taskmaster verb, remediation_nudge.
-- Forward schema-parity correction for the remediation consumer. Preserve all
-- six existing verbs and the separate outcome/grade constraints. Resolve the
-- target through this connection's search_path, as migration 060 does.
-- This changes the migrated Taskmaster lineage only; combined-schema Taskmaster
-- reconstruction and runtime application are separate work.
DO $$
DECLARE
  target_oid oid := to_regclass('tm_journal');
  constraint_name text;
BEGIN
  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'migration 067: tm_journal not found via to_regclass on current search_path';
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
    action_type IN ('deliver_ruling', 'nudge', 'escalate_p0', 'digest', 'fire_cauldron', 'blocker_report', 'remediation_nudge')
  );
END $$;
