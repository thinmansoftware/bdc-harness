-- Taskmaster noise suppression (WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01, M-155 WO 3).
-- Additive only: creates tm_suppression. No existing table is altered.
--
-- DURABLE table, deliberately standalone -- NOT a column on tm_adoption. The
-- adoption projection is disposable: commitAdoptionSnapshot ends every refresh
-- with `DELETE FROM tm_adoption WHERE snapshot_id <> $1`, which would erase a
-- suppression column on the very next tick. The reservation comment in
-- migration 043 (suppressed_until_hash on tm_adoption) is SUPERSEDED by this WO
-- and must NOT be acted on. Suppression must survive snapshot refreshes, so it
-- lives here and is never touched by the adoption refresh cycle.
--
-- A row suppresses ordinary nudges for its canonical thread_ref until the live
-- adoptionContentHash(row) differs from suppressed_until_hash -- i.e. the work
-- actually moved.

CREATE TABLE IF NOT EXISTS tm_suppression (
  thread_ref            TEXT PRIMARY KEY,   -- canonical form (post canonicalizeThreadRef)
  suppressed_until_hash TEXT NOT NULL,      -- adoptionContentHash at suppression time
  suppressed_at         TEXT NOT NULL,
  noise_grade_count     INTEGER NOT NULL DEFAULT 2
);
