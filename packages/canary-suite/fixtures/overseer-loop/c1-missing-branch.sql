INSERT INTO remote_agent_workflow_runs (id, started_at, metadata) VALUES
  ('run-complete-1', '2026-10-27 12:00:00', '{"base_branch":"dev","head_branch":"feature/a"}'),
  ('run-complete-2', '2026-10-27 18:00:00', '{"base_branch":"dev","head_branch":"feature/b"}'),
  ('run-missing-head', '2026-10-27 23:00:00', '{"base_branch":"dev"}'),
  ('run-old-missing-both', '2026-10-26 00:00:00', '{"base_branch":"","head_branch":""}');
