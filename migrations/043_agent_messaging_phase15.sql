-- Phase 1.5 sender authentication: nullable sender principal and sender-scoped idempotency.
BEGIN;

ALTER TABLE agent_dispatch_messages
  ADD COLUMN IF NOT EXISTS sender_principal_id TEXT;

ALTER TABLE agent_dispatch_messages
  DROP CONSTRAINT IF EXISTS agent_dispatch_messages_idempotency_key_key;

DROP INDEX IF EXISTS agent_dispatch_messages_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_dispatch_messages_sender_idempotency_authenticated
  ON agent_dispatch_messages (sender_principal_id, idempotency_key)
  WHERE sender_principal_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_dispatch_messages_idempotency_legacy
  ON agent_dispatch_messages (idempotency_key)
  WHERE sender_principal_id IS NULL;

COMMIT;
