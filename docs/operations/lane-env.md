# Lane environment: no personal GitHub token

A "lane" is any process that runs agent- or workflow-authored code: a workflow `bash` or `script` node, the Claude, Codex or cursor-agent CLI, the Grok bash tool, the pi bash tool. Since bdc-xo#5464 (WO-HARNESS-LANE-NO-PERSONAL-TOKEN-ENV-01) a lane child starts without the personal GitHub token of the human account.

## What is removed

`laneEnv()` in `@archon/paths` (`packages/paths/src/lane-env.ts`) removes these names from the environment a lane child inherits, and `stripPersonalTokens()` removes them from anything a caller adds (request env, project env):

| Name | What it held |
|---|---|
| `GH_TOKEN`, `GITHUB_TOKEN`, `MERGE_MANAGER_GH_TOKEN` | the same personal token (type `ghp_`, login `bluedevilcollectibles`) |
| `GH_AUTH_TOKEN_INTERNAL` | the same token, an alias the entrypoint exports |
| `ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN` | a copy the `gh` wrapper builds for its permission fallback |

It also sets `ARCHON_GITHUB_NO_PERMISSION_FALLBACK=1`, so a GitHub App permission error fails closed.

## How lanes still reach GitHub

- `gh`: `/usr/local/bin/gh` is the merge-guard shim (bdc-xo#1491). It blocks merge verbs and runs every other call through `scripts/github-service-exec.ts run_nodes`, which mints a builder-2 installation token from the App variables (`GITHUB_APP_RUN_NODES_*`, kept in the lane environment).
- `git push` and clones: the global credential helper `bun /app/scripts/github-service-token.ts run_nodes` mints the same builder-2 token.

Probe, run inside the container as the lane user with the five names removed (all read-only):

```bash
env -u GH_TOKEN -u GITHUB_TOKEN -u MERGE_MANAGER_GH_TOKEN -u GH_AUTH_TOKEN_INTERNAL -u ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN ARCHON_GITHUB_NO_PERMISSION_FALLBACK=1 \
  sh -c 'gh pr list --repo thinmansoftware/bdc-harness --limit 2; git ls-remote https://github.com/thinmansoftware/bdc-xo.git refs/heads/main; gh pr merge 1 --repo thinmansoftware/bdc-xo'
```

Expected: the list and the ref print, and the merge is blocked by the guard (`gh-merge-guard: BLOCKED`).

## The one behavior change

A `gh` call that the builder-2 App is not allowed to make (for example `gh api /user`, which needs a user token) used to succeed through the personal-token fallback. It now fails with `Resource not accessible by integration`. Measured before the change (github_api_usage, `run_nodes`): 30,160 calls through the builder-2 pool and none used the fallback; 169 fallbacks in all history, 5 of them on 2026-11-10 and 11-11.

## What this does NOT fix

The server's own environment still holds the token and is readable by the lane user through `/proc/<pid>/environ` until the lane uid split (bdc-xo#5455). The token is not rotated or changed here; that is John's decision.

## Where the helper is applied

Check the sites with `bun test ./scripts/lane-env-guard.test.ts`. It lists: the workflow bash node, script node, loop `until` bash and evidence commands in `dag-executor.ts`; the Claude, Codex and cursor-agent children; the Grok bash tool; the pi bash tool.
