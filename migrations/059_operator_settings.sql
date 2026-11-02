CREATE TABLE IF NOT EXISTS operator_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
  updated_by TEXT NOT NULL,
  reason TEXT
);
