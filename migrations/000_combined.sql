-- Remote Coding Agent - Combined Schema
-- Version: Combined (final state after migrations 001-020)
-- Description: Complete database schema (idempotent - safe to run multiple times)
--
-- 8 Tables:
--   1. remote_agent_codebases
--   1b. remote_agent_codebase_env_vars
--   2. remote_agent_conversations
--   3. remote_agent_sessions
--   4. remote_agent_isolation_environments
--   5. remote_agent_workflow_runs
--   6. remote_agent_workflow_events
--   7. remote_agent_messages
--
-- Dropped tables (via migrations):
--   - remote_agent_command_templates (017)
--
-- Dropped columns (via migrations):
--   - conversations.worktree_path (007)
--   - conversations.isolation_env_id_legacy (007)
--   - conversations.isolation_provider (007)

-- ============================================================================
-- Table 1: Codebases
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_codebases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  repository_url VARCHAR(500),
  default_cwd VARCHAR(500) NOT NULL,
  ai_assistant_type VARCHAR(20) DEFAULT 'claude',
  allow_env_keys BOOLEAN NOT NULL DEFAULT FALSE,
  commands JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE remote_agent_codebases IS
  'Repository metadata: name, URL, working directory, AI assistant type, and command paths (JSONB)';

-- ============================================================================
-- Table 1b: Codebase Env Vars
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_codebase_env_vars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(codebase_id, key)
);

CREATE INDEX IF NOT EXISTS idx_codebase_env_vars_codebase_id
  ON remote_agent_codebase_env_vars(codebase_id);

COMMENT ON TABLE remote_agent_codebase_env_vars IS
  'Per-project env vars merged into Options.env on Claude SDK calls. Managed via Web UI or config.';

-- ============================================================================
-- Table 2: Conversations
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_type VARCHAR(20) NOT NULL,
  platform_conversation_id VARCHAR(255) NOT NULL,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  cwd VARCHAR(500),
  ai_assistant_type VARCHAR(20) DEFAULT 'claude',
  isolation_env_id UUID,  -- FK added after isolation_environments table exists
  title VARCHAR(255),
  deleted_at TIMESTAMP WITH TIME ZONE,
  hidden BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(platform_type, platform_conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_remote_agent_conversations_codebase
  ON remote_agent_conversations(codebase_id);
CREATE INDEX IF NOT EXISTS idx_conversations_hidden
  ON remote_agent_conversations(hidden);
CREATE INDEX IF NOT EXISTS idx_conversations_codebase
  ON remote_agent_conversations(codebase_id) WHERE deleted_at IS NULL;

COMMENT ON COLUMN remote_agent_conversations.isolation_env_id IS
  'UUID reference to isolation_environments table (the only isolation reference)';

-- ============================================================================
-- Table 3: Sessions
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  ai_assistant_type VARCHAR(20) NOT NULL,
  assistant_session_id VARCHAR(255),
  active BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}'::jsonb,
  parent_session_id UUID REFERENCES remote_agent_sessions(id),
  transition_reason TEXT,
  ended_reason TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_remote_agent_sessions_conversation
  ON remote_agent_sessions(conversation_id, active);
CREATE INDEX IF NOT EXISTS idx_remote_agent_sessions_codebase
  ON remote_agent_sessions(codebase_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent
  ON remote_agent_sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_conversation_started
  ON remote_agent_sessions(conversation_id, started_at DESC);

COMMENT ON COLUMN remote_agent_sessions.parent_session_id IS
  'Links to the previous session in this conversation (for audit trail)';
COMMENT ON COLUMN remote_agent_sessions.transition_reason IS
  'Why this session was created: plan-to-execute, isolation-changed, reset-requested, etc.';
COMMENT ON COLUMN remote_agent_sessions.ended_reason IS
  'Why this session was deactivated: reset-requested, cwd-changed, conversation-closed, etc.';

-- ============================================================================
-- Table 4: Isolation Environments
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_isolation_environments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id           UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,

  -- Workflow identification (what work this is for)
  workflow_type         TEXT NOT NULL,        -- 'issue', 'pr', 'review', 'thread', 'task'
  workflow_id           TEXT NOT NULL,        -- '42', 'pr-99', 'thread-abc123'

  -- Implementation details
  provider              TEXT NOT NULL DEFAULT 'worktree',
  working_path          TEXT NOT NULL,        -- Actual filesystem path
  branch_name           TEXT NOT NULL,        -- Git branch name

  -- Lifecycle
  status                TEXT NOT NULL DEFAULT 'active',  -- 'active', 'destroyed'
  created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by_platform   TEXT,                 -- 'github', 'slack', etc.

  -- Cross-reference metadata (for linking)
  metadata              JSONB DEFAULT '{}'
);

