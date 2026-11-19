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

## Originating run evidence hold

Both merge paths use the same exported evidence gate in `merge-manager.ts`: the run-linked manager checks the provenance-bound `WatchedRunRecord.runId` before judging, and the verdict-driven bridge checks its resolved originating run immediately before the merge API call. A `node_failed` event for `manifest-evidence-check`, or a failed run whose failure names that node, holds with `originating_run_failed_evidence_gate`. A missing events reader or failed event lookup holds with `originating_run_unreadable`. The manager runtime resolves the run row before reading its events; the bridge retains the row from `store.getRunById(verdict.run_id)`. Both readers use `listRunEventsForOverseer`; the bridge wires it in `service.ts`. **Order of the bridge pass and at most one approval (bdc-xo#5358).** In `mergeClaimedVerdict` the evidence holds (run-less trace and run-bound check) now run BEFORE the merge slot is reserved and BEFORE any approval is posted. A held verdict therefore takes no slot and posts no approval on any pass; it only re-reads the run's events and, once per head SHA, posts the hold comment. Before this, every pass of a held verdict reserved a slot, posted a fresh empty APPROVED review and then found the hold (27 approvals in 15 minutes on one held PR, about 105 review calls an hour). The bridge also posts at most one approval per exact head SHA per ten minutes per GitHub client (an in-process memo): a pass that stops before the merge (a review still in flight, changes requested, a merge failure) does not post another. A new head is a new approval. The one review a held pull request keeps is the Overseer model review itself.

Run-less candidates (the provenance `no_run` case and bridge verdicts whose run id is `pr-discovery:`) are traced to the run that opened the pull request with `findOriginatingRunForPullRequest` (`originating-run-lookup.ts`, SQL in `listOriginatingRunCandidates`, wired in `service.ts` and `overseer-runtime.ts`). Two traces, most recent run wins: the PR head branch equals the tail of a run's own `working_path` (the agent pushed the run's worktree branch), or the PR URL appears in a run's `open-pr-if-needed` / `patch-pr-body` node output. The branch name is never parsed for a run id. No run found (a human PR) keeps the proceed-on-green rule. A found run that is not finished (`running`, `pending` or any non-terminal status) holds with `originating_run_in_progress`, because its evidence gate has not run yet: one comment per head SHA marked `<!-- merge-evidence-hold-in-progress:<head SHA> -->` saying `Merge held: originating run <run id> has not finished`, no label, and the hold lifts by itself when the run ends. A finished run then follows the failed-evidence rule above, including adjudication that names the current head SHA. A failing lookup holds with `originating_run_unreadable`. With no lookup wired (tests, older callers) the run-less path is unchanged. Anchor: 2026-11-10 canary run 4e6fefea, whose PR was opened from its worktree branch and merged on the run-less path five minutes before its evidence gate failed (bdc-harness 5308).

On an evidence hold the bridge releases its merge slot and calls its skip helper with the evidence reason. These two reasons release the verdict claim without a terminal outcome or a bounded transient retry. The hold reason is logged and visible on the PR. The next tick re-evaluates the same verdict, so a restored reader or valid adjudication can clear the hold without requeueing. Other skip classifications are unchanged.

