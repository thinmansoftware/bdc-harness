-- Retroactive re-grade forensics (M-155 Amendment 03,
-- WO-HARNESS-TASKMASTER-UNHEARD-GRADE-01).
--
-- READ-ONLY. This script does NOT update tm_journal. It is the falsifier gate
-- for the resume decision after the 2026-09-17 useful-rate-floor auto-pause.
--
-- Question: of the tm_journal rows currently graded 'noise' (the ~62 operator
-- rows that tripped the floor), how many were EVER acknowledged by a
-- non-auto-draining principal -- i.e. how many would still be 'noise' (not
-- 'unheard') under the new grading rule?
--
-- An action counts as HEARD only when its dispatch row carries
-- acknowledged_at IS NOT NULL AND the recipient's delivery_mode != 'drain_on_start'.
-- Prediction: approximately ZERO. If confirmed, the 2026-09-17 pause was
-- measuring channel deafness (the M-129 Phase 2 gap), not supervisor
-- uselessness, and John can resume with that on the record.
--
-- Joins (verified against live source 2026-09-21):
--   * tm_journal.idempotency_key = agent_dispatch_messages.idempotency_key
--     (the same key defaultFindEffectByIdempotencyKey uses;
--      packages/core/src/db/dispatch.ts). tm_journal has no recipient column --
--      recipient/acknowledged_at live on agent_dispatch_messages.
--   * dispatch_principals.principal_id = canonicalized recipient, where
--     canonicalizePrincipal(x) = LOWER(TRIM(x)) applied to
--     COALESCE(resolved_recipient, recipient). delivery_mode lives in
--     dispatch_principals (packages/core/src/db/dispatch.ts getDispatchPrincipal).

-- Detail: every 'noise' row, with its recipient, ack timestamp, and delivery
-- mode. A row is "heard" (would remain gradeable, NOT unheard) only in the
-- last column.
SELECT
  tj.id AS journal_id,
  tj.thread_ref,
  tj.created_at,
  tj.action_type,
  adm.recipient,
  adm.resolved_recipient,
  adm.acknowledged_at,
  dp.delivery_mode,
  (
    adm.acknowledged_at IS NOT NULL
    AND dp.delivery_mode IS NOT NULL
    AND dp.delivery_mode <> 'drain_on_start'
  ) AS heard_by_non_draining_principal
FROM tm_journal tj
JOIN agent_dispatch_messages adm
  ON adm.idempotency_key = tj.idempotency_key
LEFT JOIN dispatch_principals dp
  ON dp.principal_id = LOWER(TRIM(COALESCE(adm.resolved_recipient, adm.recipient)))
WHERE tj.grade = 'noise'
ORDER BY tj.created_at DESC;

-- Summary: the falsifier. total_noise = rows graded 'noise';
-- would_stay_noise = rows genuinely heard by a non-draining principal;
-- would_become_unheard = the rest (the channel-deafness cohort). Prediction:
-- would_stay_noise ~= 0.
SELECT
  COUNT(*) AS total_noise,
  COUNT(*) FILTER (
    WHERE adm.acknowledged_at IS NOT NULL
      AND dp.delivery_mode IS NOT NULL
      AND dp.delivery_mode <> 'drain_on_start'
  ) AS would_stay_noise,
  COUNT(*) FILTER (
    WHERE NOT (
      adm.acknowledged_at IS NOT NULL
      AND dp.delivery_mode IS NOT NULL
      AND dp.delivery_mode <> 'drain_on_start'
    )
  ) AS would_become_unheard
FROM tm_journal tj
JOIN agent_dispatch_messages adm
  ON adm.idempotency_key = tj.idempotency_key
LEFT JOIN dispatch_principals dp
  ON dp.principal_id = LOWER(TRIM(COALESCE(adm.resolved_recipient, adm.recipient)))
WHERE tj.grade = 'noise';
