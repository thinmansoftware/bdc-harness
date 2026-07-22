-- overseer_reconcile_actions: reconcile duty (V1B) actions are not scoped to any
-- remote_agent_workflow_runs row (they fire off a merged PR, not a run), so they
-- cannot honor overseer_actions.run_id's NOT NULL FK. Separate append-only log,
-- keyed on the PR itself. WO-HARNESS-OVERSEER-RECONCILE-FK-FIX-01.
CREATE TABLE IF NOT EXISTS overseer_reconcile_actions (
  id UUID PRIMARY KEY,
  pr_ref TEXT NOT NULL,
  wo_id TEXT NOT NULL,
  class TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_overseer_reconcile_actions_pr_ref
  ON overseer_reconcile_actions(pr_ref);
CREATE INDEX IF NOT EXISTS idx_overseer_reconcile_actions_action
  ON overseer_reconcile_actions(action);
