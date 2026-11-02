-- Dual-supervisor incident coordination with immutable observations and fenced repairs.

CREATE TABLE IF NOT EXISTS remote_agent_supervisor_incidents (
  incident_id UUID PRIMARY KEY,
  incident_key TEXT NOT NULL UNIQUE,
  run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  wo_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'repairing', 'recovered', 'escalated')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_agent_supervisor_observations (
  observation_id UUID PRIMARY KEY,
  incident_id UUID NOT NULL REFERENCES remote_agent_supervisor_incidents(incident_id) ON DELETE CASCADE,
  supervisor_id TEXT NOT NULL,
  assessment TEXT NOT NULL,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_agent_supervisor_repair_leases (
  incident_id UUID PRIMARY KEY REFERENCES remote_agent_supervisor_incidents(incident_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  acquired_at TIMESTAMP WITH TIME ZONE NOT NULL,
  last_heartbeat_at TIMESTAMP WITH TIME ZONE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  released_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS remote_agent_supervisor_actions (
  action_id UUID PRIMARY KEY,
  incident_id UUID NOT NULL REFERENCES remote_agent_supervisor_incidents(incident_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  action_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supervisor_observations_incident
  ON remote_agent_supervisor_observations(incident_id, created_at);
CREATE INDEX IF NOT EXISTS idx_supervisor_actions_incident
  ON remote_agent_supervisor_actions(incident_id, created_at);
CREATE INDEX IF NOT EXISTS idx_supervisor_repair_leases_expiry
  ON remote_agent_supervisor_repair_leases(expires_at) WHERE released_at IS NULL;
