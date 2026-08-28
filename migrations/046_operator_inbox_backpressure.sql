-- WO-HARNESS-OPERATOR-INBOX-BACKPRESSURE-01: bound the operator-inbox drain and
-- give routine review receipts an audit home that is NOT the operator mailbox.
--
-- Two additive, nullable columns implement retirement + watermarking WITHOUT
-- touching the status vocabulary. A retired row keeps status='queued' forever;
-- `retired_at IS NOT NULL` is the terminal, non-draining marker. This is exactly
-- why retirement is distinct from 'cancelled' (Scope OUT forbids reusing that
-- status) and why every exhaustive switch on `status` keeps compiling unchanged.
--   inbox_watermark_at: the drain has processed this row once; do not re-read it
--                       (breaks the reprocessing loop that tripped GitHub
--                       secondary rate limiting on 2026-08-27).
--   retired_at:         the row aged past the retention window unaddressed; it is
--                       preserved and auditable but no longer drained.
ALTER TABLE agent_dispatch_messages ADD COLUMN IF NOT EXISTS inbox_watermark_at TIMESTAMPTZ;
ALTER TABLE agent_dispatch_messages ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

-- Supporting index for the bounded drain query: recipient + status + age, with
-- the exact predicate the drain uses (not watermarked, not retired, not
-- addressed). Keeps the oldest-first bounded read cheap even under a large
-- backlog instead of scanning the whole recipient partition every pass.
CREATE INDEX IF NOT EXISTS idx_agent_dispatch_messages_operator_backlog
  ON agent_dispatch_messages(recipient, status, created_at)
  WHERE addressed_at IS NULL AND inbox_watermark_at IS NULL AND retired_at IS NULL;

-- Audit home for routine review-route receipts. 'notify_only' matches the
-- 'overseer' / 'cauldron' pattern (a principal that is only ever written to, not
-- polled). The operator-inbox-consumer only drains recipient='operator', so rows
-- addressed to this principal are never drained and never make external API
-- calls -- they are pure audit records, queryable via listMessages.
INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
VALUES ('review-receipts-log', 'Review Receipts Log', 'notify_only', TRUE)
ON CONFLICT (principal_id) DO NOTHING;
