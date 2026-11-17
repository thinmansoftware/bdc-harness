-- WO-HARNESS-T3-FIRE-RUN-OUTCOME-REPLY-01: the run outcome marker on the
-- T3 command admission ledger.
--
-- outcome_message_id records the Dispatch row that told the originating T3
-- thread how its fire ended (one per fire). Rows that exist when the column is
-- first added are marked 'pre-outcome-backfill' so fires admitted before this
-- change never produce a message.
--
-- ONE statement, so ONE transaction: the column add and the backfill commit
-- together or not at all. Running it again changes nothing. Apply it with
-- fail-on-error execution (psql -v ON_ERROR_STOP=1); a failure stops the
-- deploy. The PostgreSQL adapter does not apply migrations itself.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 't3_command_admissions'
       AND column_name = 'outcome_message_id'
  ) THEN
    ALTER TABLE t3_command_admissions ADD COLUMN outcome_message_id TEXT;
    UPDATE t3_command_admissions SET outcome_message_id = 'pre-outcome-backfill';
  END IF;
END $$;
