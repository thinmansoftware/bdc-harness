-- M-155 Amendment 03: sent actions unseen by a non-draining recipient are unheard.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'tm_journal'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%grade%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tm_journal DROP CONSTRAINT %I', constraint_name);
  END IF;
  ALTER TABLE tm_journal ADD CHECK (
    grade IS NULL OR grade IN ('useful', 'noise', 'harmful', 'unheard')
  );
END $$;
