-- WO-HARNESS-T3-COMMAND-CONSUMER-01: durable admission ledger + principals for
-- the cauldron-fire T3 command consumer.
--
-- A typed command (fire / cancel-own / approve) sent by an authorized Dispatch
-- principal to recipient `cauldron-fire` is decided once, server-side. This
-- table is the durable record of that decision: retries return the original
-- outcome, a WO with a live run is never fired twice, and request + run
-- identity are retained after completion (rows are never deleted).
--
-- Modeled on migration 063 (tm_fire_admissions) but keyed by request_id, not
-- action_key, and NOT reusing tm_fire_admissions (its CHECK pins
-- source='taskmaster'). State vocabulary mirrors 063's reserved/admitted/
-- (released -> here refused)/unknown rule: an `unknown` fire never refires.

CREATE TABLE IF NOT EXISTS t3_command_admissions (
  request_id TEXT PRIMARY KEY,
  actor_principal_id TEXT NOT NULL,
  verb TEXT NOT NULL CHECK (verb IN ('fire', 'cancel-own', 'approve')),
  payload_sha256 TEXT NOT NULL,
  wo_id TEXT,
  project TEXT,
  target_run_id TEXT,
  pr_ref TEXT,
  head_sha TEXT,
  thread_id TEXT,
  source_message_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'admitted', 'refused', 'unknown')),
  status_code INTEGER,
  code TEXT,
  cascade_id TEXT,
  run_id TEXT,
  reply_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- WO fire lock: at most one UNRESOLVED fire per wo_id. `reserved` is
-- mid-admission; `unknown` is a fire whose effect could not be proven (crash or
-- uncertain cascade) and holds the lock until an operator adjudicates it
-- (adjudicateUnknownFire -> admitted or refused). A second fire reservation for
-- the same WO violates this index and is refused 409 live_run.
DROP INDEX IF EXISTS idx_t3_command_admissions_live_fire;
CREATE UNIQUE INDEX IF NOT EXISTS idx_t3_command_admissions_wo_fire_lock
  ON t3_command_admissions (wo_id)
  WHERE verb = 'fire' AND state IN ('reserved', 'unknown');

-- Recipient principal for the consumer (drains the command mailbox and sends
-- replies) and the T3 VPS bridge sender. Shape copied from migration 065.
INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
VALUES
  ('cauldron-fire', 'T3 command consumer', 'drain_on_start', TRUE),
  ('t3-bridge', 'T3 VPS bridge sender', 'drain_on_start', TRUE)
ON CONFLICT (principal_id) DO NOTHING;
