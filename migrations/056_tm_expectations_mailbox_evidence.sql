-- Migration 056: mailbox-aware expectation evidence bookkeeping
-- (WO-HARNESS-TASKMASTER-MAILBOX-EVIDENCE-01, bdc-xo#2028).
--
-- One ADDITIVE column on tm_expectations, applied the same way migration 050
-- added the front-door columns (ALTER TABLE ADD COLUMN, not a table recreate):
-- the live archon.db is already at 049/050 WITH rows, so a shape check that
-- treated a missing column as "outdated" would hit the non-empty refusal in
-- migration 049's DO block and block startup on a database that is merely one
-- additive migration behind.
--
--   due_extended           0/1 one-shot flag. An acknowledged-but-unaddressed
--                          mailbox row ("read, in progress") is granted exactly
--                          one further PROOF_DEADLINE_MS extension of due_at
--                          before it can escalate; this flag records that the
--                          single extension has been spent.
--
-- ONE TRANSACTION, per the migration-runner note in 049: this is applied with
-- `psql $DATABASE_URL < migrations/NNN.sql`, which autocommits per statement, so
-- wrapping in an explicit BEGIN means an interruption rolls back and the
-- migration is simply re-run. ADD COLUMN IF NOT EXISTS keeps it idempotent.
BEGIN;

ALTER TABLE tm_expectations
  ADD COLUMN IF NOT EXISTS due_extended INTEGER NOT NULL DEFAULT 0;

COMMIT;
