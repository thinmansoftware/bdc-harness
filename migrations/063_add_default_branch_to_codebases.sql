ALTER TABLE remote_agent_codebases ADD COLUMN IF NOT EXISTS default_branch VARCHAR(255) DEFAULT 'main';
