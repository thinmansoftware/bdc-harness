-- WO-HARNESS-RUN-RECOVERY-DUAL-TRUTH-01 (M-26 dual-truth run recovery).
--
-- Attempt-scoped supervisor actions + reopen-capable incident status.
--
-- Migration 027 created uq_supervisor_action_incident, which allowed only ONE
-- action per incident and conflicts with M-26's multiple-attempt audit
-- requirement. This migration replaces that single-action rule with attempt
-- scoping: UNIQUE (incident_id, attempt_id, action_type). incident_id is already
-- bound to exactly one run_id, so this is the persisted equivalent of M-26's
-- run_id + attempt_id + action_type deduplication key.
--
-- Execution truth is NOT touched here: this only widens the audit surface for
-- fenced recovery attempts and adds the reopen-capable 'abandoned' incident
-- status.

-- 1. Drop the single-action-per-incident unique index (from migration 027).
DROP INDEX IF EXISTS uq_supervisor_action_incident;

-- 2. Add the immutable per-attempt identity, backfilled from action_id so every
--    historical row has a stable non-null attempt_id.
ALTER TABLE remote_agent_supervisor_actions
  ADD COLUMN IF NOT EXISTS attempt_id UUID;

UPDATE remote_agent_supervisor_actions
  SET attempt_id = action_id
  WHERE attempt_id IS NULL;

ALTER TABLE remote_agent_supervisor_actions
  ALTER COLUMN attempt_id SET NOT NULL;

-- 3. Structured completion evidence (nullable for reservations, non-complete
--    actions, and historical rows).
ALTER TABLE remote_agent_supervisor_actions
  ADD COLUMN IF NOT EXISTS pull_request_number INTEGER;
ALTER TABLE remote_agent_supervisor_actions
  ADD COLUMN IF NOT EXISTS recovered_head_sha TEXT;
ALTER TABLE remote_agent_supervisor_actions
  ADD COLUMN IF NOT EXISTS target_base TEXT;
ALTER TABLE remote_agent_supervisor_actions
  ADD COLUMN IF NOT EXISTS merge_sha TEXT;

-- 4. Attempt-scoped dedup index. Distinct action types under one attempt are
--    auditable; an identical tuple is a no-op; a conflicting immutable payload
--    under the same tuple is rejected by the reservation logic.
CREATE UNIQUE INDEX IF NOT EXISTS uq_supervisor_action_attempt
  ON remote_agent_supervisor_actions(incident_id, attempt_id, action_type);

-- 5. Reopen-capable incident status. Extend the CHECK to include 'abandoned'.
ALTER TABLE remote_agent_supervisor_incidents
  DROP CONSTRAINT IF EXISTS remote_agent_supervisor_incidents_status_check;
ALTER TABLE remote_agent_supervisor_incidents
  ADD CONSTRAINT remote_agent_supervisor_incidents_status_check
  CHECK (status IN ('open', 'repairing', 'recovered', 'escalated', 'abandoned'));
