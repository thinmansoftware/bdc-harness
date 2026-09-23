-- Dispatch receipt UNFREEZE (M-187a Rollback, Astra amendment #4;
-- WO-HARNESS-DISPATCH-HONEST-RECEIPTS-01).
--
-- Removes the receipt freeze installed by scripts/dispatch/receipt-freeze.sql.
-- Apply ONLY after honest code (machines write route_disposition, never
-- receipts) is back on archon-app-1. The rollback order this reverses is:
--     interval 0  ->  freeze  ->  retag and recreate (legacy image)
-- so unfreeze runs last, once the honest image is live again.
--
-- Invocation (operator-side):
--     sqlite3 /opt/bdc/archon-data/archon.db < scripts/dispatch/receipt-unfreeze.sql
--
-- dispatch_receipt_cutover is never touched by this unfreeze.

DROP TRIGGER IF EXISTS trg_dispatch_receipts_frozen;
