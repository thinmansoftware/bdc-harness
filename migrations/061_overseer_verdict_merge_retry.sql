ALTER TABLE overseer_verdicts ADD COLUMN IF NOT EXISTS merge_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE overseer_verdicts ADD COLUMN IF NOT EXISTS merge_not_before TIMESTAMPTZ;
ALTER TABLE overseer_verdicts ADD COLUMN IF NOT EXISTS merge_last_transient_reason TEXT;
