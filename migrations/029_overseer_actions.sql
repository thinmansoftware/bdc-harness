-- Durable overseer action ledger for merge-ready, salvage, rate-limit, and refire decisions.

CREATE TABLE IF NOT EXISTS overseer_actions (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('merge_ready', 'salvage', 'rate_limit', 'refire')),
  status TEXT NOT NULL CHECK (status IN ('planned', 'reserved', 'completed', 'failed', 'blocked')),
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  fencing_token BIGINT CHECK (fencing_token IS NULL OR fencing_token > 0),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_overseer_actions_run_created
  ON overseer_actions(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_overseer_actions_kind_status
  ON overseer_actions(kind, status);
