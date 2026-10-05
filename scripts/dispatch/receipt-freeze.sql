-- M-187a rollback order: set OPERATOR_INBOX_INTERVAL_MS=0, apply this freeze,
-- then retag and recreate the legacy container.
CREATE TRIGGER IF NOT EXISTS trg_dispatch_receipts_frozen
BEFORE UPDATE OF acknowledged_at, acknowledged_by, addressed_at, addressed_by
ON agent_dispatch_messages
BEGIN
  SELECT RAISE(ABORT, 'dispatch_receipts_frozen');
END;
