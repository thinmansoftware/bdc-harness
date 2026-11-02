-- Overseer v2 judge-first verdict store (Motion M-99, WO-HARNESS-OVERSEER-V2-JUDGE-FIRST-01).
--
-- One PRIMARY verdict per (run_id, head_sha): the claim row is inserted BEFORE the
-- model is invoked so the 60s watch loop can never double-bill the same evidence,
-- and replay of already-judged evidence never re-acts (binding term 6).
--
-- status is the row lifecycle, NOT the semantic verdict:
--   claimed              -- claim won, model call in flight
--   verdict              -- structured semantic verdict stored (see verdict column)
--   judge_unavailable    -- ladder exhausted: transport/spawn failure (ALARM, retryable)
--   judge_invalid_output -- ladder exhausted: unparseable output (ALARM, retryable)
--   evidence_unavailable -- envelope could not be built or budget circuit open (ALARM, retryable)
-- Health states are operational alarms with bounded retry; they are NEVER a
-- semantic verdict (binding term 2).
--
-- verdict is the model's semantic reading, present only when status='verdict':
--   healthy | merge_candidate | failed_genuine | duplicate_work | needs_human | observe

CREATE TABLE IF NOT EXISTS overseer_verdicts (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  wo_id TEXT NOT NULL,
  -- '' when the run has no PR evidence yet; part of the idempotency key.
  head_sha TEXT NOT NULL DEFAULT '',
  evidence_digest TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'claimed',
  verdict TEXT,
  confidence REAL,
  model TEXT,
  model_rung INTEGER,
  proposed_action TEXT,
  proposed_tier INTEGER,
  required_tier INTEGER,
  effective_tier INTEGER,
  -- Classifier output demoted to hint fields (binding term: classifier-as-gate dies).
  hint_action TEXT,
  hint_error_class TEXT,
  reason TEXT,
  evidence TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_overseer_verdicts_run_head
  ON overseer_verdicts(run_id, head_sha);
CREATE INDEX IF NOT EXISTS idx_overseer_verdicts_status
  ON overseer_verdicts(status, created_at);