The manager hold action and receipt record the same reason. Both paths use one shared poster: one author-bound comment per current head SHA, marked `<!-- merge-evidence-hold:<head SHA> -->`, and label `merge:held-evidence`. The failure comment contains `Merge held: originating run <run id> failed manifest-evidence-check` and the first 300 characters of the node error. An unreadable run instead says `Merge held: originating run <run id> unreadable` with the lookup error. Visibility failures are logged and never lift the hold. The label is informational; removing it cannot lift the hold, and adjudication does not remove it. For the manager, `hold-canary` makes no GitHub writes; `comment_findings` may post the hold comment but cannot apply labels or merge; execute mode with mutations disabled makes no GitHub writes. The bridge reaches its poster only after its existing service-enabled, emergency-stop, dry-run and merge-capability execution checks pass.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MERGE_MANAGER_EVIDENCE_ADJUDICATORS` | unset (nobody) | Comma-separated GitHub logins permitted to adjudicate a known evidence failure; whitespace is trimmed and logins are case-insensitive |

An allowlisted person lifts a known failure by posting a PR issue comment with this whole line (replace the SHA with the full current 40-character head SHA):

```text
Evidence-Adjudication: docs canary <current head SHA>
```

The reason and SHA must occur on the same line. An old or abbreviated SHA cannot authorize a new head. The run PR's builder author, the Review Gate login, the configured comment/Overseer and merge-manager identities, and every login ending in `[bot]` are rejected even if allowlisted. Unset or empty configuration permits nobody. Missing or unreadable comments do not authorize a merge. Unreadable run state cannot be adjudicated; restore the run/events reader first. Valid adjudication only clears this gate: the existing judge, exact-head approval, green checks, base policy and production holds still apply. Overseer verdict code is unchanged.

## Policy skip comment

When the bridge records a terminal POLICY skip with the pull request in hand, it posts ONE comment on that pull request saying why the merge manager will not merge it and that a person does (exact-head approval and green required checks still apply). Reasons covered: `spec_only` (documentation-only into a base whose `docsOnly` policy is skip), `integration_base_mismatch` and `base_not_allowlisted`. The skip itself is unchanged: same outcome row, still terminal, claimed once per run and head. `repo_not_allowed` has no pull request in hand at its skip sites, so it posts nothing and stays a silent skip.

The comment is three lines: the marker `<!-- merge-policy-skip:v1 -->`, a key line `<!-- merge-policy-skip-key:<verdict id>:<reason> -->`, and one plain sentence for the reason. It is idempotent: before posting, the bridge looks for a comment by its own author login that already carries the key line and posts nothing if found (a key line from another author does not count). A comment failure is logged as `merge-coordinator.policy_skip_comment_failed` and never changes the recorded skip or stops the cycle; a missing comment API logs `merge-coordinator.policy_skip_comment_unavailable`. A pull request that merges normally gets only the merge receipt, never this comment.

The interactive Duty Officer reads this marker: an approved, green, unmerged pull request carrying `merge-policy-skip:v1` was skipped on purpose, so the Duty Officer does not nudge the merge manager or report a stall, and cues the owner or the XO to merge it by hand once (skill file `Duty-Officer/SKILL.md`, rule under "A PR is stale, superseded, or unmerged?").

## Hourly merge ceiling and the `merge-queued` label

The merge manager reserves one merge slot per merge in durable storage before it merges. There is no global ceiling by default. `OVERSEER_MAX_MERGES_PER_HOUR` is an optional non-negative integer throttle: the number of merges in a rolling 60 minutes, counted across every repository and every kind of pull request (specs, diary rows and code alike). It is a separate budget from GitHub API calls. Unset or empty means no ceiling. A value that is not a non-negative integer falls back to four. Zero prevents merges. When a configured ceiling is full, a green, approved pull request is not stuck, it is queued: the verdict claim is released with `rate_ceiling_deferred` and each later pass tries again.

When a ceiling is configured, two signals say so on the pull request itself:

- a comment (marker `<!-- overseer:merge-ceiling-queued -->`) with the head, the queue position, the ceiling and the earliest next merge slot, posted once per head;
- the label `merge-queued`, added at the first deferral (one call, never one per pass; a PR that already carries it costs nothing) and removed by the bridge when it merges the PR. A pull request merged by hand keeps the label, which is cosmetic. The label is a signal only: nothing in the merge path treats it as a hold, and removing it does not release or hold anything.

Added 2026-11-12 after bdc-xo PR 5662 (position 5, earliest slot 17:02Z, merged by hand 16:56Z by someone who had read the log but not the comment). Both signals are best effort: a comment or label failure is logged (`merge-coordinator.ceiling_queue_notice_failed`, `merge-coordinator.queued_label_failed`, `merge-coordinator.queued_label_remove_failed`) and never changes the deferral or the merge.

Every queued pull request is noted, not only the head (bdc-xo#5697, 2026-11-12). Before this, a full ceiling stopped the sweep at the head of the queue, so only the head ever got the comment and the label and a pull request behind it looked stuck (bdc-xo 5685 was merged by hand on that misreading). Now, after the head is deferred and its notice posted, the sweep visits the remaining verdicts in note-only mode: it reads the pull request and, only when it is open, still on the verdict's head, not held (`merge-hold`, `run:blocked`, `owner:reworking`), with no blocking reported check, not conflicting, on a base the manager merges unattended and not a docs-only change under a skip policy, posts the same position comment and adds the label. It never claims the verdict, reserves a slot or merges. Limits: at most 10 reads per sweep (`QUEUE_NOTE_MAX_PER_SWEEP`), each noted verdict once per process, and a verdict that was read but is not eligible (held, stale, failing, conflicting, never merged unattended) or whose read failed is not read again for 5 minutes (`QUEUE_NOTE_RECHECK_MS`), so ineligible pull requests cannot use up the budget and starve eligible ones behind them; a long queue is labelled over a few ticks; the position in the comment is the one at the first note and is not updated as the queue moves. If the head's own notice fails to post, the sweep behaves as before (the next verdict is visited normally).

## Owner reworking label

A pull request label named exactly `owner:reworking` (case-sensitive) stops an otherwise mergeable pull request while its owner redoes the design. The bridge releases the verdict claim with the reason `owner_reworking_label` and logs `merge-coordinator.owner_reworking_label`, with no skip, no retry attempt and no outcome row, like `merge_hold_label`. Candidate discovery excludes the PR with the named exclusion `owner_reworking_label`, and the run-linked merge manager holds it with the same reason. Only the owner sets and clears the label; nothing in the harness does, and removing it lets the next tick merge through the existing guards. It is NOT HOLD: HOLD stays John's. `owner:reworking` is a state, not a person: owner routing never reads the suffix `reworking` as a login.

## Post-merge stray-push alert

A squash merge lands the head the Overseer approved. If the PR branch still exists afterwards at a different sha, someone pushed after the merge and that work never reached the base branch. The post-merge sweep (`packages/overseer/src/post-merge-stray-sweep.ts`) finds those branches for merges by any path: it lists, from GitHub, the pull requests merged in the last 7 days in every repository the merge policy covers, and reads each PR's head branch ref (in the head repository, so a fork PR is read in the fork). When the ref exists at a sha other than the merged head it raises ONE operator card through the existing escalation path (`runEscalation`: owner routing, delivery jobs), naming the PR, the branch and the stray sha. No alert when the branch is gone (404) or still at the merged head, and none when GitHub cannot be read (any other error, or a deleted fork).

- Merges by any path: the candidate list is GitHub's own merged list keyed on `merged_at`, not the bridge's or the merge manager's records, so a spec-landing lane merge, a hand merge, a bridge merge and a run-linked manager merge are all covered. GitHub keeps `head.sha` at the merged head while the branch moves, so no event-store row is read.
- Repositories: every repository in the merge policy (`DEFAULT_MERGE_REPO_POLICY`, or `MERGE_MANAGER_REPO_POLICY` when set) plus `OVERSEER_MERGE_DISCOVERY_REPOS`, each once. Paging: closed PRs sorted by updated descending, stopping when a page is short or wholly older than the window, at most 10 pages per repository. Reaching the cap logs `overseer.post_merge_sweep.page_cap_reached` and never raises an alert; a repository that cannot be listed logs `overseer.post_merge_sweep.list_failed` and is skipped.
- Once per PR and stray sha: the card id is derived from the event identity: run id `post-merge-sweep:<owner>/<repo>#<n>`, source event `post-merge-stray:<owner>/<repo>#<n>:<stray sha>` and the PR's `merged_at` as the event time. The sweep looks the card up before escalating, and card insert is `ON CONFLICT DO NOTHING`. A second push after an alert gives a new stray sha and a new card. No new table and no migration.
- Work id: the first WO id in the PR title (then the head branch). A PR with no WO token gets the work id `PR-<owner>/<repo>#<n>`, so owner routing reports it unowned (a person assigns an owner); expect many unowned cards for direct merges.
- Log tokens: `merge-sweep.stray_push_alert` (one per new card), `overseer.post_merge_sweep.tick` (per sweep: examined, alerted, alreadyAlerted, noStray, unreadable), `overseer.post_merge_sweep.page_cap_reached`, `overseer.post_merge_sweep.list_failed`, `overseer.post_merge_sweep.iteration_failed_isolated` and `overseer.post_merge_sweep.bind_failed`.
- Off by default in code. Set `OVERSEER_POST_MERGE_SWEEP=1` (or `true`, `yes`) on archon-app-1 to run it; it then runs hourly. Alerts are addressed to the work owner when `OVERSEER_OWNER_ROUTING=on`, and to the acting XO otherwise.
- Earlier version: until WO-HARNESS-POST-MERGE-SWEEP-COVERAGE-01 the candidates were only the bridge's `overseer_verdicts` rows (`action_reason = 'merge_executed'`), about 55 percent of merges; that source remains only as a test seam (`listMerged`).

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
| `thinmansoftware/comicstoreos-provisioner` | `main` | yes | skip |

