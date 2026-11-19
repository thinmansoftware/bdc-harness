-- WO-HARNESS-DISPATCH-ROUTING-CUTOFF-01: two new mailbox principals.
-- t3-desktop: real run reports and owner cards (drained by the desktop
-- bridge, a separate WO). pr-review-log: PR-review receipts; nothing ever
-- drains it, it is a log the reviewer reads back for re-review authorization.
INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
VALUES
  ('t3-desktop', 'T3 desktop results queue', 'drain_on_start', TRUE),
  ('pr-review-log', 'PR review receipt log', 'drain_on_start', TRUE)
ON CONFLICT (principal_id) DO NOTHING;
