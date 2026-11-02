-- Reserve one supervisor repair action before any external mutation.

ALTER TABLE remote_agent_supervisor_actions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed'
  CHECK (status IN ('reserved', 'completed', 'failed'));

ALTER TABLE remote_agent_supervisor_actions
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supervisor_action_incident
  ON remote_agent_supervisor_actions(incident_id);
