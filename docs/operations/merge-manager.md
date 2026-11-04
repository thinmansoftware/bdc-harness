# Merge manager operations

The merge manager revalidates Overseer-approved pull requests against live GitHub state and repository policy before performing an unattended squash merge. Temporary conditions are retried with bounded exponential backoff; permanent policy and state failures remain final.

## Skip classification

| Classification | Reasons |
| --- | --- |
| Transient | `mergeable_state_not_clean`, `required_checks_not_success`, `pr_lookup_failed`, `open_pr_not_found`, `changed_files_unresolved`, `pr_context_fetch_failed` |
| Transient when message matches | `merge_failed:<message>` or a bare rejected-merge message matching rate limit, not mergeable, already in progress, base branch was modified, timeout, `ETIMEDOUT`, `ECONNRESET`, or HTTP 502/503/504 |
| Terminal | `spec_only`, `pr_not_open`, `head_moved`, `verdict_stale_head`, `not_mergeable_dirty`, `base_not_allowlisted`, `integration_base_mismatch`, `repo_not_allowed`, `run_context_unresolvable`, `pr_context_unresolvable`, `service_disabled`, `emergency_stop`, `legacy_dry_run`, `merge_actions_disabled`, CE recheck reasons, `github_merge_transport_ambiguous`, `merge_executed*`, bare `merge_failed`, `transient_exhausted:*`, and all unmatched reasons |

## Merge holds

A hold stops an otherwise mergeable pull request without recording a terminal or transient skip. The bridge releases the verdict claim so the next tick evaluates it again. `merge_hold`, `merge_hold_unverified`, and `merge_hold_label` do not enter the transient or terminal tables above, do not write a final outcome, and do not consume the retry attempt budget.

A work order spec on `thinmansoftware/bdc-xo` `main` at `docs/work-orders/<WO-ID>.md` holds its pull request when a whole line matches `/^merge_hold:[ \t]*true[ \t]*\r?$/im`. The key and value are case-insensitive. Spaces or tabs are allowed after the colon and at the end of the line only. A newline between the key and the value, a leading space, a trailing comment, a `false` value, or the same words inside a prose paragraph do not hold. Removing that line lets the next tick merge through the existing guards.

A missing spec (HTTP 404) is not a hold. Any other spec-read failure, including network errors, HTTP 5xx, authorization failures, rate limits, and decode failures, releases the claim with `merge_hold_unverified` and does not merge.

A pull request label named exactly `merge-hold` (case-sensitive) holds any pull request, including ones that are not tied to a work order. The bridge records `merge_hold_label` and does not read a spec. Removing the label lets the next tick merge through the existing guards.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `OVERSEER_MERGE_RETRY_BASE_MINUTES` | 10 | Initial retry delay |
| `OVERSEER_MERGE_RETRY_MAX_DELAY_MINUTES` | 240 | Maximum delay between attempts |
| `OVERSEER_MERGE_RETRY_MAX_ATTEMPTS` | 8 | Attempt cap, including the initial look |

## Repository base policy (staging lineages)

`DEFAULT_MERGE_REPO_POLICY` in `packages/overseer/src/merge-repo-policy.ts` declares merge candidacy per repository and base. A running container that sets `MERGE_MANAGER_REPO_POLICY` overrides the default completely, so the default alone does not change a live deployment (see the operator step below).

| Repository | Base | Unattended | Docs-only |
| --- | --- | --- | --- |
| `thinmansoftware/lspro-react` | `dev` | yes | skip |
| `thinmansoftware/lspro-react` | `staging` | yes | skip |
| `thinmansoftware/lspro-react` | `main` | no | skip |
| `thinmansoftware/shopops-storefront` | `staging` | yes | skip |
| `thinmansoftware/shopops-storefront` | `master` | no | skip |

`release/lspro`, `release/ce`, `main` and `master` are production lanes and are never unattended candidates: `release/*` has no entry at all.

### Operator step after this lands on dev (not part of the code change)

Edit `/opt/bdc/archon/.env`, then run the governed rebuild of `archon-app-1`:

1. Line 99, `MERGE_MANAGER_REPO_POLICY`, replace the value with (generated from the default policy; round-trips through `parseMergeRepoPolicy`):

```
MERGE_MANAGER_REPO_POLICY={"thinmansoftware/bdc-harness":{"dev":{"unattended":true,"docs_only":"skip"},"staging":{"unattended":true,"docs_only":"skip"},"main":{"unattended":false,"docs_only":"skip"}},"thinmansoftware/shopops":{"staging":{"unattended":true,"docs_only":"skip"},"master":{"unattended":false,"docs_only":"skip"}},"thinmansoftware/lspro-react":{"dev":{"unattended":true,"docs_only":"skip"},"staging":{"unattended":true,"docs_only":"skip"},"main":{"unattended":false,"docs_only":"skip"}},"thinmansoftware/shopops-storefront":{"staging":{"unattended":true,"docs_only":"skip"},"master":{"unattended":false,"docs_only":"skip"}},"thinmansoftware/bdc-xo":{"main":{"unattended":true,"docs_only":"merge"}}}
```

