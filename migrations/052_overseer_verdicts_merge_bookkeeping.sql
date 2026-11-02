ALTER TABLE overseer_verdicts ADD COLUMN IF NOT EXISTS actioned_at TIMESTAMPTZ;
ALTER TABLE overseer_verdicts ADD COLUMN IF NOT EXISTS mutation_sent BOOLEAN;
ALTER TABLE overseer_verdicts ADD COLUMN IF NOT EXISTS action_reason TEXT;
ALTER TABLE overseer_verdicts ADD COLUMN IF NOT EXISTS merge_sha TEXT;
ALTER TABLE overseer_verdicts ADD COLUMN IF NOT EXISTS pr_url TEXT;

CREATE INDEX IF NOT EXISTS idx_overseer_verdicts_merge_action
  ON overseer_verdicts(created_at)
  WHERE proposed_action = 'flag_merge_ready' AND actioned_at IS NULL;
