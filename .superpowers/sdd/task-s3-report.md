# M-42 Slice 3 Build Report

Result: DONE_WITH_CONCERNS pending independent exact-head review.

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
- Restart reconciliation for unknown STARTED state and crash recovery from an
  existing TERMINAL receipt without provider redelivery.
- Stable event identity wired through watcher service, workflow bridge, and
  Smart Cauldron callers.
- Separate Notion property lookup in frozen order: `Task`, `WO ID`, `Name`,
  `Title`, `WO_ID`.
- Authenticated read-only list and detail XO feed routes with no write route.
- Information-only channel adapters for Dispatch, builder monitor, and Notion.
- Contract: `docs/contracts/overseer-briefing-v1.md`.

## Contract evidence

- Contract SHA-256:
  `62394e6fe3710c319b8075e57c780847a23127593296b89a5726b3c47ed13ca4`
- Migration SHA-256:
  `bc771293b691209b978a52b43a5dbafec22c55c4823ce7592865f345f2a22bb1`
- Retry offsets: exactly 0, 30, and 120 seconds from card creation.
- Dispatch idempotency key: `operator-card:<card_id>:dispatch`.
- Slice 3 complete delivers information only and activates no mutation.

## Verification

- Required Stop 1 focused suite: 57 passed, 0 failed, 257 assertions, 6 files.
- Expanded pre-final focused suite: 72 passed, 0 failed, 296 assertions, 8 files;
  the final Stop 1 rerun includes one additional crash-window test.
- Legacy test amendment:
  - `escalate.test.ts`: 3 before, 3 after.
  - `new-failure-classes.test.ts`: 12 before, 12 after.
  - `service.test.ts`: 8 before, 8 after.
  - No case was removed; direct fan-out assertions became durable-card/job and
    stable-source assertions.
- `bun --filter @archon/core test`: passed.
- `bun --filter @archon/overseer test`: 114 passed, 0 failed.
- `bun --filter @archon/smart-cauldron test`: passed.
- `bun --filter @archon/server test`: passed.
- `bun run type-check`: passed for every package and scripts config.
- `bun run lint --max-warnings 0`: passed.
- `bun run format:check`: passed.
- `bun run check:bundled`: passed, 36 commands, 98 workflows, 1 policy.
- `bun run check:bundled-skill`: passed, 21 files.
- `git diff --check`: passed.
- Changed code ASCII scan: passed.

## Known baseline concern

`bun --filter @archon/workflows test` retains the authorized, pre-existing
failure `executeWorkflow > canary probe Telegram alerts > pages Telegram for
canary probe red blocks`: 52 passed, 1 failed in that executor file because
`fetchCalls[0]` is undefined. The same failure was reproduced on the untouched
exact base before Slice 3 implementation. Slice 3 does not touch Telegram or the
canary-alert path. The required focused workflow bridge suite is green.

## Reviewer focus

1. Confirm `new Date(workflowRun.started_at).toISOString()` accepts the persisted
   Date and legacy serialized fixture while still throwing on invalid time; no
   missing-time fallback exists.
2. Confirm cards and receipts are append-only in PostgreSQL and SQLite.
3. Confirm a TERMINAL receipt committed before a crash prevents redelivery.
4. Confirm only GET routes exist under `/api/overseer/operator-cards`.
5. Confirm escalation modules import no repair, lifecycle, Board mutation,
   deployment, or GitHub mutation adapter.

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