-- Partial unique index: only active environments need uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
  ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
  WHERE status = 'active';

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_isolation_env_codebase
  ON remote_agent_isolation_environments(codebase_id);
CREATE INDEX IF NOT EXISTS idx_isolation_env_status
  ON remote_agent_isolation_environments(status);
CREATE INDEX IF NOT EXISTS idx_isolation_env_workflow
  ON remote_agent_isolation_environments(workflow_type, workflow_id);

-- Add FK from conversations to isolation_environments (deferred to avoid circular dependency)
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS isolation_env_id UUID
    REFERENCES remote_agent_isolation_environments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_isolation_env_id
  ON remote_agent_conversations(isolation_env_id);

COMMENT ON TABLE remote_agent_isolation_environments IS
  'Work-centric isolated environments with independent lifecycle';
COMMENT ON COLUMN remote_agent_isolation_environments.workflow_type IS
  'Type of work: issue, pr, review, thread, task';
COMMENT ON COLUMN remote_agent_isolation_environments.workflow_id IS
  'Identifier for the work (issue number, PR number, thread hash, etc.)';

-- ============================================================================
-- Table 5: Workflow Runs
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name VARCHAR(255) NOT NULL,
  conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  current_step_index INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed
  user_message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  parent_conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE SET NULL,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  working_path TEXT,
  archived_at TIMESTAMP WITH TIME ZONE,
  archived_by TEXT,
  archive_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation
  ON remote_agent_workflow_runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
  ON remote_agent_workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent_conv
  ON remote_agent_workflow_runs(parent_conversation_id);

-- Partial index for efficient staleness queries on running workflows
CREATE INDEX IF NOT EXISTS idx_workflow_runs_last_activity
  ON remote_agent_workflow_runs(last_activity_at)
  WHERE status = 'running';

COMMENT ON TABLE remote_agent_workflow_runs IS
  'Tracks workflow execution state for resumption and observability';

-- ============================================================================
-- Table 6: Workflow Events
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  step_index INTEGER,
  step_name VARCHAR(255),
  data JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_run_id
  ON remote_agent_workflow_events(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_events_type
  ON remote_agent_workflow_events(event_type);

COMMENT ON TABLE remote_agent_workflow_events IS
  'Lean UI-relevant workflow events for observability (step transitions, artifacts, errors)';

-- ============================================================================
-- Table 7: Messages
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
  ON remote_agent_messages(conversation_id, created_at ASC);

-- ============================================================================
-- Cleanup: Drop legacy objects from older schemas
-- ============================================================================

-- Drop command_templates table (replaced by file-based commands in .archon/commands)
DROP TABLE IF EXISTS remote_agent_command_templates;
DROP INDEX IF EXISTS idx_remote_agent_command_templates_name;

-- Drop legacy columns from conversations (if upgrading from older schema)
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS worktree_path;
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS isolation_env_id_legacy;
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS isolation_provider;
DROP INDEX IF EXISTS idx_conversations_isolation;

-- Drop legacy constraint from isolation_environments (if upgrading from older schema)
ALTER TABLE remote_agent_isolation_environments
  DROP CONSTRAINT IF EXISTS unique_workflow;

-- ============================================================================
-- Idempotent ALTER statements for upgrading existing databases
-- (These are no-ops on fresh installs since columns exist in CREATE TABLE above)
-- ============================================================================

-- From migration 006: isolation_env_id + last_activity_at on conversations
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS isolation_env_id UUID
    REFERENCES remote_agent_isolation_environments(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- From migration 009: last_activity_at on workflow_runs
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- From migration 010: parent_session_id + transition_reason on sessions
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS parent_session_id UUID REFERENCES remote_agent_sessions(id);
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS transition_reason TEXT;

-- From migration 013: title + deleted_at on conversations
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS title VARCHAR(255);
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- From migration 015: parent_conversation_id + hidden
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS parent_conversation_id UUID
    REFERENCES remote_agent_conversations(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT FALSE;

-- From migration 016: ended_reason on sessions
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS ended_reason TEXT;

-- From migration 021: allow_env_keys on codebases
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS allow_env_keys BOOLEAN NOT NULL DEFAULT FALSE;

-- From migration 022: archive fields on workflow_runs
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS archived_by TEXT;
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS archive_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_workflow_runs_archived
  ON remote_agent_workflow_runs(archived_at)
  WHERE archived_at IS NOT NULL;

-- From migration 024: Smart Cauldron reliability kernel
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
