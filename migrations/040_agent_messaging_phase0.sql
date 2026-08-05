-- Agent messaging Phase 0: mailbox semantics and principal delivery registry.

ALTER TABLE agent_dispatch_messages
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('blocker', 'normal', 'heartbeat')),
  ADD COLUMN IF NOT EXISTS task_outcome TEXT
    CHECK (task_outcome IS NULL OR task_outcome IN ('succeeded', 'failed', 'blocked')),
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_by TEXT,
  ADD COLUMN IF NOT EXISTS addressed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS addressed_by TEXT,
  ADD COLUMN IF NOT EXISTS escalated_tg_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escalated_sms_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subject_key TEXT,
  ADD COLUMN IF NOT EXISTS route_disposition TEXT
    CHECK (route_disposition IS NULL OR route_disposition IN ('unroutable', 'superseded')),
  ADD COLUMN IF NOT EXISTS supersedes_id UUID REFERENCES agent_dispatch_messages(id);

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
  ('merge-manager', 'Merge Manager', 'notify_only', FALSE)
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

UPDATE agent_dispatch_messages
SET priority = 'heartbeat'
WHERE status = 'queued'
  AND task_type = 'run_report';
