-- Extend the existing execution-claim ledger for Overseer repair/refire claims.
-- This keeps recovery fencing in board_execution_claims instead of introducing
-- a second lease table.

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'board_execution_claims'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) = 'CHECK ((action_kind = ''production_deploy''::text))';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE board_execution_claims DROP CONSTRAINT %I', constraint_name);
  END IF;

  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'board_execution_claims'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) = 'CHECK ((environment = ''production''::text))';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE board_execution_claims DROP CONSTRAINT %I', constraint_name);
  END IF;

  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'board_execution_claims'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%target_sha%'
    AND pg_get_constraintdef(con.oid) LIKE '%[0-9a-f]{40}%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE board_execution_claims DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE board_execution_claims
  ADD CONSTRAINT board_execution_claims_action_kind_check
  CHECK (action_kind IN ('production_deploy', 'overseer_repair_refire'));

ALTER TABLE board_execution_claims
  ADD CONSTRAINT board_execution_claims_environment_check
  CHECK (environment IN ('production', 'recovery'));

ALTER TABLE board_execution_claims
  ADD CONSTRAINT board_execution_claims_target_sha_check
  CHECK (target_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$');
