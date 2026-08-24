-- Taskmaster noise suppression (WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01, M-155 WO 3).
-- Additive only: creates tm_suppression. No existing table is altered.
--
-- This is a DURABLE, STANDALONE table -- deliberately NOT a column on the
-- tm_adoption projection. commitAdoptionSnapshot ends every refresh with
-- `DELETE FROM tm_adoption WHERE snapshot_id <> $1`, so suppression state
-- stored there would be erased on the very next tick. Migration 043's comment
-- reserving `suppressed_until_hash` on tm_adoption is SUPERSEDED by this
-- migration and must not be acted on.
--
-- Suppression lifts when the live adoptionContentHash of the thread's
-- adoption row differs from suppressed_until_hash (i.e. the work actually
-- moved); the loop then deletes the row.

CREATE TABLE IF NOT EXISTS tm_suppression (
  thread_ref            TEXT PRIMARY KEY,   -- canonical form (canonicalizeThreadRef)
  suppressed_until_hash TEXT NOT NULL,      -- adoptionContentHash at suppression
  suppressed_at         TEXT NOT NULL,
  noise_grade_count     INTEGER NOT NULL DEFAULT 2
);