2. Line 97, `OVERSEER_MERGE_DISCOVERY_REPOS`, append `thinmansoftware/lspro-react,thinmansoftware/shopops-storefront` to the existing comma-separated list.

Verify after the rebuild:

```sh
ssh hetzner-prod 'docker exec archon-app-1 printenv MERGE_MANAGER_REPO_POLICY' | grep -c shopops-storefront
```

Expected output: `1`.

## Requeue verdicts stranded by the old behavior

Preview eligible transient skips:

```sh
docker exec -w /app/packages/overseer archon-app-1 bun run requeue-transient-merge-skips -- --dry-run
```

Apply the idempotent requeue:

```sh
docker exec -w /app/packages/overseer archon-app-1 bun run requeue-transient-merge-skips
```

Inspect an outcome with:

```sql
select action_reason, merge_attempts, merge_not_before from overseer_verdicts where pr_url like '%/pull/<N>';
```

Merging this code does not update the running source-copy container. XO must rebuild the container before runtime verification. Production requeue and canary execution are XO post-merge actions, not builder actions.

## Sweep liveness and supervision

Added by WO-HARNESS-MERGE-SWEEP-LIVENESS-AND-PAGING-01 after the 2026-11-04 stall: a SQLITE_BUSY in the
operator-card delivery drain went uncaught, stopped the watcher, merge bridge and reconcile loops together,
and nothing restarted them or raised an alarm for about an hour. Approved green PRs sat unmerged meanwhile.

What now protects the sweep:

- The delivery scheduler isolates its own errors (`overseer.delivery.iteration_failed_isolated`), like the
  reconcile and merge-bridge schedulers. `abortOnFailure` in `runOverseerService` remains only as a last-resort guard.
- `startOverseerRuntime` supervises the service. The supervisor restarts the loop ONLY after the service promise has
  actually SETTLED (rejected, or resolved unexpectedly). It never starts a new pass or loop while an old one is still pending. On a rejection
  `overseer_runtime.watcher_exception_degraded` is logged, then `overseer_runtime.watcher_restarting` (attempt number,
  delay) and the service restarts after 5 s, doubling to a 60 s cap; five minutes of healthy running resets the counter.
  `stopOverseerRuntime` cancels any pending restart and a rejection after an intentional stop never restarts.
- A HANG is not restarted. A loop that never settles raises the liveness alarm below and nothing else. Bounding or
  cancelling hung awaits is deliberately out of this change (see the follow-up work order).
- An independent liveness monitor (own `setInterval`, unref'd) compares the newest sweep progress stamp (pass
  start, heartbeat, each settled record, iteration end) to the clock. After 10 minutes of silence it logs
  `merge-coordinator.liveness_alarm` at error level on every check and posts ONE operator message per episode
  (`recipient: operator`, `priority: blocker`, via the same `createAuthenticatedMessage` path as the Taskmaster
  dead-man checker). A failed post retries on the next check. Fresh progress logs
  `merge-coordinator.liveness_recovered` and re-arms.
- Discovery is approved-first. Every listed PR is classified structurally every pass with zero GitHub calls and
  each non-candidate carries a named exclusion (`merge-coordinator.candidate_excluded`). Only approved PRs on a
  watched base consume the evidence budget (`OVERSEER_MERGE_DISCOVERY_MAX_PRS_PER_TICK`, default 100), rotated by
  the existing per-repo cursor, so an approved green PR is a candidate within one pass regardless of how many PRs
  are open. The heartbeat reports `prsClassified` (whole population) next to `prsEvaluated` (evidence budget).

Environment variables (all optional; defaults shown):

| Variable | Default | Meaning |
|---|---|---|
| `MERGE_SWEEP_LIVENESS_MAX_SILENCE_MS` | 600000 | Silence before the alarm; `0` disables the monitor |
| `MERGE_SWEEP_LIVENESS_CHECK_MS` | 60000 | How often the monitor checks |

Log tokens to grep in `docker logs archon-app-1`: `merge-coordinator.heartbeat_evaluated` (one per pass, should be
about one per minute), `overseer.delivery.iteration_failed_isolated`,
`overseer_runtime.watcher_restarting`, `merge-coordinator.liveness_alarm`, `merge-coordinator.liveness_recovered`.

Operator response to a liveness alarm message (or a `liveness_alarm` log line):

1. Confirm: `ssh hetzner-prod "docker logs --since 20m archon-app-1 2>&1 | grep -E 'merge-coordinator.heartbeat_evaluated|overseer_runtime.watcher' | tail -20"`.
2. If `watcher_restarting` lines are repeating, read the error on the preceding `watcher_exception_degraded` line and fix that cause (a database lock, a bad config).
3. If no heartbeat and no restart lines appear, the loop is hung (the alarm does not restart it): rebuild or restart `archon-app-1` under the standing harness rebuild rule.
4. After recovery a `merge-coordinator.liveness_recovered` line confirms the monitor re-armed.

Merging this code does not update the running source-copy container. XO must rebuild the container before the live outcome check.
