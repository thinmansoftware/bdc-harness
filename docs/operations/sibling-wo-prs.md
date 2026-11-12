# Sibling pull requests of one work order

Work order WO-HARNESS-SIBLING-WO-PR-HOLD-AFTER-MERGE-01 (bdc-xo#5654). Code: `packages/overseer/src/reconcile.ts` (the supersede pass), `packages/overseer/src/sibling-wo-id.ts` (the resolver and the merge-gate finder), `packages/overseer/src/originating-run-lookup.ts` (`findOriginatingRunsForPullRequest`), `packages/overseer/src/merge-execution-bridge.ts` (the gate).

## What happened

On 2026-11-12 a redundant second rung of one work order opened a salvage fallback PR (provisioner PR 103). The first rung's PR (102) merged at 14:14:22Z. PR 103 stayed open, Overseer-approved and mergeable until a person closed it by hand: a second implementation could have landed on top of the first.

## The pass that closes siblings (already existed, now sees more)

When a pull request merges, the reconcile pass closes every other OPEN, non-draft, same-repo PR created BEFORE the merge that belongs to the same work order, with the comment `Superseded by #<n>`, one action row per sibling (`reconcile_supersede_close`). It skips a spec-only merge and fails closed on an unreadable file list. Until this change a sibling was recognised only by its own `WO:` body line or a work-order token in its branch name.

A salvage fallback PR has neither (fixed body text, branch `salvage/opus-repair-<worktree>-<pid>`). Now, for a candidate those two rules did not match, the pass asks the PR's originating run which work order it was fired for (the first `WO_ID=<id>` line of the run's user message) and matches when that id is one of the merged PR's declared work orders. A run-matched sibling is closed with:

`Superseded by #<merged>: the same work order (<WO id>) merged there. This PR's branch <head ref> is kept; reopen the PR if it is still wanted.`

The branch is never deleted. Reopen the PR if the salvage commit is still wanted.

## The guard: any doubt leaves the PR open, and the lookup is bounded

The lookup must return exactly one WO id, from every run that opened the PR, and that id must be a declared work order of the merged PR. Otherwise the PR is left open.

Bound (2026-11-12, after the rebuild at 17:44Z made the container miss health checks): the question is asked ONLY for a pull request whose head branch is an engine branch, `salvage/opus-repair-*` (a salvage fallback PR) or `archon/*` (a bare run branch), and ONCE per pull request per reconcile pass (a per-pass memo; a failed lookup is not remembered). A person's branch, or a work-order token branch the body and branch rules already match, never reaches the event store. Before the bound the pass asked for every open PR of the repository once per merged PR: 5,252 to 5,265 synchronous SQLite lookups a pass; bun:sqlite blocks the event loop, and the container's metering tick came 4.8 to 51.9 seconds late in 13 of 21 minutes.

| signal | level | meaning |
|---|---|---|
| `overseer.reconcile.supersede_lookup_unmatched`, `reason: lookup_failed` | warn | the event store read threw |
| `overseer.reconcile.supersede_lookup_unmatched`, `reason: ambiguous` | warn | several runs, different WO ids, or a run without one |
| `supersede_lookup:no_originating_run`, `:other_work_order`, `:skipped_branch` | counted in `overseer.reconcile.call_counts` | the ordinary cases; not logged per pull request (15,918 lines in 24 minutes) |
| `supersede_lookup:reads` and `:memo_hits`, `calls:resolveOriginatingWoId`, `pass_ms` | counted in `overseer.reconcile.call_counts` | how many lookups reached the store, how many the memo answered, the lookups asked for, and the pass duration in milliseconds |

A salvage PR is found through the worktree basename inside its branch name (`salvage/opus-repair-<worktree>-<pid>`).

## The merge gate (the race)

Before the merge manager merges a pull request it asks whether another PR of the same work order, in the same repository, was merged after this one was created (spec-only merges do not count). If so it skips the PR with the reason `sibling_pr_already_merged` and logs one warn line naming the repository, the PR and the merged PR (`mergedPrNumber`). It costs two GitHub reads per merge candidate (the PR itself and the 30 most recently updated closed PRs of the repository). A failed lookup never blocks a merge (`merge-coordinator.sibling_lookup_failed`).

## Reading it

- Closed siblings: `overseer_actions` rows with action `reconcile_supersede_close` (the merged PR is in `result`).
- A skipped PR: the verdict outcome reason `sibling_pr_already_merged`.
- Reopen a wrongly closed PR from the GitHub UI; nothing re-closes it (the action row is already recorded).