`release/lspro`, `release/ce`, `main` and `master` are production lanes and are never unattended candidates: `release/*` has no entry at all.

The provisioner row (WO-HARNESS-MERGE-POLICY-PROVISIONER-AND-REPO-SKIP-LINE-01, bdc-xo#5581) holds ONLY while merging to its `main` deploys nothing but the staging Vercel project `comicstoreos-provisioner-staging` (evidence: bdc-xo#5576 comment 6810214724, read 2026-11-11 23:58Z: one linked Vercel project, the GitHub "Production" deployments point at the staging project, no workflow runs `vercel deploy`, `--prod`, `ssh` or `docker push`). If a production provisioner project, domain or workflow ever deploys from `main`, first move that base to `COVERED_PRODUCTION_BASES` in `packages/overseer/src/m09-promotion-gate.ts` and set its entry to `unattended: false`; the guard test `production_bases_match_merge_policy` fails when the two tables disagree.

### The environment value ADDS to the default

`MERGE_MANAGER_REPO_POLICY` no longer replaces the default policy: a parseable value is merged OVER `DEFAULT_MERGE_REPO_POLICY` per repository. A repository in the default and absent from the value keeps its default entry, so a repository added to the code default (the provisioner) ships with the next rebuild without editing the host. A repository present in the value replaces that repository's default entry; `{"owner/repo":{}}` lists a repository with no bases, so nothing is allowed for it. A malformed value is still the EMPTY policy (fail closed): a configuration error never broadens merge authority.

### A skipped repository is a warning that names it

When an Overseer-approved verdict is skipped because its repository has no policy entry, the bridge records `repo_not_allowed` as before and logs `merge-coordinator.merge_skipped` at WARN (it was info) with `owner`, `repo`, `prNumber` (run-less verdicts), `verdictId`, `env: MERGE_MANAGER_REPO_POLICY` and `hint: add_repo_to_merge_policy`, once per verdict id per process (a replay of the same verdict stays info). Read it with `docker logs archon-app-1 --since 1h 2>&1 | grep merge_skipped | grep repo_not_allowed`. The fix is to add the repository to the in-code default in `packages/overseer/src/merge-repo-policy.ts` (not to the host environment).

### FALLBACK ONLY, ask-first (John): host environment edit after this lands on dev (not part of the code change; since the environment value is additive, a repository added to the code default does not need it)

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
