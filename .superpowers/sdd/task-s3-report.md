# M-42 Slice 3 Build Report

Result: READY_FOR_INDEPENDENT_EXACT_HEAD_REVIEW.

## Scope

- Work order: `WO-HARNESS-OVERSEER-ESCALATION-BRIEFING-01`
- Branch: `feat/m42-s3-escalation-briefing`
- Exact base: `origin/dev@318aabec46c9248a67c41e3ff7108898aa6c89bd`
- Production deploy, capability activation, Notion mutation, Board mutation, and
  issue-close mutation: not performed.

## Delivered

- Migration 035 and SQLite parity for immutable cards, mutable scheduler jobs,
  and append-only receipts.
- Canonical `overseer-actionable-event-v1` identity and lowercase SHA-256 card
  and payload digests.
- Transactional card plus three-job insertion with digest conflict rejection.
- Leased, fenced 0/30/120-second delivery with three-attempt ceiling.
- STARTED-before-provider and TERMINAL-before-job-completion receipts.
- Transactional receipt fencing by leased state, owner, token, and attempt;
  reclaimed leases reject stale-worker evidence.
- Restart reconciliation for unknown STARTED state and crash recovery from an
  existing TERMINAL receipt without provider redelivery.
- Response-loss exceptions are indeterminate and never blindly retried; only an
  explicit zero-effect `transient_failure` may consume the fixed retry schedule.
- Expired attempt-three leases are reclaimed for terminal reconciliation without
  a fourth provider call. HTTP adapters retry only 429 and 5xx; authentication,
  validation, and other non-success responses are permanent.
- Stable event identity wired through watcher service, workflow bridge, and
  Smart Cauldron callers. Workflow cards derive exact IDs and timestamps from
  the awaited durable event insert and fail closed when it cannot persist.
- The server runtime owns the delivery scheduler and drains in-flight work on
  shutdown. Retry time is anchored to card persistence, not old source time.
- Separate Notion property lookup in frozen order: `Task`, `WO ID`, `Name`,
  `Title`, `WO_ID`.
- Authenticated read-only list and detail XO feed routes with no write route.
- Information-only channel adapters for Dispatch, builder monitor, and Notion.
- Contract: `docs/contracts/overseer-briefing-v1.md`.

## Contract evidence

- Contract SHA-256:
  `bff68b9c2a614542a40746860f3f961aa3e1fedb4f1dda691d7440ca90786ed2`
- Migration SHA-256:
  `bc771293b691209b978a52b43a5dbafec22c55c4823ce7592865f345f2a22bb1`
- Retry offsets: exactly 0, 30, and 120 seconds from card creation.
- Dispatch idempotency key: `operator-card:<card_id>:dispatch`.
- Slice 3 complete delivers information only and activates no mutation.

## Verification

- Focused persistence: 5 passed, including stale-worker receipt rejection.
- Focused delivery/adapters: 17 passed, including attempt-three crash recovery,
  response-loss, old-event retry epoch, injected dependencies, and explicit HTTP
  status classification.
- Focused durable bridge boundary: 4 passed; failed event insert creates zero
  cards, jobs, or authorization attempts.
- Focused store adapter: 12 passed; durable insert returns the exact row and
  propagates failure.
- Focused workflow-event DB contract: 23 passed.
- Focused API list/detail and no-write routes: 2 passed.
- `bun --filter @archon/core test`: passed, exit 0.
- `bun --filter @archon/overseer test`: 159 passed, 0 failed.
- `bun --filter @archon/smart-cauldron test`: 59 passed, 0 failed.
- `bun --filter @archon/server test`: 396 passed, 0 failed. The canonical
  package script now includes `api.overseer-briefing.test.ts`.
- `bun run type-check`: passed for every package and scripts config.
- `bun run lint --max-warnings 0`: passed.
- `bun run format:check`: passed.
- `bun run check:bundled`: passed, 36 commands, 98 workflows, 1 policy.
- `bun run check:bundled-skill`: passed, 21 files.
- Migration 035 applied with `ON_ERROR_STOP=1` to a unique disposable local
  PostgreSQL 15 database. Verification found exactly 3 tables with 28/9/14
  columns, 4 append-only triggers, 6 indexes, and the expected check, primary,
  foreign, and unique constraints. `DROP DATABASE ... WITH (FORCE)` succeeded.
- `git diff --check`: passed.
- Changed script/code ASCII scan: passed.

## Known baseline concern

`bun --filter @archon/workflows test` retains the authorized, pre-existing
failure `executeWorkflow > canary probe Telegram alerts > pages Telegram for
canary probe red blocks`: 52 passed, 1 failed in that executor file because
`fetchCalls[0]` is undefined. The same failure was reproduced on the untouched
exact base before Slice 3 implementation. Slice 3 does not touch Telegram or the
canary-alert path. Every preceding workflow package test group passed, and the
required focused workflow bridge suites are green. On Windows, Git Bash must be
present on `PATH`; without it, the unrelated commit-backstop fixture fails at
process spawn before its assertions.

## Reviewer focus

1. Confirm thrown provider transport is indeterminate and receives no retry,
   expired attempt three reconciles without attempt four, and HTTP retries are
   limited to 429 and 5xx responses.
2. Confirm workflow cards use the exact row returned by durable event insertion
   and insert failure creates no downstream side effect.
3. Confirm the server runtime starts and shutdown-drains the delivery scheduler.
4. Confirm the retry epoch is card persistence time, not source event time.
5. Confirm Smart Cauldron checkpoints the source attempt identity used by the
   operator card.
6. Confirm all default channel adapters use injected boundaries.
7. Confirm PostgreSQL migration evidence and SQLite parity.
8. Confirm stale receipt writers fail the transactional lease fence.
9. Confirm only GET routes exist and escalation modules import no mutation
   adapter.

## Issue #958 disposition evidence

Test names:

- `queries separate candidates in frozen order and returns first success`
- `fails soft after all candidate queries fail`

Both pass at the build head. Candidate order is `Task`, `WO ID`, `Name`,
`Title`, `WO_ID`; candidate failures do not stop later candidates. No issue API
was called.

Recommendation: close #958 after independent exact-head approval and merge,
because this slice replaces the combined-filter defect with separately tested
candidate queries. This build does not close the issue.
