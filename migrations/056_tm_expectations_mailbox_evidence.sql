-- Migration 056: mailbox-aware expectation evidence bookkeeping
-- (WO-HARNESS-TASKMASTER-MAILBOX-EVIDENCE-01, bdc-xo#2028).
--
-- Two ADDITIVE columns on tm_expectations, applied the same way migration 050
-- added the front-door columns (ALTER TABLE ADD COLUMN, not a table recreate):
-- the live archon.db is already at 049/050 WITH rows, so a shape check that
-- treated a missing column as "outdated" would hit the non-empty refusal in
-- migration 049's DO block and block startup on a database that is merely one
-- additive migration behind.
--
--   last_escalation_state  the (acknowledged_at, addressed_at, status) tuple of
--                          the dispatched row at the moment this expectation was
--                          last escalated. NULL until a first escalation is
--                          sent. Compared before every escalation so an
--                          unchanged evidence tuple is suppressed instead of
--                          re-blockering the xo mailbox each tick.
--   due_extended           0/1 one-shot flag. An acknowledged-but-unaddressed
--                          mailbox row ("read, in progress") is granted exactly
--                          one further PROOF_DEADLINE_MS extension of due_at
--                          before it can escalate; this flag records that the
--                          single extension has been spent.
--
-- ONE TRANSACTION, per the migration-runner note in 049: these are applied with
-- `psql $DATABASE_URL < migrations/NNN.sql`, which autocommits per statement, so
-- an interruption between the two ALTERs without an explicit BEGIN would leave
-- the table half-migrated. Wrapping means an interruption rolls back and the
-- migration is simply re-run. ADD COLUMN IF NOT EXISTS keeps it idempotent.
BEGIN;

ALTER TABLE tm_expectations ADD COLUMN IF NOT EXISTS last_escalation_state TEXT;
ALTER TABLE tm_expectations
  ADD COLUMN IF NOT EXISTS due_extended INTEGER NOT NULL DEFAULT 0;

COMMIT;
