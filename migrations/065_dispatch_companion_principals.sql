-- WO-HARNESS-COMPANION-MCP-MAILBOX-01: voice companion mailbox principals.
-- grokbot is the first enabled slot. dot, muse and duet are present but
-- inactive until a config change enables that companion. drain_on_start:
-- no worker ever claims this mail; the companion server reads its own inbox.
INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
VALUES
  ('grokbot', 'Grok Bot (voice companion)', 'drain_on_start', TRUE),
  ('dot', 'Dot (voice companion)', 'drain_on_start', FALSE),
  ('muse', 'Muse (voice companion)', 'drain_on_start', FALSE),
  ('duet', 'Duet (voice companion)', 'drain_on_start', FALSE)
ON CONFLICT (principal_id) DO NOTHING;
