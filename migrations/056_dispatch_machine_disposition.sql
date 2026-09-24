-- M-187a: machines record routing dispositions, never human mailbox receipts.
DO $$
DECLARE
  target_oid oid := to_regclass('agent_dispatch_messages');
  constraint_name text;
BEGIN
  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'migration 056: agent_dispatch_messages not found via to_regclass on current search_path';
  END IF;

  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  WHERE c.conrelid = target_oid
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%route_disposition%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE agent_dispatch_messages DROP CONSTRAINT %I', constraint_name);
  END IF;
  ALTER TABLE agent_dispatch_messages ADD CHECK (
    route_disposition IS NULL OR route_disposition IN ('unroutable', 'superseded', 'expired', 'auto_surfaced')
  );
END $$;

ALTER TABLE agent_dispatch_messages ADD COLUMN IF NOT EXISTS route_disposed_at TEXT;

CREATE TABLE IF NOT EXISTS dispatch_receipt_cutover (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  applied_at TEXT NOT NULL
);

INSERT INTO dispatch_receipt_cutover (id, applied_at)
VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO NOTHING;
