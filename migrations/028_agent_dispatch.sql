-- Blue Devil Dispatch v1: durable agent-to-agent message drop-box.

CREATE TABLE IF NOT EXISTS agent_dispatch_messages (
  id UUID PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  task_type TEXT NOT NULL CHECK (task_type IN ('agent_message', 'run_review', 'draft_spec', 'run_report')),
  sender TEXT NOT NULL,
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
  fencing_token BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0)
);

CREATE INDEX IF NOT EXISTS idx_agent_dispatch_messages_recipient_status
  ON agent_dispatch_messages(recipient, status);

CREATE INDEX IF NOT EXISTS idx_agent_dispatch_messages_lease_expiry
  ON agent_dispatch_messages(lease_expires_at)
  WHERE status = 'claimed';

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
