-- Migration 060: widen Taskmaster's action-type CHECK for blocker_report.
DO $$
DECLARE
  target_oid oid := to_regclass('tm_journal');
  constraint_name text;
BEGIN
  IF target_oid IS NULL THEN
    RETURN;
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
