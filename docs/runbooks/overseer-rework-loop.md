# Overseer rework loop

WO: WO-HARNESS-OVERSEER-REWORK-LOOP-01

## What it is

When the Overseer posts CHANGES_REQUESTED on a Cauldron-built pull request
against a non-production base, the harness automatically enqueues a rework
run that repairs the SAME branch, pushes, and gets re-reviewed -- with a
bounded retry cap and an escalation when the cap is reached. There is no
manual command to fire a rework: the review worker clock
(`packages/server/src/dispatch/review-worker-clock.ts`,
`tickReviewWorkerClock`) triggers it automatically after every
`changes_requested` verdict, via the optional
`reworkOnChangesRequested` hook, which calls
`assessAndEnqueueRework` (`packages/overseer/src/pr-rework.ts`).

A separate clock, `tickReworkWorkerClock`
(`packages/server/src/dispatch/rework-worker-clock.ts`), drains the resulting
`run_rework` Dispatch queue and fires the actual repair run. Both clocks are
started in `packages/server/src/index.ts`, next to `startReviewWorkerClock`,
under the same `NODE_ENV=test` guard, so they run automatically inside
archon-app-1 whenever the server process starts -- there is no separate
invocation.

## Trigger conditions

A rework is enqueued only when ALL of the following hold, checked in this
order by `assessAndEnqueueRework`:

1. The review verdict's `disposition` is `changes_requested` and its
   `summary` is non-empty.
2. `verdictAuthorizesRecheck` says the verdict is NOT check-caused (a
   CI-caused CHANGES_REQUESTED is owned by the stale-verdict sweep, not by
   this loop).
3. `OVERSEER_REWORK_ENABLED` is not `false`, and the repo is in
   `OVERSEER_REWORK_REPOS`.
4. The live PR (read via Octokit) is open, not a draft, has a head repo
   matching `owner/repo` (no forks), a head SHA matching the reviewed head
   (no stale-head reworks), and does not carry the `no-auto-rework` label.
5. `getRepoBasePolicy(owner/repo, base)` resolves and `unattended === true`
   (M-09: production bases such as bdc-harness `main`, shopops `master`,
   lspro-react `main` are never touched -- no rework, no comment, no
   escalation).
6. The PR has a Cauldron-owned originating run
   (`findOriginatingRunForPullRequest`, `packages/core/src/db/workflow-events.ts`).
   A human-built or XO-salvage PR has no such run: skipped silently, no
   comment, no escalation.
7. The originating run's `user_message` parses as
   `WO_ID=<id> --project <project>`, and the PR's head branch matches the
   lane's repair-target pattern `^(feat|fix|wip)/[A-Za-z0-9_-]+$`. Either
   failure ESCALATES instead of silently skipping.
8. Fewer than the retry cap's worth of prior `run_rework` messages exist for
   this PR's subject key. At or above the cap, ESCALATES instead of
   enqueuing.

## Env vars (all optional; defaults shown)

| Env var | Default | Meaning |
|---|---|---|
| `OVERSEER_REWORK_ENABLED` | unset (treated as enabled) | Kill switch. Set to the literal string `false` to disable the whole loop; any other value (including unset) leaves it enabled. |
| `OVERSEER_REWORK_REPOS` | `thinmansoftware/bdc-harness` | Comma-separated `owner/repo` allowlist (case-insensitive, trimmed). Only listed repos are ever reworked. |
| `OVERSEER_REWORK_MAX_ATTEMPTS` | `2` | Max automatic reworks per PR. The EFFECTIVE cap is `min(this value, resolveMaxRereviewAttempts())` -- it can never exceed the re-review budget (default 3, env `OVERSEER_MAX_REREVIEW_ATTEMPTS`), because every rework push triggers one automatic re-review. |
| `OVERSEER_REWORK_WORKFLOW` | `bdc-feature-development-codex` | The lane the rework worker fires. Must be one of `REWORK_CAPABLE_WORKFLOWS` (currently only `bdc-feature-development-codex` -- the only lane carrying the `REWORK_DIRECTIVE` gate line). Any other value logs `overseer_rework_workflow_not_capable` and fires nothing. |
| `OVERSEER_REWORK_MODEL_OVERRIDE` | `{"nodes":{"implement":{"provider":"cursor","model":"grok-4.7-high"},"diff-repair":{"provider":"cursor","model":"grok-4.7-high"},"opus-repair":{"provider":"cursor","model":"grok-4.7-high"}}}` | JSON `modelOverride` body sent with the direct fire. |
| `ARCHON_API_BASE_URL` | `http://localhost:3090` | Base URL the rework worker clock POSTs the fire request to (`/api/workflows/<workflow>/run`). |
| `ARCHON_OPERATOR_TOKEN` | (required at fire time, no default) | Sent as the `x-archon-operator-token` header on the fire request. Read from the environment only -- **never logged**, and never appears in any dispatch message body or PR comment. |

## Opt-out

Add the label `no-auto-rework` to a PR to permanently exempt it from this
loop (checked on every tick, so adding the label after a rework has already
been enqueued still prevents a FUTURE rework, but does not retract one
already queued).

## Escalation

A rework escalates (instead of enqueuing) for exactly these reasons:

