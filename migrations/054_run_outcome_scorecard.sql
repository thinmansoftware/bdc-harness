-- Migration 054: honest run-outcome scorecard columns
-- (WO-HARNESS-RUN-OUTCOME-SCORECARD-01).
--
-- Adds a durable per-run score to the EXISTING remote_agent_run_outcomes row.
-- No second outcomes table. No writes to remote_agent_workflow_events or
-- remote_agent_workflow_runs.status. The scorer (packages/core/src/run-scorecard.ts)
-- derives these from a run's events; DO NOT treat runs.status='completed' as
-- success. All columns are nullable so pre-scorecard rows stay valid until scored.
--
-- SQLITE MIRROR: packages/core/src/db/adapters/sqlite.ts createSchema() +
-- migrateColumns() (remote_agent_run_outcomes scorecard additions).
BEGIN;

ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS score_version TEXT;
ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS scored_at TEXT;
ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS status_column TEXT;
ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS terminal_event TEXT;
ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS landing_ok INTEGER
  CHECK (landing_ok IN (0, 1));
ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS landing_skipped INTEGER
  CHECK (landing_skipped IN (0, 1));
ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS last_failed_step TEXT;
ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS pipeline_axis TEXT;
ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS module_axis TEXT;
ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS honest_success INTEGER
  CHECK (honest_success IN (0, 1));
ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS score_partial INTEGER
  CHECK (score_partial IN (0, 1));
ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS gh_pr_url TEXT;
ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS gh_join_complete INTEGER
  CHECK (gh_join_complete IN (0, 1));
ALTER TABLE remote_agent_run_outcomes ADD COLUMN IF NOT EXISTS wo_id TEXT;

COMMIT;
