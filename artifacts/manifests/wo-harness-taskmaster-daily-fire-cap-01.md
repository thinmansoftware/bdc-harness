Manifest-Version: 2
WO: WO-HARNESS-TASKMASTER-DAILY-FIRE-CAP-01
Builder: existing root Codex actor 01a0fc1b-16d4-7023-86e8-f60a23c5d261
Scope: source/test/draft-PR only, A2 bdc-xo#2002 comment6250714249
Files modified: .github/workflows/test.yml, packages/core/package.json, packages/core/src/db/adapters/sqlite.ts, packages/core/src/db/taskmaster.ts, packages/server/src/taskmaster/loop.ts, packages/server/src/taskmaster/loop.test.ts, packages/smart-cauldron/src/cascade.ts, packages/smart-cauldron/src/recorder.ts, packages/smart-cauldron/src/types.ts
Files created: migrations/063_tm_fire_admissions.sql, packages/core/src/db/taskmaster-fire-cap.test.ts, packages/core/src/db/taskmaster-fire-cap.postgres.test.ts, packages/core/src/db/taskmaster-fire-cap-race.fixture.ts, packages/server/src/taskmaster/daily-fire-cap.test.ts, docs/operations/taskmaster-daily-fire-cap.md, artifacts/manifests/wo-harness-taskmaster-daily-fire-cap-01.md
Files deleted: none
Tests: 139 pass, 0 fail, 588 assertions (bun test packages/server/src/taskmaster/daily-fire-cap.test.ts packages/core/src/db/taskmaster-fire-cap.test.ts packages/server/src/taskmaster/loop.test.ts packages/server/src/taskmaster/fire-eligibility.test.ts)
Additional tests: core journal DAL 103 pass/0 fail; cascade and recorder 38 pass/0 fail.
PostgreSQL tests: original bb987e9f hosted PG17 suite passed 3/3 with 10 assertions and cleanup SUCCESS; local fixture remains absent. The admission-deadline refinement requires fresh exact-head hosted verification. Existing disposable PostgreSQL17 CI job is wired to run packages/core/src/db/taskmaster-fire-cap.postgres.test.ts. No skipped/mock dialect proof is accepted.
Types: bun run type-check exited 0 across the workspace and script project.
Lint: changed production TypeScript and race fixture exited 0; repository policy excludes \*.test.ts from ESLint. No lint configuration changed.
Formatting: changed supported source formats checked with the existing Prettier; SQL has no installed Prettier parser and remains ASCII/manual SQL formatting.
PRs: https://github.com/thinmansoftware/bdc-harness/pull/1166 (DRAFT, not REVIEW-ready).
Merge ancestors: thinmansoftware/bdc-harness dev base e2f3b0a9ca040796a3eeb7902fd7d0c9f073f632, refreshed before worktree creation; behind_by: 0 at start. Refresh before publication.
New DAL signatures: reserveAutomaticFire, authorizeAutomaticFire, releaseAutomaticFire, settleAutomaticFire, listAutomaticFireAdmissions, seedAutomaticFireHistory, updateAutomaticFireExpectation. Database parameters are optional isolated-test seams; runtime uses the existing database connection.
New cascade contract: optional awaited beforeAdmission gate; automaticFireAdmission provenance; exact stable readCascadeRecord lookup. Existing manual callers remain optional/unmodified.
Wiring: loop -> durable reservation -> async lane preflight -> awaited transactional day/pause/epoch permission -> durable cascade record -> existing fake-tested execution seam -> exact attempts[].runId evidence. Restart covers unresolved ledger history beyond message lookback.
Schema: additive PostgreSQL migration063 with UUID journal FK; SQLite equivalent bootstrap uses TEXT journal FK. Singleton control-row locking/BEGIN IMMEDIATE serialize admission; unknown permissions never expire on timeout alone.
Invocation documented at: docs/operations/taskmaster-daily-fire-cap.md
Runtime verification: N/A for A2; no runtime/image/config/registry/pause/workflow/provider action authorized or performed.
Vercel deployment: N/A; eventual target is a separately governed Docker service.
Review: exact-candidate independent/App/CI and post-build validator outstanding; no completion or production compliance claim.
VALIDATION: BLOCKED pending real PostgreSQL proof and required review.
