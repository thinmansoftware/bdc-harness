-- Taskmaster Slice 1 (WO-HARNESS-TASKMASTER-SLICE1-01, M-133 CARRIED 3-0).
-- Additive only: creates new tm_* tables. No existing table is altered.
-- agent_dispatch_messages is untouched -- that surface belongs to
-- migration 040 (M-129 Phase 0, PR #616).

-- Action journal: every proposed/sent/parked/deferred/rejected effect gets a
-- row BEFORE the effect is attempted (row-first discipline).
CREATE TABLE IF NOT EXISTS tm_journal (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  thread_ref TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (
    action_type IN ('deliver_ruling', 'nudge', 'escalate_p0', 'digest')
  ),
  proposal_json TEXT NOT NULL,
  idempotency_key TEXT,
  before_hash TEXT,
  proof_predicate TEXT,
  proof_deadline_at TIMESTAMPTZ,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('pending', 'sent', 'parked', 'deferred', 'rejected', 'expired', 'failed')
  ),
  graded_at TIMESTAMPTZ,
  grade TEXT CHECK (grade IS NULL OR grade IN ('useful', 'noise', 'harmful'))
);

CREATE INDEX IF NOT EXISTS idx_tm_journal_thread ON tm_journal(thread_ref, created_at);
CREATE INDEX IF NOT EXISTS idx_tm_journal_idem ON tm_journal(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_tm_journal_created ON tm_journal(created_at);

-- Singleton pause/epoch control row. An automatic circuit may only tighten
-- into PAUSED/HARD_PAUSE; it may never convert into KILL (KILL is
-- TASKMASTER_INTERVAL_MS=0, operator-set only). Resume is John-authorized,
-- increments epoch, and expires stale proposals rather than replaying them.
CREATE TABLE IF NOT EXISTS tm_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pause_state TEXT NOT NULL DEFAULT 'RUNNING' CHECK (
    pause_state IN ('RUNNING', 'PAUSED', 'HARD_PAUSE')
  ),
  pause_scope TEXT,
  pause_reason TEXT,
  pause_actor TEXT,
  epoch BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO tm_control (id, pause_state, epoch)
VALUES (1, 'RUNNING', 0)
ON CONFLICT (id) DO NOTHING;

-- Provider health samples with expiry. The Taskmaster persists its own
-- samples here; the process-scoped darkEngines Map in engine-availability.ts
-- is deliberately NOT treated as durable truth.
CREATE TABLE IF NOT EXISTS tm_health (
  provider TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  sampled_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  evidence TEXT
);

-- Usage observations (sample-with-confidence shape per the M-133 ballot):
-- one row is one observation, not a running ledger. A failed meter is
-- recorded as is_unknown=1 -- never as zero-available-capacity.
CREATE TABLE IF NOT EXISTS tm_usage_sample (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  value_json TEXT,
  confidence TEXT,
  is_unknown INTEGER NOT NULL DEFAULT 0 CHECK (is_unknown IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_tm_usage_provider ON tm_usage_sample(provider, observed_at);
