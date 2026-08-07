CREATE TABLE IF NOT EXISTS tm_journal (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, thread_ref TEXT NOT NULL,
  action_type TEXT NOT NULL, proposal_json TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  before_hash TEXT, proof_predicate TEXT, proof_deadline_at TEXT,
  outcome TEXT NOT NULL, graded_at TEXT, grade TEXT
);
CREATE INDEX IF NOT EXISTS idx_tm_journal_thread_created ON tm_journal(thread_ref, created_at);

CREATE TABLE IF NOT EXISTS tm_control (
  id INTEGER PRIMARY KEY CHECK (id = 1), pause_state TEXT NOT NULL DEFAULT 'RUNNING',
  pause_scope TEXT, pause_reason TEXT, pause_actor TEXT, epoch INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO tm_control(id, pause_state, epoch, updated_at)
VALUES (1, 'RUNNING', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE IF NOT EXISTS tm_health (
  provider TEXT PRIMARY KEY, state TEXT NOT NULL, sampled_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, evidence TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tm_usage_sample (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, window_kind TEXT NOT NULL,
  source TEXT NOT NULL, observed_at TEXT NOT NULL, value_json TEXT NOT NULL,
  confidence TEXT NOT NULL, is_unknown INTEGER NOT NULL CHECK (is_unknown IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_tm_usage_observed ON tm_usage_sample(provider, observed_at);
