-- WO-HARNESS-OVERSEER-REWORK-LOOP-01: worker-poll recipient for run_rework.
-- Same shape as 056_dispatch_astra_mailbox.sql.
INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
VALUES
  ('overseer-rework', 'Overseer Rework Dispatcher', 'worker_poll', TRUE)
ON CONFLICT (principal_id) DO NOTHING;
