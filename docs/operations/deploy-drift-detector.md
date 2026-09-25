# Deploy drift detector

The Duty Officer clock runs a zero-LLM check that the `archon-app-1` container is
actually running the `bdc-harness` commit merged to `dev`, and that served home
workflow files which share a name with a baked default have the same sha256.

It reports. It does not rebuild, restart, or copy lane files.

## What it detects

- **behind_dev**: `ARCHON_BUILD_SHA` is an ancestor of the target branch head.
  Drift age is the committer date of the oldest undeployed commit, so a restart
  does not reset the grace clock.
- **running_not_on_dev**: the running SHA has diverged from the target branch, or
  the target branch does not contain it.
- **build_sha_unknown**: the image was not stamped with a 40-character lowercase
  hex SHA (the historical default is the literal `unknown`). No GitHub call is made.
- **served_lane_differs**: a filename present in both the baked defaults directory
  and the served home workflows directory has a different sha256. Served-only and
  baked-only files are ignored.

Within `DUTY_OFFICER_DEPLOY_DRIFT_GRACE_MS` the verdict is `drift_in_grace` and no
Dispatch message is sent. After grace, exactly one Dispatch message is sent per
episode. A later tick in the same process does not send again. After a restart,
Dispatch idempotency keeps the same key from inserting a second row. When the
check returns to `in_sync`, that episode's key is forgotten so a later episode
can alert.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DUTY_OFFICER_DEPLOY_DRIFT_ENABLED` | unset (enabled) | `false` skips every read and returns `disabled`. |
| `DUTY_OFFICER_DEPLOY_DRIFT_REPO` | `thinmansoftware/bdc-harness` | GitHub repo whose branch head is the deploy target. |
| `DUTY_OFFICER_DEPLOY_DRIFT_BRANCH` | `dev` | Branch read via the commits API. |
| `DUTY_OFFICER_DEPLOY_DRIFT_GRACE_MS` | `7200000` | How long drift may exist before an alert (2 hours). |
| `DUTY_OFFICER_DEPLOY_DRIFT_INTERVAL_MS` | `1800000` | Minimum time between detector runs (30 minutes). |
| `DUTY_OFFICER_DEPLOY_DRIFT_TIMEOUT_MS` | `30000` | Per-tick deadline for the detector. |
| `DUTY_OFFICER_DEPLOY_DRIFT_RECIPIENT` | `xo` | Dispatch recipient of the alert. |

GitHub reads use `GH_TOKEN` or `GITHUB_TOKEN`, the same token as the rest of the Duty Officer clock.

## Alert body

`behind_by` is the GitHub compare `ahead_by` for `behind_dev` (commits on the target that are not in the running SHA). For `running_not_on_dev`, the detector performs a reverse comparison from the target SHA to the running SHA so the count and commit evidence both describe commits on the running side. `undeployed_prs` lists at most 20 pull requests. Further PR commits and commits omitted from the compare response are counted in `commits_without_pr`, so `undeployed_prs.length + commits_without_pr` equals `behind_by`.

`task_type` is `agent_message`, `priority` is `normal`, and `body` is JSON:

```json
{
  "kind": "deploy_drift",
  "reason": "behind_dev",
  "running_sha": "<40 hex or unknown>",
  "target_sha": "<40 hex or null>",
  "target_branch": "dev",
  "behind_by": 3,
  "undeployed_prs": [{ "number": 901, "title": "Fix x (#901)" }],
  "commits_without_pr": 1,
  "oldest_undeployed_at": "2026-09-24T09:00:00.000Z",
  "differing_lanes": [],
  "grace_ms": 7200000,
  "detected_at": "2026-09-24T12:00:00.000Z",
  "next_step": "Rebuild archon-app-1 through the proven rebuild path with scripts/container/build-app-image.sh. This detector does not rebuild."
}
```

Idempotency keys:

- `do-clock:deploy-drift:<first 12 of running sha>:<first 12 of target sha>` for `behind_dev` and `running_not_on_dev`
- `do-clock:deploy-drift:build-sha-unknown:<process start time>`
- `do-clock:lane-drift:<first 12 of running sha>:<first 12 hex of the drifted lane digest>`

## Reading status

The clock worker row stores the latest verdict. On the host database:

```bash
sqlite3 /opt/bdc/archon-data/archon.db "select json_extract(capabilities,'$.deploy_drift.verdict') from agent_dispatch_workers where worker_id='duty-officer-clock'"
```

`in_sync` means the running SHA matches the target head and no shared lane file differs.
`deploy_drift.last_error` is set when GitHub could not be read; that tick does not alert.

## Rebuilds

Images must be built with `scripts/container/build-app-image.sh`. The wrapper refuses
a dirty tree (exit 3, the word `DIRTY`) and exports `ARCHON_BUILD_SHA` from
`git rev-parse HEAD` before `docker compose build`. A compose build that does not
go through `build-app-image.sh` leaves `ARCHON_BUILD_SHA=unknown`, and this detector
will alert once the process has been up longer than the grace period.
