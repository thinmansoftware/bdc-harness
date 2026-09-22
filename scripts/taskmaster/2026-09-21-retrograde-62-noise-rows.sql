-- Retroactive re-grade forensics (M-155 Amendment 03,
-- WO-HARNESS-TASKMASTER-UNHEARD-GRADE-01).
--
-- READ-ONLY. This script does NOT update tm_journal. It is the falsifier gate
-- for the resume decision after the 2026-09-17 useful-rate-floor auto-pause.
--
-- Question: of the tm_journal rows that actually fed the floor denominator when
-- it tripped (the ~62 rows graded 'noise' in that evaluation window), how many
-- were EVER acknowledged by a non-auto-draining principal -- i.e. how many
-- would still be 'noise' (not 'unheard') under the new grading rule?
--
-- An action counts as HEARD only when its dispatch row carries
-- acknowledged_at IS NOT NULL AND the recipient's delivery_mode != 'drain_on_start'.
-- Prediction: approximately ZERO. If confirmed, the 2026-09-17 pause was
-- measuring channel deafness (the M-129 Phase 2 gap), not supervisor
-- uselessness, and John can resume with that on the record.
--
-- ---------------------------------------------------------------------------
-- COHORT BOUNDS -- the 62-row cohort, not all history.
-- ---------------------------------------------------------------------------
-- The floor is evaluated over an EPOCH-BOUNDED LOOKBACK, not over all time
-- (packages/server/src/taskmaster/loop.ts, useful-rate floor block):
--
--   lookbackStartMs = pauseInstant - JOURNAL_LOOKBACK_MS   (7 days)
--   epochStartMs    = tm_control.updated_at                (current epoch start)
--   floorStartMs    = MAX(lookbackStartMs, epochStartMs)
--   cohort          = tm_journal rows WHERE created_at >= floorStartMs
--                     AND grade IN ('useful','noise')      ('unheard' excluded)
--
-- So the cohort predicate below is: grade = 'noise' AND created_at inside
-- [COHORT_START, COHORT_END). Without it this script answers a DIFFERENT
-- question (all noise rows ever recorded) than the resume decision needs.
--
-- COHORT_START = '2026-09-10T00:00:00.000Z'  -- 7 days before the 2026-09-17 pause
-- COHORT_END   = '2026-09-18T00:00:00.000Z'  -- exclusive; covers all of 2026-09-17
--
-- BEFORE RECORDING THE RESULT, the operator must confirm these two bounds:
--   1. COHORT_START must be raised to tm_control.updated_at if the epoch began
--      AFTER 2026-09-10 (floorStartMs takes the LATER of the two). Check with:
--        SELECT epoch, updated_at, pause_state, pause_actor FROM tm_control;
--      An epoch that has since been incremented by a resume will NOT show the
--      value in force on 2026-09-17 -- in that case use the pause notice /
--      taskmaster.useful_rate_floor_auto_paused log line for the real bound.
--   2. Query 1 (cohort size) must return ~62. If it does not, the bounds are
--      wrong and the answer below is not the falsifier -- fix the bounds first.
--
-- NOTE ON SCOPE: this script deliberately does NOT filter on
-- recipient = 'operator'. 'operator' (and 'xo') ARE drain_on_start, so
-- restricting the cohort to them would make the heard test false by
-- construction and the falsifier circular -- it would prove nothing. The
-- cohort is defined by the floor window; "operator rows" is the EXPECTED
-- FINDING, and query 2 reports the recipient split as evidence for it.
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
--
-- Timestamp literals use the exact '...T..:..:..000Z' shape produced by
-- Date.toISOString() so the comparison is correct both in Postgres (parsed as
-- timestamptz) and in SQLite (lexicographic TEXT compare).

-- ---------------------------------------------------------------------------
-- Query 1: COHORT SIZE GUARD. Must return ~62. Run this FIRST -- if it does
-- not, the bounds above are wrong and nothing below is the falsifier.
-- in_cohort is the number under test; before_cohort/after_cohort show how many
-- noise rows the window deliberately excludes (they did not feed the breach).
-- ---------------------------------------------------------------------------
SELECT
  COUNT(*) FILTER (
    WHERE tj.created_at >= '2026-09-10T00:00:00.000Z'
      AND tj.created_at < '2026-09-18T00:00:00.000Z'
  ) AS in_cohort,
  COUNT(*) FILTER (WHERE tj.created_at < '2026-09-10T00:00:00.000Z') AS before_cohort,
  COUNT(*) FILTER (WHERE tj.created_at >= '2026-09-18T00:00:00.000Z') AS after_cohort,
  COUNT(*) AS all_noise_ever
