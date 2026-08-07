-- WO-HARNESS-TASKMASTER-SLICE1-01 -- Taskmaster Slice 1 (M-133 ratified).
-- Additive only. No existing table is altered by this migration.
-- Companion sqlite DDL lives in packages/core/src/db/adapters/sqlite.ts
-- (createSchema); this file is the Postgres path only.
--
-- Deviations from the ratified synthesis (declared, Section 8b of the WO):
--   1. No tm_lease table -- the lease holds the rotating judgment chair, which
--      is Slice 1.5. tm_control carries the singleton/pause state Slice 1 needs.
--   2. tm_usage_sample (not usage_ledger) -- a row is one observation with
--      sampled_at + is_unknown, matching the sample-with-confidence shape.

-- tm_journal: append-only record of every proposed/attempted action. The row is
-- written BEFORE the send (row-first) so a crash between record and effect can
-- never produce an untracked send.
CREATE TABLE IF NOT EXISTS tm_journal (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  thread_ref TEXT NOT NULL,
  action_type TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  before_hash TEXT,
  proof_predicate TEXT,
  proof_deadline_at TIMESTAMPTZ,
  outcome TEXT NOT NULL DEFAULT 'proposed',
  graded_at TIMESTAMPTZ,
  grade TEXT
);

CREATE INDEX IF NOT EXISTS idx_tm_journal_thread_created
  ON tm_journal(thread_ref, created_at);
CREATE INDEX IF NOT EXISTS idx_tm_journal_outcome
  ON tm_journal(outcome, created_at);

-- tm_control: single-row control plane (id = 1). Holds pause state and the
-- monotonic pause epoch. Resume increments the epoch so stale proposals expire
-- rather than replay.
CREATE TABLE IF NOT EXISTS tm_control (
  id INTEGER PRIMARY KEY,
  pause_state TEXT NOT NULL DEFAULT 'RUNNING'
    CHECK (pause_state IN ('RUNNING', 'PAUSED', 'HARD_PAUSE')),
  pause_scope TEXT,
  pause_reason TEXT,
  pause_actor TEXT,
  epoch INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO tm_control (id, pause_state, epoch)
  VALUES (1, 'RUNNING', 0)
  ON CONFLICT (id) DO NOTHING;

-- tm_health: durable provider health samples with explicit expiry. The engine's
-- process-scoped darkEngines Map is fail-open-on-restart and is NOT authoritative
-- for the Taskmaster; these rows are.
CREATE TABLE IF NOT EXISTS tm_health (
  provider TEXT NOT NULL,
  state TEXT NOT NULL,
  sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  evidence TEXT,
  PRIMARY KEY (provider, sampled_at)
);

CREATE INDEX IF NOT EXISTS idx_tm_health_provider_sampled
  ON tm_health(provider, sampled_at DESC);

-- tm_usage_sample: one capacity observation. is_unknown = 1 records that a meter
-- read FAILED -- a failed meter must never be represented as numeric-zero capacity.
CREATE TABLE IF NOT EXISTS tm_usage_sample (
  id TEXT PRIMARY KEY,
  provider TEXT,
  window_kind TEXT,
  source TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  value_json TEXT,
  confidence TEXT,
  is_unknown INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tm_usage_sample_observed
  ON tm_usage_sample(observed_at DESC);
