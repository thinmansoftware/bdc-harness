-- Taskmaster adoption projection (WO-HARNESS-TASKMASTER-ADOPTION-PROJECTION-01, M-155 WO 1).
-- Additive only: creates tm_adoption + tm_adoption_meta. No existing table is altered.
-- GitHub remains the sole task system of record; these tables are a disposable projection.

-- suppressed_until_hash TEXT is RESERVED for
-- WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01 (M-155 WO 3) and is deliberately NOT
-- created here: WO 3 is not yet authored and additive discipline forbids
-- speculative columns. It lands as a nullable ALTER TABLE when WO 3 ships.

CREATE TABLE IF NOT EXISTS tm_adoption (
  thread_ref TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  title TEXT,
  priority TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  owner_login TEXT,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  next_action TEXT,
  latest_marker_kind TEXT CHECK (
    latest_marker_kind IS NULL OR latest_marker_kind IN ('PROGRESS', 'BLOCKED')
  ),
  latest_marker_at TEXT,
  state TEXT,
  last_movement_at TEXT,
  last_movement_kind TEXT CHECK (
    last_movement_kind IS NULL
    OR last_movement_kind IN ('closed', 'assigned', 'status_label', 'progress_comment')
  ),
  attempts_24h INTEGER NOT NULL DEFAULT 0,
  attempts_total INTEGER NOT NULL DEFAULT 0,
  evidence_observed_at TEXT,
  source_updated_at TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, thread_ref)
);

CREATE INDEX IF NOT EXISTS idx_tm_adoption_snapshot ON tm_adoption(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_tm_adoption_thread ON tm_adoption(thread_ref);

CREATE TABLE IF NOT EXISTS tm_adoption_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  committed_snapshot_id TEXT,
  rebuilt_at TEXT,
  row_count INTEGER,
  source_commit TEXT,
  complete INTEGER NOT NULL DEFAULT 0
);

INSERT INTO tm_adoption_meta (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