- `originating_run_unparseable` -- the originating Cauldron run's
  `user_message` did not match `WO_ID=<id> --project <project>`.
- `branch_pattern_unsupported` -- the PR's head branch does not match
  `^(feat|fix|wip)/[A-Za-z0-9_-]+$` (e.g. an `archon/task-*` branch).
- `rework_cap_exhausted` -- the PR has already used its full retry budget.
- `rework_fire_failed` -- the rework worker clock's direct fire to
  `/api/workflows/<workflow>/run` failed on its final attempt (after
  backing off twice on the same item with a 5-minute `not_before`).

Every escalation does exactly two things, each de-duplicated:

1. One PR comment carrying an HTML marker
   `<!-- overseer-rework:<reason>:<headSha> -->`. A second escalation for the
   SAME reason and head sha does not re-post the comment.
2. One Dispatch message to `operator`, `task_type: agent_message`,
   `priority: blocker`, naming the PR, branch, WO id, reason, and the
   Overseer's findings text.

A skip (as opposed to an escalation) -- `not_changes_requested`,
`check_caused_verdict`, `repo_not_enabled`, `pr_not_eligible:<detail>`,
`production_or_unlisted_base`, `not_cauldron_built` -- has NO side effect:
no comment, no dispatch message. These are the paths this loop deliberately
leaves alone (human PRs, production bases, check-caused verdicts, disabled
repos).

## Reading `run_rework` rows

`run_rework` is a Dispatch `task_type` on `agent_dispatch_messages`, recipient
`overseer-rework` (principal `Overseer Rework Dispatcher`, delivery mode
`worker_poll`, seeded by migration `059_overseer_rework_principal.sql` and,
for the Postgres CHECK constraint on pre-existing databases, migration
`060_dispatch_run_rework_task_type.sql`). To list every rework attempt for
one PR:

```sql
SELECT id, status, task_outcome, created_at, completed_at, subject_key, body
FROM agent_dispatch_messages
WHERE task_type = 'run_rework'
  AND subject_key = 'gh:thinmansoftware/bdc-harness#936'
ORDER BY created_at;
```

Against the live archon.db on Hetzner:

```bash
ssh hetzner-prod "sqlite3 -separator ' | ' /opt/bdc/archon-data/archon.db \"select id, status, task_outcome, created_at, subject_key from agent_dispatch_messages where task_type='run_rework' order by created_at desc limit 20\""
```

Each row's `body` is the JSON `ReworkEnqueueBody`: `owner`, `repo`,
`prNumber`, `headSha`, `branch`, `baseRef`, `woId`, `project`,
`originatingRunId`, `reviewMessageId`. Its `idempotency_key` is
`overseer-rework:<owner>/<repo>#<prNumber>@<headSha>` -- one row per exact
head, ever, regardless of how many times the same verdict is delivered.

## How the rework actually reaches the builder

The rework worker clock fires a DIRECT POST to
`${ARCHON_API_BASE_URL}/api/workflows/${OVERSEER_REWORK_WORKFLOW}/run` with a
message of the form:

```
WO_ID=<woId> --project <project> --rework=<base64url JSON {prNumber, branch, headSha, reviewMessageId}>
```

`freezeWorkOrderSource` (`packages/core/src/workflows/work-order-source.ts`)
parses the `--rework=` token (`readReworkDirectiveRef`), verifies it against
the ORIGINAL run_review row (task_type `run_review`, recipient
`overseer-reviewer`, matching subject key and head sha, disposition
`changes_requested`), and on success appends a deterministic block
(`renderReworkDirective`) to the frozen spec bytes:

```
## Rework directive (engine-appended, do not edit)
REWORK_DIRECTIVE: overseer-changes-requested
Repair target: PR #<prNumber> (branch <branch>)
Rework head: <headSha>
Review message: <reviewMessageId>
The Overseer rejected this exact head. Every finding below is an unmet requirement of this WO. Fix each one on this branch; do not open a new PR.
### Overseer findings
<summary verbatim>
```

The lane's `gate-already-satisfied` node
(`.archon/workflows/defaults/bdc-feature-development-codex.yaml`) reads this
block off `$read-spec.output`: if the exact line
`REWORK_DIRECTIVE: overseer-changes-requested` is present, it forces the
`needs-build` verdict regardless of what `check-already-satisfied` found, so
the builder actually re-implements instead of short-circuiting to
already-satisfied. The existing `checkout-repair-target` node then checks out
the SAME branch (via the `Repair target: PR #<N> (branch <X>)` line) and
`commit-and-push` pushes onto it, which triggers the normal re-review path.

## Verifying after a harness rebuild

```bash
grep -c 'reworkOnChangesRequested' packages/server/src/dispatch/review-worker-clock.ts   # >= 3
grep -c 'startReworkWorkerClock' packages/server/src/index.ts                             # >= 1
grep -c 'REWORK_DIRECTIVE: overseer-changes-requested' .archon/workflows/defaults/bdc-feature-development-codex.yaml   # >= 1
```

Runtime proof that the loop actually fires against a live CHANGES_REQUESTED
Cauldron PR is deferred to XO after the container rebuild (rule 11.5) -- this
is not provable in CI without a real GitHub PR and a real Overseer review.
