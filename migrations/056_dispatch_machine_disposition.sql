-- Migration 056: honest machine dispositions (M-187a rev 2a-1, items 1/3/4/7,
-- WO-HARNESS-DISPATCH-HONEST-RECEIPTS-01). Widens the agent_dispatch_messages
-- route_disposition CHECK to admit the honest machine words 'expired' and
-- 'auto_surfaced', adds the route_disposed_at stamp column (written ONLY by the
-- machine disposition primitive), and creates the one-row dispatch_receipt_cutover
-- bookkeeping table that every later reader uses to separate pre-cutover stamps
-- (non-evidence) from post-cutover receipts.
--
-- After this migration a machine (the operator inbox consumer, the M-155
-- dead-letter expiry script) records what it did in route_disposition +
-- route_disposed_at and NEVER in acknowledged_* / addressed_*. 'expired' (like
-- the existing 'unroutable' and 'superseded') is terminal; 'auto_surfaced' is
-- NOT terminal -- the row stays ackable/addressable by a bound human actor.
--
-- No existing receipt value is rewritten (item 7: never backfill).
--
-- The route_disposition CHECK added in migration 040 is an unnamed inline CHECK,
-- so drop it by discovering its generated name. The filter pg_get_constraintdef
-- LIKE '%route_disposition%' matches ONLY the route_disposition CHECK: the
-- sibling unnamed CHECKs on agent_dispatch_messages constrain 'status',
-- 'priority', 'task_outcome', 'recipient_alias', 'motion_revision_sha',
-- 'fencing_token' and 'resolved_xo_fencing_token', and none of their definitions
-- contain the token 'route_disposition'.
--
-- SCHEMA-QUALIFIED LOOKUP (mirrors migration 055): to_regclass resolves the name
-- through the current connection's search_path exactly the way the unqualified
-- ALTER TABLE below does, so conrelid always points at the same table being
-- altered.
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

-- Machine-only disposition stamp. Existing rows keep NULL (no backfill).
ALTER TABLE agent_dispatch_messages
  ADD COLUMN IF NOT EXISTS route_disposed_at TEXT;

-- One-row cutover bookkeeping table (pattern copied from tm_adoption_meta,
-- migration 043). Written once, on the first boot that applies 056, and
-- PRESERVED across every later boot, rebuild and rollback. The literal every
-- reader uses is:
--   SELECT applied_at FROM dispatch_receipt_cutover WHERE id = 1
CREATE TABLE IF NOT EXISTS dispatch_receipt_cutover (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  applied_at TEXT NOT NULL
);

INSERT INTO dispatch_receipt_cutover (id, applied_at)
VALUES (1, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (id) DO NOTHING;
