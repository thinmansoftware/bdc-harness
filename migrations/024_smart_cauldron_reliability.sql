-- Smart Cauldron reliability kernel: additive persistence only.
-- Existing workflow rows and events remain unchanged during migration.

CREATE TABLE IF NOT EXISTS remote_agent_run_authorities (
  run_id UUID PRIMARY KEY REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL,
  wo_id TEXT NOT NULL,
  spec_source TEXT NOT NULL,
  spec_revision TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  codebase_id UUID NOT NULL,
  canonical_remote TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  run_scope_sha TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  workflow_revision TEXT NOT NULL,
  bundle_revision TEXT NOT NULL,
  engine_revision TEXT NOT NULL,
  runtime_image_revision TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_agent_run_leases (
  run_id UUID PRIMARY KEY REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  lease_token UUID NOT NULL UNIQUE,
  acquired_at TIMESTAMP WITH TIME ZONE NOT NULL,
  last_heartbeat_at TIMESTAMP WITH TIME ZONE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  released_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS remote_agent_provider_attempts (
  attempt_id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  declared_provider TEXT NOT NULL,
  declared_model TEXT NOT NULL,
  required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  served_model_id TEXT,
  outcome_class TEXT CHECK (
    outcome_class IS NULL OR outcome_class IN
      ('success', 'availability', 'quality', 'progress', 'quota', 'contradiction', 'cancelled')
  ),
  reason_code TEXT,
  resume_at TIMESTAMP WITH TIME ZONE,
  supersedes_attempt_id UUID REFERENCES remote_agent_provider_attempts(attempt_id),
  UNIQUE(run_id, node_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS remote_agent_run_outcomes (
  run_id UUID PRIMARY KEY REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  execution_state TEXT NOT NULL CHECK (
    execution_state IN
      ('queued', 'running', 'waiting_provider', 'paused_human', 'interrupted', 'completed', 'failed', 'cancelled')
  ),
  deliverable_state TEXT NOT NULL CHECK (
    deliverable_state IN ('none', 'worktree_changes', 'committed', 'pushed', 'pr_open', 'pr_ready')
  ),
  validation_state TEXT NOT NULL CHECK (
    validation_state IN ('not_run', 'passed', 'failed', 'indeterminate')
  ),
  recovery_state TEXT NOT NULL CHECK (
    recovery_state IN ('not_needed', 'recoverable', 'recovering', 'recovered', 'abandoned_by_operator')
  ),
  route_state TEXT NOT NULL CHECK (
    route_state IN ('current', 'failed_over', 'escalated', 'spec_repair', 'exhausted')
  ),
  primary_reason TEXT NOT NULL,
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_agent_scheduled_waits (
  wait_id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  attempt_id UUID NOT NULL REFERENCES remote_agent_provider_attempts(attempt_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  resume_at TIMESTAMP WITH TIME ZONE NOT NULL,
  state TEXT NOT NULL DEFAULT 'scheduled' CHECK (
    state IN ('scheduled', 'claimed', 'cancelled', 'completed')
  ),
  claim_owner_id TEXT,
  claim_token UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  claimed_at TIMESTAMP WITH TIME ZONE,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_reliability_active_leases
  ON remote_agent_run_leases(expires_at) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reliability_attempts_run_node
  ON remote_agent_provider_attempts(run_id, node_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_reliability_due_waits
  ON remote_agent_scheduled_waits(resume_at) WHERE state = 'scheduled';
CREATE UNIQUE INDEX IF NOT EXISTS unique_reliability_wait_attempt
  ON remote_agent_scheduled_waits(attempt_id);
