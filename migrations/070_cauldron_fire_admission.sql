ALTER TABLE cascade_wo_claims ADD COLUMN IF NOT EXISTS target_repo TEXT;
ALTER TABLE cascade_wo_claims ADD COLUMN IF NOT EXISTS target_branch TEXT;
