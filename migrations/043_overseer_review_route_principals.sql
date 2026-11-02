-- WO-HARNESS-OVERSEER-REVIEW-ROUTE-01: register the two dispatch principals
-- the PR-event review route depends on. Review finding (Codex, 2026-08-19):
-- pr-review-wiring.ts enqueues to recipient 'overseer-reviewer' via
-- createMessage, which calls assessDispatchRecipientWithQuery and REJECTS any
-- recipient with no row in dispatch_principals (reason: 'missing_principal').
-- Without this migration every review enqueue fails on first use.
--
-- 'overseer-reviewer' is worker_poll: the governed reviewer (pr-review-submit.ts)
-- claims queued run_review work the same way any dispatch worker claims work.
-- 'overseer-review-route' is notify_only: it only ever SENDS (both review work
-- and receipts), matching the 'overseer' / 'cauldron' pattern above it.
INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
VALUES
  ('overseer-reviewer', 'Overseer PR Reviewer', 'worker_poll', TRUE),
  ('overseer-review-route', 'Overseer Review Route', 'notify_only', TRUE)
ON CONFLICT (principal_id) DO NOTHING;
