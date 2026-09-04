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

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_authorities_dispatch_id
  ON remote_agent_run_authorities(dispatch_id);

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

-- From migration 025: durable Cauldron drain mode
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

-- From migration 026: dual-supervisor incident coordination
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
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('reserved', 'completed', 'failed')),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_supervisor_observations_incident
  ON remote_agent_supervisor_observations(incident_id, created_at);
CREATE INDEX IF NOT EXISTS idx_supervisor_actions_incident
  ON remote_agent_supervisor_actions(incident_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supervisor_action_incident
  ON remote_agent_supervisor_actions(incident_id);
CREATE INDEX IF NOT EXISTS idx_supervisor_repair_leases_expiry
  ON remote_agent_supervisor_repair_leases(expires_at) WHERE released_at IS NULL;

-- From migration 028 + 030: Blue Devil Dispatch v1 and board motion delivery.
CREATE TABLE IF NOT EXISTS agent_dispatch_messages (
  id UUID PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (
    task_type IN ('agent_message', 'run_review', 'draft_spec', 'run_report', 'board_motion')
  ),
  sender TEXT NOT NULL,
  sender_principal_id TEXT,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'cancelled')),
  result_body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  not_before TIMESTAMPTZ,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  fencing_token BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  recipient_alias TEXT CHECK (recipient_alias IS NULL OR recipient_alias = 'board'),
  motion_id TEXT,
  motion_revision_sha TEXT CHECK (motion_revision_sha IS NULL OR motion_revision_sha ~ '^[0-9a-f]{40}$'),
  resolved_recipient TEXT,
  resolved_xo_lease_id TEXT,
  resolved_xo_fencing_token BIGINT CHECK (resolved_xo_fencing_token IS NULL OR resolved_xo_fencing_token > 0),
  resolved_at TIMESTAMPTZ,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('blocker', 'normal', 'heartbeat')),
  task_outcome TEXT CHECK (task_outcome IS NULL OR task_outcome IN ('succeeded', 'failed', 'blocked')),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  addressed_at TIMESTAMPTZ,
  addressed_by TEXT,
  escalated_tg_at TIMESTAMPTZ,
  escalated_sms_at TIMESTAMPTZ,
  subject_key TEXT,
  repeat_reason TEXT,
  route_disposition TEXT CHECK (route_disposition IS NULL OR route_disposition IN ('unroutable', 'superseded')),
  supersedes_id UUID REFERENCES agent_dispatch_messages(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_dispatch_messages_recipient_status
  ON agent_dispatch_messages(recipient, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_dispatch_messages_sender_idempotency_authenticated
  ON agent_dispatch_messages (sender_principal_id, idempotency_key)
  WHERE sender_principal_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_dispatch_messages_idempotency_legacy
  ON agent_dispatch_messages (idempotency_key)
  WHERE sender_principal_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_dispatch_messages_lease_expiry
  ON agent_dispatch_messages(lease_expires_at)
  WHERE status = 'claimed';

CREATE INDEX IF NOT EXISTS idx_agent_dispatch_messages_subject_history
  ON agent_dispatch_messages(subject_key, created_at DESC, id DESC)
  WHERE subject_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dispatch_board_pending
  ON agent_dispatch_messages(recipient_alias, status, created_at);

CREATE TABLE IF NOT EXISTS dispatch_principals (
  principal_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  delivery_mode TEXT NOT NULL CHECK (
    delivery_mode IN ('worker_poll', 'drain_on_start', 'alias_resolved', 'notify_only')
  ),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
VALUES
  ('claude', 'Claude', 'worker_poll', TRUE),
  ('codex', 'Codex', 'worker_poll', TRUE),
  ('grok', 'Grok', 'worker_poll', TRUE),
  ('cursor', 'Cursor', 'worker_poll', TRUE),
  ('fusion', 'Fusion', 'worker_poll', TRUE),
  ('claude-acp', 'Claude ACP', 'worker_poll', TRUE),
  ('codex-mcp', 'Codex MCP', 'worker_poll', TRUE),
  ('grok-acp', 'Grok ACP', 'worker_poll', TRUE),
  ('operator', 'Operator', 'drain_on_start', TRUE),
  ('xo', 'XO', 'drain_on_start', TRUE),
  ('board', 'Board', 'alias_resolved', TRUE),
  ('overseer', 'Overseer', 'notify_only', TRUE),
  ('cauldron', 'Cauldron', 'notify_only', TRUE),
  ('john', 'John', 'notify_only', FALSE),
  ('merge-manager', 'Merge Manager', 'notify_only', FALSE),
  -- WO-HARNESS-OVERSEER-REVIEW-ROUTE-01 (migration 043): the PR-event review
  -- route's sender and worker-poll recipient. Without these rows every
  -- review enqueue is rejected as missing_principal.
  -- WO-HARNESS-OVERSEER-VERDICT-TO-TASKMASTER-REMEDIATION-01 (migration 046):
  -- recipient of Overseer's remediation candidates. worker_poll -- the
  -- Taskmaster loop claims its own work on its tick.
  ('taskmaster', 'Taskmaster', 'worker_poll', TRUE),
  ('overseer-reviewer', 'Overseer PR Reviewer', 'worker_poll', TRUE),
  ('overseer-review-route', 'Overseer Review Route', 'notify_only', TRUE)
ON CONFLICT (principal_id) DO NOTHING;

INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
SELECT DISTINCT
  LOWER(BTRIM(recipient)),
  LOWER(BTRIM(recipient)),
  'drain_on_start',
  TRUE
FROM agent_dispatch_messages
WHERE BTRIM(recipient) <> ''
ON CONFLICT (principal_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS agent_dispatch_workers (
  worker_id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency > 0),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'unavailable')),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_dispatch_workers_status_heartbeat
  ON agent_dispatch_workers(status, last_heartbeat_at);

-- From migration 029: board authority foundation
CREATE TABLE IF NOT EXISTS board_xo_leases (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_id UUID NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  seat_id TEXT NOT NULL CHECK (seat_id IN ('john', 'general', 'xo')),
  holder_id TEXT NOT NULL,
  holder_token_hash TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  acquired_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_board_xo_leases_active
  ON board_xo_leases(expires_at)
  WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS board_audit_events (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'xo_lease_acquired',
      'xo_lease_acquire_rejected',
      'xo_lease_renewed',
      'xo_lease_renew_rejected',
      'xo_lease_released',
      'xo_lease_release_rejected',
      'board_recipient_resolved',
      'board_recipient_deferred',
      'canonical_motion_frozen',
      'canonical_approval_accepted',
      'canonical_approval_rejected',
      'motion_notification_enqueued',
      'motion_notification_deduplicated',
      'board_alias_resolved',
      'board_petition_delivered',
      'execution_claim_authority_rejected',
      'manual_initiation_recorded'
    )
  ),
  actor_principal_id TEXT,
  actor_seat_id TEXT CHECK (actor_seat_id IS NULL OR actor_seat_id IN ('john', 'general', 'xo')),
  xo_lease_id UUID,
  xo_fencing_token BIGINT CHECK (xo_fencing_token IS NULL OR xo_fencing_token > 0),
  motion_id TEXT,
  motion_revision_sha TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_board_audit_events_created
  ON board_audit_events(created_at);

CREATE INDEX IF NOT EXISTS idx_board_audit_events_motion
  ON board_audit_events(motion_id, motion_revision_sha)
  WHERE motion_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_board_audit_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'board_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_board_audit_events_no_update ON board_audit_events;
CREATE TRIGGER trg_board_audit_events_no_update
  BEFORE UPDATE ON board_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_board_audit_event_mutation();

DROP TRIGGER IF EXISTS trg_board_audit_events_no_delete ON board_audit_events;
CREATE TRIGGER trg_board_audit_events_no_delete
  BEFORE DELETE ON board_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_board_audit_event_mutation();

-- Board execution claims (migration 032): exclusive fenced action ownership.
CREATE TABLE IF NOT EXISTS board_execution_claims (
  claim_id TEXT PRIMARY KEY,
  motion_id TEXT NOT NULL,
  action_kind TEXT NOT NULL CHECK (action_kind IN ('production_deploy', 'overseer_repair_refire')),
  environment TEXT NOT NULL CHECK (environment IN ('production', 'recovery')),
  target_sha TEXT NOT NULL CHECK (target_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  action_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  motion_file_path TEXT NOT NULL,
  motion_revision_sha TEXT NOT NULL CHECK (motion_revision_sha ~ '^[0-9a-f]{40}$'),
  claimant_principal TEXT NOT NULL,
  claimant_xo_holder_id TEXT NOT NULL,
  claimant_xo_lease_id TEXT NOT NULL,
  claimant_xo_fencing_token BIGINT NOT NULL CHECK (claimant_xo_fencing_token > 0),
  execution_fencing_token BIGINT NOT NULL CHECK (execution_fencing_token > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'completed')),
  reconciliation_status TEXT NOT NULL CHECK (
    reconciliation_status IN ('clear', 'required', 'resolved_retryable', 'resolved_completed')
  ),
  effect_attempt_id TEXT,
  effect_attempt_state TEXT NOT NULL CHECK (
    effect_attempt_state IN ('none', 'armed', 'completed', 'reconciled')
  ),
  effect_armed_at TIMESTAMPTZ,
  acquired_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  external_effect_reference TEXT,
  completion_evidence_json JSONB,
  reconciliation_evidence_json JSONB,
  CONSTRAINT board_execution_claims_action_identity_unique
    UNIQUE (motion_id, action_kind, environment, target_sha),
  CONSTRAINT board_execution_claims_status_reconciliation_pair CHECK (
    (status = 'active' AND reconciliation_status IN ('clear', 'required'))
    OR (status = 'released' AND reconciliation_status IN ('clear', 'resolved_retryable'))
    OR (status = 'completed' AND reconciliation_status IN ('clear', 'resolved_completed'))
  ),
  CONSTRAINT board_execution_claims_arm_iff_required CHECK (
    (reconciliation_status = 'required') = (effect_attempt_state = 'armed')
  ),
  CONSTRAINT board_execution_claims_armed_attempt_present CHECK (
    effect_attempt_state <> 'armed'
    OR (effect_attempt_id IS NOT NULL AND effect_armed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_board_execution_claims_active
  ON board_execution_claims(status, reconciliation_status, expires_at);

CREATE TABLE IF NOT EXISTS board_execution_claim_events (
  event_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES board_execution_claims(claim_id),
  event_sequence BIGINT NOT NULL CHECK (event_sequence > 0),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'claim_acquired',
      'claim_conflict',
      'claim_renewed',
      'claim_taken_over',
      'claim_released',
      'claim_stale_rejected',
      'claim_effect_armed',
      'claim_reconciliation_required',
      'claim_reconciled_retryable',
      'claim_reconciled_completed',
      'claim_completed'
    )
  ),
  actor_principal TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('xo', 'john', 'system')),
  xo_lease_id TEXT,
  xo_fencing_token BIGINT CHECK (xo_fencing_token IS NULL OR xo_fencing_token > 0),
  execution_fencing_token BIGINT CHECK (execution_fencing_token IS NULL OR execution_fencing_token > 0),
  details_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT board_execution_claim_events_sequence_unique UNIQUE (claim_id, event_sequence)
);

CREATE INDEX IF NOT EXISTS idx_board_execution_claim_events_claim
  ON board_execution_claim_events(claim_id, created_at);

CREATE OR REPLACE FUNCTION prevent_board_execution_claim_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'board_execution_claim_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_board_execution_claim_events_no_update ON board_execution_claim_events;
CREATE TRIGGER trg_board_execution_claim_events_no_update
  BEFORE UPDATE ON board_execution_claim_events
  FOR EACH ROW EXECUTE FUNCTION prevent_board_execution_claim_event_mutation();

DROP TRIGGER IF EXISTS trg_board_execution_claim_events_no_delete ON board_execution_claim_events;
CREATE TRIGGER trg_board_execution_claim_events_no_delete
  BEFORE DELETE ON board_execution_claim_events
  FOR EACH ROW EXECUTE FUNCTION prevent_board_execution_claim_event_mutation();

-- Overseer actions (migration 030)
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

-- overseer_reconcile_actions (migration 038)
CREATE TABLE IF NOT EXISTS overseer_reconcile_actions (
  id UUID PRIMARY KEY,
  pr_ref TEXT NOT NULL,
  wo_id TEXT NOT NULL,
  class TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_overseer_reconcile_actions_pr_ref
  ON overseer_reconcile_actions(pr_ref);
CREATE INDEX IF NOT EXISTS idx_overseer_reconcile_actions_action
  ON overseer_reconcile_actions(action);
