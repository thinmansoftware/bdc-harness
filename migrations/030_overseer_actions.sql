CREATE TABLE IF NOT EXISTS overseer_actions (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  wo_id TEXT NOT NULL,
  class TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_overseer_actions_run_id
  ON overseer_actions(run_id);
