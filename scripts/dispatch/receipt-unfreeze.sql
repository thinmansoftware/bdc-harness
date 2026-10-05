-- M-187a: unfreeze only after honest receipt code is restored.
DROP TRIGGER IF EXISTS trg_dispatch_receipts_frozen;
