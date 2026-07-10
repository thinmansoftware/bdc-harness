-- Durable Smart Cauldron maintenance admission state and audit evidence.

CREATE TABLE IF NOT EXISTS remote_agent_cauldron_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('normal', 'draining')),
  updated_at TIMESTAMP WITH TIME ZONE,
  updated_by TEXT
);

INSERT INTO remote_agent_cauldron_control (id, mode)
VALUES (1, 'normal')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS remote_agent_cauldron_control_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_mode TEXT NOT NULL CHECK (from_mode IN ('normal', 'draining')),
  to_mode TEXT NOT NULL CHECK (to_mode IN ('normal', 'draining')),
  actor TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cauldron_control_events_created
  ON remote_agent_cauldron_control_events(created_at);
