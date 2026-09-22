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
