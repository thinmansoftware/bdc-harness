-- Migration 057: per-issue claim for Taskmaster escalation comments
-- (WO-HARNESS-TASKMASTER-ESCALATE-TO-ISSUE-01, bdc-harness PR #889 review).
--
-- deliverEscalationToIssue dedupes on a marker comment it LISTS from GitHub and
-- then POSTS. List-then-post is not atomic: two Taskmaster ticks or processes
-- sharing this database could both observe no recent marker and both post.
-- This table serializes delivery per issue BEFORE the GitHub list+post.
--
-- One row per issue (issue_key = lowercased "owner/repo#N"). A claim is taken
-- by a single INSERT ... ON CONFLICT (issue_key) DO UPDATE ... WHERE <free>
-- RETURNING statement (packages/core/src/db/taskmaster.ts
-- claimEscalationDelivery). The row is free when it is an in-flight claim
-- (posted_at NULL) whose lease_expires_at has passed -- so a crashed attempt
-- never locks the issue past its lease -- or a recorded post older than the
-- 72h cooldown. A claim that posted nothing is deleted on release.
--
-- WHY A NEW TABLE: no existing uniqueness mechanism fits. tm_journal's
-- idempotency_key carries only a non-unique index and is per 30-minute P0
-- bucket, so it can neither hold across the cooldown nor expire a crashed
-- in-flight attempt; tm_suppression and the board/merge claim tables have
-- other meanings that this would corrupt.
--
-- ADDITIVE: a new table only; no existing table or row is touched.
-- Timestamps are ISO-8601 UTC TEXT (like tm_suppression) so the claim's
-- comparisons behave identically on SQLite and PostgreSQL.
--
-- SQLITE MIRROR: packages/core/src/db/adapters/sqlite.ts createSchema().
CREATE TABLE IF NOT EXISTS tm_escalation_claims (
  issue_key        TEXT PRIMARY KEY,
  claim_id         TEXT NOT NULL,
  claimed_at       TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  posted_at        TEXT
);
