-- Migration 045: supersedes and widens migration 041's Taskmaster verb CHECK.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'tm_journal'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%action_type%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tm_journal DROP CONSTRAINT %I', constraint_name);
  END IF;
  ALTER TABLE tm_journal ADD CHECK (
    action_type IN ('deliver_ruling', 'nudge', 'escalate_p0', 'digest', 'fire_cauldron')
  );
END $$;