FROM tm_journal tj
WHERE tj.grade = 'noise'
  AND tj.outcome = 'sent';

-- ---------------------------------------------------------------------------
-- Query 2: THE FALSIFIER. total_noise = cohort rows graded 'noise';
-- would_stay_noise = rows genuinely heard by a non-draining principal;
-- would_become_unheard = the rest (the channel-deafness cohort). Prediction:
-- would_stay_noise ~= 0.
--
-- LEFT JOIN to agent_dispatch_messages keeps cohort rows with no dispatch row
-- in total_noise (absence of a dispatch = never delivered = unheard). The heard
-- predicate is wrapped in COALESCE(..., FALSE) so both the LEFT JOIN miss on
-- dispatch_principals (NULL delivery_mode) and the missing dispatch row (NULL
-- acknowledged_at) collapse to FALSE. That guarantees
-- would_stay_noise + would_become_unheard = total_noise for every row (NOT of a
-- NULL would otherwise be NULL and land in NEITHER bucket).
--
-- drain_recipients / non_drain_recipients evidence the "operator cohort"
-- characterization instead of assuming it.
-- ---------------------------------------------------------------------------
SELECT
  COUNT(*) AS total_noise,
  COUNT(*) FILTER (
    WHERE COALESCE(
      adm.acknowledged_at IS NOT NULL
      AND dp.delivery_mode IS NOT NULL
      AND dp.delivery_mode <> 'drain_on_start',
      FALSE
    )
  ) AS would_stay_noise,
  COUNT(*) FILTER (
    WHERE NOT COALESCE(
      adm.acknowledged_at IS NOT NULL
      AND dp.delivery_mode IS NOT NULL
      AND dp.delivery_mode <> 'drain_on_start',
      FALSE
    )
  ) AS would_become_unheard,
  COUNT(*) FILTER (WHERE dp.delivery_mode = 'drain_on_start') AS drain_recipients,
  COUNT(*) FILTER (
    WHERE dp.delivery_mode IS NOT NULL AND dp.delivery_mode <> 'drain_on_start'
  ) AS non_drain_recipients,
  COUNT(*) FILTER (WHERE adm.id IS NULL) AS no_dispatch_row,
  COUNT(*) FILTER (WHERE adm.acknowledged_at IS NULL) AS never_acknowledged
FROM tm_journal tj
LEFT JOIN agent_dispatch_messages adm
  ON adm.idempotency_key = tj.idempotency_key
LEFT JOIN dispatch_principals dp
  ON dp.principal_id = LOWER(TRIM(COALESCE(adm.resolved_recipient, adm.recipient)))
WHERE tj.grade = 'noise'
  AND tj.outcome = 'sent'
  AND tj.created_at >= '2026-09-10T00:00:00.000Z'
  AND tj.created_at < '2026-09-18T00:00:00.000Z';

-- ---------------------------------------------------------------------------
-- Query 3: DETAIL -- every cohort row, with its recipient, ack timestamp, and
-- delivery mode. A row is "heard" (would remain gradeable, NOT unheard) only
-- when the last column is TRUE. Same cohort bounds and same COALESCE'd heard
-- predicate as query 2, so the rows here sum exactly to query 2's buckets.
-- ---------------------------------------------------------------------------
SELECT
  tj.id AS journal_id,
  tj.thread_ref,
  tj.created_at,
  tj.action_type,
  adm.recipient,
  adm.resolved_recipient,
  adm.acknowledged_at,
  dp.delivery_mode,
  COALESCE(
    adm.acknowledged_at IS NOT NULL
    AND dp.delivery_mode IS NOT NULL
    AND dp.delivery_mode <> 'drain_on_start',
    FALSE
  ) AS heard_by_non_draining_principal
FROM tm_journal tj
LEFT JOIN agent_dispatch_messages adm
  ON adm.idempotency_key = tj.idempotency_key
LEFT JOIN dispatch_principals dp
  ON dp.principal_id = LOWER(TRIM(COALESCE(adm.resolved_recipient, adm.recipient)))
WHERE tj.grade = 'noise'
  AND tj.outcome = 'sent'
  AND tj.created_at >= '2026-09-10T00:00:00.000Z'
  AND tj.created_at < '2026-09-18T00:00:00.000Z'
ORDER BY tj.created_at DESC;
