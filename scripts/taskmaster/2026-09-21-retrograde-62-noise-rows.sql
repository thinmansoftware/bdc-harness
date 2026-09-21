-- WO-HARNESS-TASKMASTER-UNHEARD-GRADE-01, Deliverable 2 (READ-ONLY forensics).
--
-- M-155 Amendment 03 falsifier gate. Question: of the tm_journal rows graded
-- `noise` in the last 14d for recipient = 'operator', how many were EVER
-- acknowledged by a non-`drain_on_start` principal (i.e. actually heard by a
-- human-facing party)?
--
-- Prediction: approximately ZERO. If confirmed, the 2026-09-17 useful-rate
-- floor pause was measuring channel deafness (the operator mailbox drains on
-- start, so mail there is auto-addressed before a human reads it -- the M-129
-- Phase 2 gap), NOT supervisor uselessness. Those `noise` grades would be
-- `unheard` under this WO and excluded from the floor denominator.
--
-- This file is READ-ONLY. It contains NO UPDATE/INSERT/DELETE against
-- tm_journal or any table (anti-guess declaration #2). Do NOT retroactively
-- rewrite the grades; this only informs John's resume decision.
--
-- Join model:
--   tm_journal.idempotency_key = agent_dispatch_messages.idempotency_key
--   agent_dispatch_messages.acknowledged_by -> dispatch_principals.principal_id
--     (principals are canonicalized LOWER(BTRIM(...)); delivery_mode lives here)
-- "Heard" = acknowledged_at IS NOT NULL AND the acking principal's
--   delivery_mode <> 'drain_on_start'.

-- Query 1: per-row detail over the 62 `noise` operator rows.
SELECT
  j.id                        AS journal_id,
  j.action_type,
  j.grade,
  j.created_at                AS graded_row_created_at,
  adm.recipient,
  adm.resolved_recipient,
  adm.acknowledged_at,
  adm.acknowledged_by,
  p.delivery_mode             AS acking_principal_delivery_mode,
  (
    adm.acknowledged_at IS NOT NULL
    AND p.delivery_mode IS NOT NULL
    AND p.delivery_mode <> 'drain_on_start'
  )                           AS acked_by_non_draining
FROM tm_journal j
JOIN agent_dispatch_messages adm
  ON adm.idempotency_key = j.idempotency_key
LEFT JOIN dispatch_principals p
  ON p.principal_id = LOWER(BTRIM(adm.acknowledged_by))
WHERE j.grade = 'noise'
  AND j.created_at >= NOW() - INTERVAL '14 days'
  AND LOWER(BTRIM(COALESCE(adm.resolved_recipient, adm.recipient))) = 'operator'
ORDER BY j.created_at DESC;

-- Query 2: the falsifier summary. Expected acked_by_non_draining_count ~ 0.
SELECT
  COUNT(*) AS noise_operator_rows_14d,
  COUNT(*) FILTER (
    WHERE adm.acknowledged_at IS NOT NULL
      AND p.delivery_mode IS NOT NULL
      AND p.delivery_mode <> 'drain_on_start'
  ) AS acked_by_non_draining_count
FROM tm_journal j
JOIN agent_dispatch_messages adm
  ON adm.idempotency_key = j.idempotency_key
LEFT JOIN dispatch_principals p
  ON p.principal_id = LOWER(BTRIM(adm.acknowledged_by))
WHERE j.grade = 'noise'
  AND j.created_at >= NOW() - INTERVAL '14 days'
  AND LOWER(BTRIM(COALESCE(adm.resolved_recipient, adm.recipient))) = 'operator';
