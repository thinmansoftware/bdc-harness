-- Migration 060: adds the sixth Taskmaster verb 'blocker_report'
-- (WO-HARNESS-TASKMASTER-BLOCKER-REPORT-TO-DO-01). Supersedes and widens
-- migration 045's tm_journal.action_type CHECK to the six verbs. A
-- blocker_report is addressed to the duty-officer mailbox when a thread has
-- been blocked (or is an unclaimed P0 the Taskmaster cannot fire) for 2h+, and
-- the Duty Officer clock relays it to the XO -- completing the ladder
-- Taskmaster -> Duty Officer -> XO without Taskmaster messaging owners directly.
--
-- The action_type CHECK (migration 041, re-added in 045) is an unnamed inline
-- CHECK, so drop it by discovering its generated name. The filter
-- pg_get_constraintdef LIKE '%action_type%' matches ONLY the action_type CHECK:
-- the sibling unnamed CHECKs on tm_journal constrain 'outcome' and 'grade'
-- (migrations 055/056) and their definitions do not contain the token
-- 'action_type'.
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
