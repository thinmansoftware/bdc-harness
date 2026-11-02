-- WO-HARNESS-OVERSEER-VERDICT-TO-TASKMASTER-REMEDIATION-01: register the
-- 'taskmaster' dispatch principal.
--
-- Same defect class migration 043 fixed for the review route, found the same
-- way (a real-DB integration test, 2026-08-28): pr-review-wiring.ts now
-- enqueues remediation candidates to recipient 'taskmaster' via createMessage,
-- which calls assessDispatchRecipientWithQuery and REJECTS any recipient with
-- no row in dispatch_principals (reason: 'missing_principal'). Without this
-- row EVERY remediation hand-back fails on first use -- the review loop would
-- appear wired and silently deliver nothing.
--
-- 'taskmaster' is worker_poll: the Taskmaster loop reads its queued work from
-- agent_dispatch_messages on its own tick, exactly as any dispatch worker
-- claims work. It is NOT notify_only -- nothing pushes to it.
INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
VALUES
  ('taskmaster', 'Taskmaster', 'worker_poll', TRUE)
ON CONFLICT (principal_id) DO NOTHING;
