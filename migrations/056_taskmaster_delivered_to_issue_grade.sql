-- Migration 056: adds the 'delivered_to_issue' grade
-- (WO-HARNESS-TASKMASTER-ESCALATE-TO-ISSUE-01). Supersedes and widens migration
-- 055's tm_journal.grade CHECK. An action is graded 'delivered_to_issue' at SEND
-- time (not by gradeSentActions) when a gh:owner/repo#N escalate_p0 was
-- delivered as a GitHub issue comment (marker '<!-- taskmaster-escalation -->')
-- rather than the operator dispatch mailbox. Like 'unheard', it is excluded from
-- the useful-rate floor denominator; only 'useful' and 'noise' are counted.
--
-- The grade CHECK added in migration 041 and re-added in 055 is an unnamed
-- inline CHECK, so drop it by discovering its generated name. The filter
-- pg_get_constraintdef LIKE '%grade%' matches ONLY the grade CHECK: the sibling
-- unnamed CHECKs on tm_journal constrain 'outcome' and 'action_type' and their
-- definitions do not contain the token 'grade'.
--
-- SCHEMA-QUALIFIED LOOKUP: to_regclass('tm_journal') resolves the name through
-- the CURRENT connection's search_path exactly the way the unqualified ALTER
-- TABLE below resolves it, so conrelid always points at the same table being
-- altered (see migration 055 for the full rationale).
DO $$
DECLARE
  target_oid oid := to_regclass('tm_journal');
  constraint_name text;
BEGIN
  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'migration 056: tm_journal not found via to_regclass on current search_path';
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
    grade IS NULL OR grade IN ('useful', 'noise', 'harmful', 'unheard', 'delivered_to_issue')
  );
END $$;
