-- Harness-side mailbox registration only; no relay or runtime action.
INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
VALUES
  ('t3-desk-local', 'PC T3 relay queue', 'worker_poll', TRUE)
ON CONFLICT (principal_id) DO NOTHING;
