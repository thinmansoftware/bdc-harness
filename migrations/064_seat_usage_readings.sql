CREATE TABLE IF NOT EXISTS seat_usage_readings (
  seat TEXT PRIMARY KEY,
  used_percent REAL NOT NULL,
  remaining_percent REAL NOT NULL,
  resets_at TIMESTAMP WITH TIME ZONE NOT NULL,
  observed_at TIMESTAMP WITH TIME ZONE NOT NULL,
  source TEXT NOT NULL,
  received_at TIMESTAMP WITH TIME ZONE NOT NULL
);
