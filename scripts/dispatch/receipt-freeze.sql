-- Dispatch receipt freeze (M-187a Rollback, Astra amendment #4;
-- WO-HARNESS-DISPATCH-HONEST-RECEIPTS-01).
--
-- Rolling archon-app-1 back to a receipt-writing LEGACY image against the live
-- database is PROHIBITED unless (1) OPERATOR_INBOX_INTERVAL_MS=0 is set and
-- (2) this freeze is applied FIRST. Order is load-bearing:
--     interval 0  ->  freeze  ->  retag and recreate (legacy image)
-- Under the freeze, legacy ack/address routes return 500 and the legacy
-- operator inbox consumer logs message_process_failed per row and writes
-- nothing -- no machine can stamp a receipt while honest code is absent.
--
-- Unfreeze (scripts/dispatch/receipt-unfreeze.sql) ONLY after honest code is
-- back. This trigger is SQLite syntax; the live store is SQLite.
--
-- Invocation (operator-side):
--     sqlite3 /opt/bdc/archon-data/archon.db < scripts/dispatch/receipt-freeze.sql
--
-- dispatch_receipt_cutover is never touched by this freeze.

CREATE TRIGGER IF NOT EXISTS trg_dispatch_receipts_frozen
BEFORE UPDATE OF acknowledged_at, acknowledged_by, addressed_at, addressed_by
ON agent_dispatch_messages
BEGIN
  SELECT RAISE(ABORT, 'dispatch_receipts_frozen');
END;
