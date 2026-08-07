-- Phase 1 durable repeat disclosure and exact subject history.
ALTER TABLE agent_dispatch_messages ADD COLUMN IF NOT EXISTS repeat_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_dispatch_messages_subject_history
  ON agent_dispatch_messages (subject_key, created_at DESC, id DESC)
  WHERE subject_key IS NOT NULL;
