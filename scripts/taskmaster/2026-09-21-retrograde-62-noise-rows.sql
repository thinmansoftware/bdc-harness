-- Read-only falsifier for WO-HARNESS-TASKMASTER-UNHEARD-GRADE-01.
-- Repository migration 041 confirms tm_journal.idempotency_key exists and is
-- indexed. Verify the deployed columns with information_schema before running.
-- The 15-day bound reproduces the cohort sampled on 2026-09-21.
SELECT COUNT(*) AS acknowledged_by_non_draining_principal
FROM tm_journal AS journal
JOIN agent_dispatch_messages AS message
  ON message.idempotency_key = journal.idempotency_key
 AND message.sender_principal_id = 'system:taskmaster'
LEFT JOIN dispatch_principals AS principal
  ON principal.principal_id = LOWER(TRIM(COALESCE(message.resolved_recipient, message.recipient)))
WHERE journal.grade = 'noise'
  AND LOWER(TRIM(COALESCE(message.resolved_recipient, message.recipient))) = 'operator'
  AND journal.created_at >= TIMESTAMPTZ '2026-09-07T00:00:00Z'
  AND journal.created_at < TIMESTAMPTZ '2026-09-22T00:00:00Z'
  AND message.acknowledged_at IS NOT NULL
  AND principal.delivery_mode <> 'drain_on_start';
