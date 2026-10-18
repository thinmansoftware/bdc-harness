-- Durable Taskmaster-only automatic admission budget (bdc-xo#2002).
CREATE TABLE IF NOT EXISTS tm_fire_admissions (
  action_key TEXT PRIMARY KEY,
  journal_id UUID NOT NULL UNIQUE REFERENCES tm_journal(id),
  source TEXT NOT NULL DEFAULT 'taskmaster' CHECK (source = 'taskmaster'),
  source_thread_ref TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  cascade_id TEXT NOT NULL,
  utc_day TEXT NOT NULL CHECK (length(utc_day) = 10),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'admitted', 'released', 'unknown')),
  reserved_at TEXT NOT NULL,
  admitted_at TEXT,
  updated_at TEXT NOT NULL,
  run_ids_json TEXT NOT NULL DEFAULT '[]',
  CHECK (state <> 'admitted' OR admitted_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_tm_fire_admissions_day ON tm_fire_admissions(utc_day,state);
