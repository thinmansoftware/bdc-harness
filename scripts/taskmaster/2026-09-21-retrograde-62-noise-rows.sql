-- Read-only falsifier for M-155 Amendment 03.
-- Among Taskmaster rows currently graded noise, report how many dispatches
-- were acknowledged by a recipient that does not auto-drain.
SELECT
  COUNT(*) AS noise_rows,
  COUNT(*) FILTER (
    WHERE adm.acknowledged_at IS NOT NULL
      AND dp.delivery_mode <> 'drain_on_start'
  ) AS acknowledged_by_non_draining_principal
FROM tm_journal AS tj
JOIN agent_dispatch_messages AS adm
  ON adm.idempotency_key = tj.idempotency_key
 AND adm.sender_principal_id = 'system:taskmaster'
JOIN dispatch_principals AS dp
  ON dp.principal_id = adm.recipient
WHERE tj.grade = 'noise'
  AND tj.created_at >= TIMESTAMPTZ '2026-09-07T00:00:00Z'
  AND adm.recipient = 'operator';
