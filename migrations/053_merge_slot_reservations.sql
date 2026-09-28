-- Migration 053: atomic hourly merge-slot reservations for the unattended
-- merge execution bridge (bdc-harness PR #687 review).
--
-- Occupancy is the UNION of unreleased reservations and mutation_sent merges
-- in the rolling hour. A singleton lock row is updated inside the reservation
-- transaction so concurrent service instances cannot all observe the same
-- count and all merge.
--
-- SQLITE MIRROR: packages/core/src/db/adapters/sqlite.ts createSchema().
BEGIN;

CREATE TABLE IF NOT EXISTS overseer_merge_slot_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);

INSERT INTO overseer_merge_slot_lock (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS overseer_merge_slot_reservations (
  id TEXT PRIMARY KEY,
  verdict_id TEXT NOT NULL UNIQUE,
  reserved_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_overseer_merge_slot_reservations_window
  ON overseer_merge_slot_reservations(reserved_at);

COMMIT;
