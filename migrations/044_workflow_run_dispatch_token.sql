-- Deterministic cascade-to-run linkage (WO-HARNESS-CASCADE-RUN-DISCOVERY-DETERMINISTIC-01).
-- Additive only: adds a nullable dispatch_token column + lookup index to the
-- workflow runs table. A fired cascade persists its per-fire dispatch token here
-- so run discovery becomes a direct WHERE dispatch_token = <token> lookup instead
-- of a parent-conversation-id + timing scan, closing the co-fire race that
-- produced runId:null infra-alerts on 2026-08-18. No existing column is altered.
-- (SQLite path self-migrates in packages/core/src/db/adapters/sqlite.ts.)

ALTER TABLE remote_agent_workflow_runs ADD COLUMN IF NOT EXISTS dispatch_token TEXT;

CREATE INDEX IF NOT EXISTS idx_workflow_runs_dispatch_token
  ON remote_agent_workflow_runs(dispatch_token);
