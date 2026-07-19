# n8n-health CI suite

Git-tracked source of truth for the n8n webhook health suite that runs on the
Hetzner CI host. Previously this script lived only at `/opt/bdc/ci/n8n-health.js`
with no git history; it now lives here and is deployed from here.

- **WO:** `WO-INFRA-N8N-HEALTH-ALERT-DEDUP-AND-DB-FIX-01`
- **Original suite:** `WO-INFRA-N8N-HEALTH-TESTS-01`

## What it does

Runs 5 health test cases against n8n webhook endpoints (health-check logic
unchanged by this WO):

1. `license/validate` valid ELITE tenant
2. `license/validate` valid STARTER tenant (with fixture self-heal)
3. `license/validate` new tenant auto-registers as TRIALING
4. `license/validate` empty body returns a structured error (not 500)
5. workflow active check for `lsp-license-validate`

## Host layout (Hetzner)

| Path | Purpose |
| --- | --- |
| `/opt/bdc/ci/n8n-health.js` | Deployed copy (from `scripts/ci/n8n-health.js`) |
| `/opt/bdc/ci/.env` | systemd `EnvironmentFile` (secrets/config; not in git) |
| `/opt/bdc/ci/.n8n-health-last-alert.json` | Alert-dedup state (runtime, not in git) |
| `/opt/bdc/ci/health-results.jsonl` | Append-only results log (runtime, not in git) |
| `/etc/systemd/system/bdc-n8n-health.timer` | Fires every 6 hours |
| `/etc/systemd/system/bdc-n8n-health.service` | Oneshot that runs `node /opt/bdc/ci/n8n-health.js` |

The suite runs as a systemd **oneshot** (no persistent process), so any
cross-run state (last-alerted failure) is file-backed, not in-memory.

## Environment variables consumed

| Var | Default | Purpose |
| --- | --- | --- |
| `ALERT_URL` | admin-notify webhook | Where failure/recovery notices are POSTed |
| `N8N_WH_BASE` | `https://n8n.bluedevilcollectibles.com` | Webhook base for license/validate |
| `N8N_BASE` | `http://localhost:5678` | n8n API base for the workflow-active check |
| `N8N_API_KEY` | (empty) | n8n API key for the workflow-active check |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | (required for tenant cleanup + STARTER self-heal) | PROD Supabase (project `aqat`) REST access |
| `HEALTH_STATE_FILE` | `<scriptdir>/.n8n-health-last-alert.json` | Alert-dedup state file path |
| `HEALTH_RESULTS_LOG` | `<scriptdir>/health-results.jsonl` | Results log path |
| `HEALTH_REALERT_INTERVAL_MS` | `86400000` (24h) | Re-alert window for an unchanged persistent failure |

> The former Postgres vars (`PG_HOST`/`PG_PORT`/`PG_USER`/`PG_DB`/`PG_PASS`) and
> the `pg` dependency were **removed** -- see "Results persistence" below.

## Alert deduplication (Bug 1 fix)

Prior behavior: `sendAlert()` fired on **every** 6-hour run while any failure
persisted, generating a new unread email each cycle (91 unread "CI ALERT"
emails accumulated 2026-05-13..07-19).

New behavior -- a notification is only sent when:

- **new-failure** -- the suite transitions from all-passing to failing;
- **changed-failure** -- the set of failing test cases differs from the last
  alerted set;
- **re-alert** -- the SAME failing set is still broken and the re-alert
  interval (default 24h) has elapsed since the last alert (a "still broken"
  reminder, not once-per-6h);
- **recovery** -- the suite returns to all-passing after a prior failure was
  alerted; exactly **one** recovery notice is sent, then it stays silent.

The "failure signature" is a sha256 of the sorted list of failing test-case
names, persisted in `HEALTH_STATE_FILE` alongside the last alert timestamp.
The decision logic (`decideNotification`) is a pure function and is unit-tested.

## Results persistence (Bug 2 fix)

Prior behavior: `writeResults()` connected to a decommissioned DevilSync
Postgres host (`127.0.0.1:5433`) and logged `ECONNREFUSED` on every run since
the 2026-04-29 Supabase migration -- the `health_results` table never received
a row. The alert email even pointed operators at that non-existent table.

New behavior: results are appended as one JSON object per line to
`HEALTH_RESULTS_LOG` (`/opt/bdc/ci/health-results.jsonl`). The `pg` dependency
is gone. The alert/recovery emails now point at the JSONL log.

## Tests

```bash
# Standalone -- NOT part of `bun run test` (that is workspace-scoped to packages/*)
bun test scripts/ci/n8n-health.test.ts
```

The tests cover the dedup decision matrix (Tests 1-3) and JSON-lines
persistence read-back (Test 4) using temp files -- no live host or network.

> **Known CI-wiring gap:** `scripts/ci/n8n-health.test.ts` is not run
> automatically by `bun run test` / `bun run validate` because those are
> workspace-scoped to `packages/*`. This is a pre-existing repo-wide gap that
> also affects `scripts/dispatch-worker` and `scripts/staging`; wiring the
> whole `scripts/` tree into CI is out of scope for this WO.

## Deploy

Deploy is a **production mutation** on the Hetzner host and requires John's
explicit approval. It is not run from CI.

```bash
# From a machine with SSH access to the CI host, after John approves:
scripts/ci/deploy-n8n-health.sh
```

The script `scp`s `n8n-health.js` to `/opt/bdc/ci/`, verifies the deployed copy
matches the git-tracked source, restarts `bdc-n8n-health.service`, and prints
recent logs. Only `n8n-health.js` is deployed; the host runs it directly as
CommonJS (no `package.json` needed on the host). The repo-local
`scripts/ci/package.json` (`{"type":"commonjs"}`) exists only so repo tooling
under the root `"type":"module"` treats the file correctly.
