Manifest-Version: 2
WO: WO-HARNESS-TASKMASTER-DAILY-FIRE-CAP-01
Builder: existing root Codex actor 01a0fc1b-16d4-7023-86e8-f60a23c5d261
Scope: original A2 source/test/draft-PR comment6250714249; A3 local correction/test/doc/one commit only, bdc-xo#2002 comment6254490904, 2026-10-18T20:02Z-20:47Z. No A3 publication or PR mutation.
Correction parent: cf0cc6c65efd6c54c9623b16b74d75dd2b54ac4e. Exact new commit is recorded in the external operator handoff after local commit creation.
Correction paths: packages/core/src/db/taskmaster.ts, packages/server/src/taskmaster/loop.ts, packages/core/src/db/taskmaster-fire-cap.test.ts, packages/server/src/taskmaster/daily-fire-cap.test.ts, docs/operations/taskmaster-daily-fire-cap.md, artifacts/manifests/wo-harness-taskmaster-daily-fire-cap-01.md.
Files modified: .github/workflows/test.yml, packages/core/package.json, packages/core/src/db/adapters/sqlite.ts, packages/core/src/db/taskmaster.ts, packages/server/src/taskmaster/loop.ts, packages/server/src/taskmaster/loop.test.ts, packages/smart-cauldron/src/cascade.ts, packages/smart-cauldron/src/recorder.ts, packages/smart-cauldron/src/types.ts
Files created: migrations/063_tm_fire_admissions.sql, packages/core/src/db/taskmaster-fire-cap.test.ts, packages/core/src/db/taskmaster-fire-cap.postgres.test.ts, packages/core/src/db/taskmaster-fire-cap-race.fixture.ts, packages/server/src/taskmaster/daily-fire-cap.test.ts, docs/operations/taskmaster-daily-fire-cap.md, artifacts/manifests/wo-harness-taskmaster-daily-fire-cap-01.md
Files deleted: none
Tests: 158 pass, 0 fail, 795 assertions, no skipped or filtered tests (bun test packages/server/src/taskmaster/daily-fire-cap.test.ts packages/core/src/db/taskmaster-fire-cap.test.ts packages/server/src/taskmaster/loop.test.ts packages/server/src/taskmaster/fire-eligibility.test.ts)
Regression: isolated pre-fix legacy/two-day/restart case failed the first new-day allowance (expected true, received false). A second red/green case proves a cross-midnight admission window stays held. The corrected combined suite includes both and negative controls. Early Windows fixture-cleanup EBUSY failures were resolved by dropping closed adapter references before collection; they are not reported as passes.
Additional historical tests at cf0: core journal DAL 103 pass/0 fail; cascade and recorder 38 pass/0 fail. These unchanged-area runs were not repeated for A3.
PostgreSQL tests: cf0 hosted PG17 job117702984300 passed 3/3 with 11 assertions and cleanup SUCCESS; local fixture remains absent. The A3 legacy-accounting correction requires fresh exact-head hosted verification after separate publication acceptance. Existing disposable PostgreSQL17 CI job runs packages/core/src/db/taskmaster-fire-cap.postgres.test.ts. No historical/skipped/mock dialect proof transfers to the new candidate.
Types: bun run type-check exited 0 across the workspace and script project.
Lint: A3 changed production TypeScript exited 0; repository policy excludes \*.test.ts from ESLint. No lint configuration changed.
Formatting: changed supported source formats checked with the existing Prettier; SQL has no installed Prettier parser and remains ASCII/manual SQL formatting.
PRs: https://github.com/thinmansoftware/bdc-harness/pull/1166 (DRAFT, not REVIEW-ready).
Merge ancestors: thinmansoftware/bdc-harness dev base e2f3b0a9ca040796a3eeb7902fd7d0c9f073f632, refreshed before worktree creation; behind_by: 0 at start. Refresh before publication.
New DAL signatures: reserveAutomaticFire, authorizeAutomaticFire, releaseAutomaticFire, settleAutomaticFire, listAutomaticFireAdmissions, seedAutomaticFireHistory, updateAutomaticFireExpectation. Database parameters are optional isolated-test seams; runtime uses the existing database connection.
New cascade contract: optional awaited beforeAdmission gate; automaticFireAdmission provenance; exact stable readCascadeRecord lookup. Existing manual callers remain optional/unmodified.
Wiring: loop -> durable reservation -> async lane preflight -> awaited transactional day/pause/epoch permission -> durable cascade record -> existing fake-tested execution seam -> exact attempts[].runId evidence. Restart covers unresolved ledger history beyond message lookback.
Schema: additive PostgreSQL migration063 with UUID journal FK; SQLite equivalent bootstrap uses TEXT journal FK. Singleton control-row locking/BEGIN IMMEDIATE serialize admission; unknown permissions never expire on timeout alone.
Invocation documented at: docs/operations/taskmaster-daily-fire-cap.md
Legacy correction: only exact durable completed cascade evidence permits historical day accounting, retaining legacy owner attribution and original journal/record provenance. Terminal journal labels alone, timeouts and missing evidence never refund genuine unknown permissions. No migration, table, enum or endpoint changed for A3.
Runtime verification: N/A for A2/A3; no runtime/image/config/registry/pause/workflow/provider action authorized or performed.
Vercel deployment: N/A; eventual target is a separately governed Docker service.
Review: cf0 independent Cursor ASK report #2002/6254340155 CHANGES_REQUIRED (legacy cross-day accounting). A3 addresses its isolated trigger with conservative durable-evidence classification; fresh exact-candidate independent/App/CI and post-build validator remain outstanding. No completion or production compliance claim.
VALIDATION: BLOCKED pending real PostgreSQL proof and required review.
