-- WO-HARNESS-DISPATCH-ASTRA-MAILBOX-01: register the Astra Codex desktop
-- Board/XO seat as a drain_on_start mailbox principal (same pattern as xo
-- and operator). No worker ever claims astra's mail; the desktop
-- automation reads recipient='astra' AND acknowledged_at IS NULL directly
-- and acks/addresses it as 'astra'.
INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
VALUES
  ('astra', 'Astra (Codex desktop Board/XO seat)', 'drain_on_start', TRUE)
ON CONFLICT (principal_id) DO NOTHING;
