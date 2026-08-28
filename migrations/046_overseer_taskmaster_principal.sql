-- WO-HARNESS-OVERSEER-VERDICT-TO-TASKMASTER-REMEDIATION-01: register the
-- Taskmaster mailbox used by remediation proposals. The consumer remains
-- deferred while packages/server/src/taskmaster is frozen pending PR #669.
INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
VALUES ('taskmaster', 'Taskmaster', 'drain_on_start', TRUE)
ON CONFLICT (principal_id) DO NOTHING;
