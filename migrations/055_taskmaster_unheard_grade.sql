-- Migration 055: adds the 'unheard' grade (M-155 Amendment 03, John's ruling
-- 2026-09-21, WO-HARNESS-TASKMASTER-UNHEARD-GRADE-01). Supersedes and widens
-- migration 041's tm_journal.grade CHECK. An action is graded 'unheard' when its
-- dispatch row was never acknowledged by a non-draining principal (a
-- drain_on_start mailbox, e.g. 'operator', auto-addresses within seconds and is
-- never human-read). 'unheard' is excluded from the useful-rate floor
-- denominator; only 'useful' and 'noise' are counted.
--
-- The grade CHECK added in migration 041 is an unnamed inline CHECK, so drop it
-- by discovering its generated name. The filter pg_get_constraintdef LIKE
-- '%grade%' matches ONLY the grade CHECK: the sibling unnamed CHECKs on
-- tm_journal constrain 'outcome' and 'action_type' (migration 045) and their
-- definitions do not contain the token 'grade'.
--
-- SCHEMA-QUALIFIED LOOKUP (fix for the unqualified-by-table-name bug flagged on
-- PR #868 review): filtering pg_class by relname alone can return more than one
-- row, or the wrong row, if any schema on the search_path other than the one
-- this connection actually uses also happens to have a table named
-- 'tm_journal'. to_regclass('tm_journal') resolves the name through the
-- CURRENT connection's search_path exactly the way every other statement in
-- this migration (and the app itself) resolves it, so conrelid always points
-- at the same table the unqualified ALTER TABLE below will operate on -- there
-- is no separate "discover the OID" step that could pick a different table
-- than the one being altered.
DO $$
DECLARE
  target_oid oid := to_regclass('tm_journal');
  constraint_name text;
BEGIN
  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'migration 055: tm_journal not found via to_regclass on current search_path';
  END IF;

  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  WHERE c.conrelid = target_oid
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%grade%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tm_journal DROP CONSTRAINT %I', constraint_name);
  END IF;
  ALTER TABLE tm_journal ADD CHECK (
    grade IS NULL OR grade IN ('useful', 'noise', 'harmful', 'unheard')
  );
END $$;
