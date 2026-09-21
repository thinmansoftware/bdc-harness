-- Migration 055 (M-155 Amendment 03, John's ruling 2026-09-21): widen the
-- tm_journal.grade CHECK to add 'unheard'. Supersedes migration 041's grade
-- CHECK. Follows migration 045's drop/re-add pattern (locate the grade CHECK
-- via pg_constraint, drop it, re-add with the widened value set). No other
-- column or data is touched.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'tm_journal'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%grade%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tm_journal DROP CONSTRAINT %I', constraint_name);
  END IF;
  ALTER TABLE tm_journal ADD CHECK (
    grade IS NULL OR grade IN ('useful', 'noise', 'harmful', 'unheard')
  );
END $$;
