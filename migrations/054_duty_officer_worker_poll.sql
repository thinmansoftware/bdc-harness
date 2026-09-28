-- Duty Officer clock (WO-HARNESS-DO-HEADLESS-CLOCK-01 follow-up):
-- claimMessage only succeeds for worker_poll principals. Existing DBs may have
-- backfilled duty-officer/do as drain_on_start, which made the inbox drain a no-op.
INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
VALUES
  ('duty-officer', 'Duty Officer', 'worker_poll', TRUE),
  ('do', 'Duty Officer alias', 'worker_poll', TRUE)
ON CONFLICT (principal_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    delivery_mode = 'worker_poll',
    active = TRUE;
