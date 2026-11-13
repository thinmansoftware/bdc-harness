# GitHub call sites: which endpoints spend the hourly quota

The harness meters GitHub calls per service and hour in `github_api_usage` (and the pool's remaining quota in `github_api_pool_state`). Neither says which call spends them. The `github_call_sites` log line does (bdc-xo#5449).

## What the log line holds

Every time the meter flushes (about once a minute while calls are being made, and at once after a rate-limited response) the server process logs one line (CLI scripts do not: the line goes to stdout, where scripts print JSON), module `github/metering`, message `github_call_sites`:

| Field | Meaning |
|---|---|
| `intervalMs` | Time since the previous line (the counting interval) |
| `total` | Calls counted in that interval, all services |
| `byService` | The same total split by service (overseer, taskmaster, duty_officer, merge_manager, run_nodes, smart_cauldron, pr_discovery) |
| `top` | Up to 25 rows, most calls first: `service`, `pool`, `endpoint`, `calls`, `rateLimited` |

`endpoint` is `METHOD /route`: the host and query are removed, `/repos/<owner>/<repo>/` becomes `/repos/{o}/{r}/`, numeric segments become `:n` and 40-hex shas become `:sha`. Octokit calls arrive as route templates (`GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`). `gh` CLI calls arrive from the `GH_DEBUG=api` trace the same way, or as `cli:<command and first two arguments>` when no trace came back. A call that was not labelled is counted as `unlabelled`.

## Sum an hour per service and endpoint

From an operator machine with `jq` (the Archon host has no `jq`, so only `docker logs` runs there), over the last 60 minutes:

```bash
ssh hetzner-prod 'docker logs archon-app-1 --since 60m 2>&1' | grep github_call_sites | sed 's/^[^{]*//' | jq -s '[.[] | .top[]] | group_by([.service, .endpoint]) | map({service: .[0].service, endpoint: .[0].endpoint, calls: (map(.calls) | add)}) | sort_by(-.calls) | .[0:20]'
```

The total attributed in the hour:

```bash
ssh hetzner-prod 'docker logs archon-app-1 --since 60m 2>&1' | grep github_call_sites | sed 's/^[^{]*//' | jq -s 'map(.total) | add'
```

Compare it with the metered figure: `SELECT service, SUM(calls) FROM github_api_usage WHERE hour_bucket = '<hour>' GROUP BY service` through `scripts/cauldron/inspect-run.ps1 -Sql`.

## The Overseer baseline of 2026-11-11 and what moved (WO-HARNESS-OVERSEER-GITHUB-READ-BUDGET-01, bdc-xo#5571)

Baseline, from the `github_call_sites` lines of archon-app-1 for 19:16:12Z to 20:16:12Z (59 one-minute lines): overseer 11,863 calls an hour of 12,142 in total (pool `app-4574893-153295654` 11,851, `user-pat` 12), of them 225 installation-token mints (`POST /app/installations/{installation_id}/access_tokens`). The pool's core limit is 15,000 an hour. Target for the whole work order: overseer below 6,000 calls and below 30 mints in one fixed hour with no container restart.

Two spellings of the same endpoint are two kinds of caller, not one: a route written with braces (`/repos/{owner}/{repo}/pulls/{pull_number}`) is an Octokit client with the metering hooks (`attachGitHubQuotaHooks`); a route written `{o}/{r}/pulls/:n` is a request that reached the meter with the real URL: the reconcile pass's Octokit (`packages/overseer/src/reconcile.ts`, `getOctokit`, which sends every request through `serviceGitHubFetch`) and the second and later pages of paginated lists.

Finding 3, mints (done in the first pull request of this work order): `createRealOctokitClient` and `createRealMergeOctokitClient` return ONE shared client per identity (service, identity kind, pool and a fingerprint of the credential). `createAppAuth` keeps the installation token in its own client, so a client built per call minted a token on its first request; the shared client mints once per token lifetime (about an hour) and refreshes itself. The review and merge identities keep separate clients (M-153); a rotated key or token gets a new client. Expect the one-hour mint count to fall from 225 to about 2 per process start (one per service identity). Measure it with the one-hour command above, fixed timestamps, at least 55 lines, no restart inside the hour.

Measured 2026-11-12 (hour 01:15Z to 02:15Z, after part 1): the Overseer made 13,991 calls (93 percent of the 15,000 pool, up from 11,863), mints 1. The rise is the interpolated spelling: `GET /repos/{o}/{r}/pulls/:n` 4,654 (+1,826 on the baseline) and `GET /repos/{o}/{r}/issues` 1,064 (+608), the reconcile pass (`reconcile.ts`, `getOctokit`).

Part 2 (static, from code reading; the live effect is measured after the next rebuild): `searchMergedPullRequestsPaged` runs five org-wide searches over the last 7 days of merged pull requests on every reconcile run and read each hit with `pulls.get`; it now keeps a cross-run cache of the merged pull request details keyed by repository and number and valid only while the search item's `updated_at` is unchanged (bounded to 5,000 entries; unmerged pull requests and items with no `updated_at` are never cached), and `listPullRequestFilePaths` keeps a cache of a merged pull request's changed files keyed by repository, number and merge commit (bounded to 2,000; truncated reads and pull requests without a merge commit are never cached). Expected effect: the `pulls/:n` and `pulls/:n/files` interpolated rows fall to the number of NEW or changed merged pull requests per run instead of every pull request of the 7-day window. Not in part 2: the tracker issue scan (`GET /repos/{o}/{r}/issues`, 1,064 an hour; `readTrackerIssueSnapshot`), the open pull request list pagination and the review-path template reads; they are the next cut, aimed by the post-rebuild hour.

## Limits

- The counts live in memory and in the container log. A rebuild or recreate wipes the log, so measure after a rebuild, not across one.
- Only the top 25 endpoints per interval are logged; the rest are in `total` and `byService` but not named.
- The endpoint names the call, not the code that made it. Find the code with a search for the route (for example `pulls.listReviews`).
- No cut, cache or interval is changed by this counter. It exists so a cut is aimed at a measured spender.

## Reconcile per-pass sharing and call counts (bdc-xo#5571 part 3, 2026-11-12)

Measured after PR 1578 went live (hour 15:02Z to 16:03Z): the Overseer made 8,549 calls (8,693 an hour, from 11,608), reconcile `pulls/:n` fell from 3,887 to 301, but the reconcile spelling `GET /repos/{o}/{r}/pulls` rose from 866 to 1,580 and `GET /repos/{o}/{r}/issues` from 798 to 1,288. The pull list is read from the code, not yet proven: the supersede pass asked for the repository's OPEN pull requests once PER MERGED pull request that carries WO stems, inside one pass.

Change: `runReconcileOnce` now shares the open-PR list of a repository across the merged pull requests of ONE pass (a pull request closed earlier in the pass is hidden from the shared list so it cannot be matched again), and logs one line per pass, `overseer.reconcile.call_counts`, with `counts`:

| key | meaning |
|---|---|
| `calls:<dependency>` | how many times the pass called that dependency (`searchMergedPullRequests`, `findTrackerIssueByStem`, `listPullRequestFiles`, `closePullRequest`, ...) |
| `open_pr_list:reads` / `open_pr_list:cache_hits` | repository open-PR lists that reached GitHub vs answered from the pass cache; `calls:listOpenPullRequestsInRepo` is their sum |
| `pages:<reader>` | GitHub pages read per reader: `open_prs_in_repo`, `merged_trackers`, `tracker_close_events`, `tracker_comments`, `merged_pr_files` |

How to read it (after the rebuild that carries it): `ssh hetzner-prod 'docker logs archon-app-1 --since 60m 2>&1 | grep overseer.reconcile.call_counts'`. Compare the sum of `pages:*` per hour with the `github_call_sites` lines for the reconcile spellings to attribute them; `open_pr_list:cache_hits` shows what the sharing removed. The tracker snapshot (`findTrackerIssueByStem`) was already shared per pass.

## Tracker snapshot is incremental (bdc-xo#5701, 2026-11-12)

Measured on e3d9bcd7e (30-minute and 60-minute readings, container started 19:44:58Z): `GET /repos/{o}/{r}/issues` was the top Overseer site, 855 calls in 29 minutes and 1,805 in 59 minutes, exactly 57 per reconcile pass: `readTrackerIssueSnapshot` (`reconcile.ts`) listed every issue and pull request of `thinmansoftware/bdc-xo` (5,695 at 20:19Z, 100 per page) on every pass, and failed closed at 100 pages (10,000 items).

Now the snapshot is kept for the life of the process: the first pass (and every 6 hours, and after an incremental read that needs more than 20 pages) does a full scan with a 400-page budget; every other pass reads only the issues updated since the previous refresh (`since`, 120 s overlap, `sort=updated`) and merges them into the cache, which is a handful of pages. Expected rate after the first pass: about 1 to 3 calls per pass instead of 57 (the issues site falls from about 1,800 an hour to about 100). Counters in `overseer.reconcile.call_counts`: `pages:tracker_snapshot_full`, `pages:tracker_snapshot_incremental`, `tracker_snapshot:full`, `tracker_snapshot:incremental`.

Permitted staleness: an issue or pull request deleted or transferred out of bdc-xo stays in the cache until the next full scan (at most 6 hours). A read error leaves the cache untouched and fails the pass closed as before.

Alerts: at 320 pages (32,000 items) the full scan logs `overseer.reconcile.tracker_snapshot_near_budget` and sends one operator alert naming the exact count; if the 400-page budget is hit the pass fails closed, logs `overseer.reconcile.tracker_snapshot_page_budget_exceeded` (with `severity: error`; the reconcile logger has no error level) and sends one operator alert naming the observed lower bound (`at least 40000 items read`, never an exact total it could not read). At most one alert of each kind per process per 6 hours.
