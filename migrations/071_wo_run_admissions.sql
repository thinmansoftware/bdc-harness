CREATE TABLE IF NOT EXISTS wo_run_admissions (
  wo_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  expires_at_epoch BIGINT NOT NULL
);
