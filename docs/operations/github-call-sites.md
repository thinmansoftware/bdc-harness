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

## Limits

- The counts live in memory and in the container log. A rebuild or recreate wipes the log, so measure after a rebuild, not across one.
- Only the top 25 endpoints per interval are logged; the rest are in `total` and `byService` but not named.
- The endpoint names the call, not the code that made it. Find the code with a search for the route (for example `pulls.listReviews`).
- No cut, cache or interval is changed by this counter. It exists so a cut is aimed at a measured spender.
