-- WO-GRIMOIRE-PROJECT-RECORD-01 (migration 068)
ALTER TABLE remote_agent_codebases ADD COLUMN IF NOT EXISTS project_record TEXT;
