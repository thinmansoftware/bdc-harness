# rebuild-xo.sh: the XO's drain-gated rebuild of archon-app-1

`scripts/xo/rebuild-xo.sh` rebuilds the harness container (`archon-app-1`) to the tip of `origin/dev`. It is the XO's standing harness-rebuild path (the one container the XO may rebuild on its own authority, by the recorded plan). Before bdc-xo#5444 it lived only on the host at `/opt/bdc/scripts/xo/rebuild-xo.sh`; this copy is the reviewed one. The host copy is replaced from this file by an operator step after merge.

## When to use it

When merged harness code is not yet running in the container (compare `git rev-parse --short HEAD` in `/opt/bdc/archon` with `origin/dev`) and no Cauldron runs are active. For a rebuild that also runs a list of purpose checks and a canary, bdc-xo's `scripts/harness/rebuild-batch.sh` is the fuller path.

## Usage

```bash
bash /opt/bdc/scripts/xo/rebuild-xo.sh [max_wait_minutes]
```

Steps, in order: drain on; wait for zero active runs (default 120 minutes); disk at least 15G free; clean tree; database backup; pin the current image as `archon:rollback-<stamp>`; fetch and check out `origin/dev`; build; warm the directory cache (W); up; health wait (up to 360 seconds); serve lanes; drain off; prune old backups and pins.

Test overrides (not needed on the host): `ARCHON_DIR`, `DB`, `SCRIPTS_DIR`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Rebuilt and healthy |
| 2 | No archon checkout at `ARCHON_DIR` |
| 3 | Stopped before the build, nothing replaced: drain not confirmed (`ABORT_DRAIN`: the drain POST must return HTTP 200 and a GET must show a mode other than normal), the drain API never reported `drained` (it counts pending, running, waiting_provider and paused runs and live leases) within the wait, a failed `git fetch` (`ABORT_FETCH`: a stale local `origin/dev` is never built), low disk, dirty tree, no database backup (`ABORT_BACKUP`), no rollback image pinned (`ABORT_PIN`), or checkout failed. Drain is switched off again |
| 6 | The new container is up and healthy but the lanes could not be published and verified identical (`ABORT_LANES`: the lane sync failed, a baked lane still differs from the served one, or nothing could be compared). Drain is left ON so no work starts on stale lanes; fix, run `serve-lanes.sh --apply`, then clear drain |
| 7 | Drain would not read back as normal after the rebuild (`DRAIN_STUCK`: every fire is refused until it is cleared) |
| 8 | The rollback itself failed, or the restored container is not healthy (`ROLLBACK_FAILED`; each failed step prints `ROLLBACK_STEP_FAILED: ...`). Drain is left ON so no work starts on a broken container; fix it, then clear drain by hand. Exit 4 means the rollback worked, the restored container is healthy (health and the workflows API are checked) and drain was cleared. |
| 4 | `docker compose up` failed, or the new container was not healthy; the pinned image was restored and the checkout put back on the starting commit |
| 5 | The image BUILD FAILED. The output has `ABORT_BUILD rc=<n>`. The old container is still running, the checkout is put back on the commit it started from, drain is switched off. Nothing was replaced |

Before bdc-xo#5444 a failed build was piped through `tail`, so the script carried on, ran `up -d` on the old image and passed the health gate. Exit 5 is the guard against that. The Overseer review of the pull request found three more silent carry-ons of the same kind, now guarded the same way: an unconfirmed drain, a missing backup or pin, and a failed `up` that left the old container looking healthy. A second review found three more: an idle gate narrower than the drain API's own (it ignored waiting_provider and paused runs), an ignored `git fetch` failure, and ignored failures of the lane publication and of the final undrain.

## Rollback

```bash
docker tag archon:rollback-<stamp> archon:latest && cd /opt/bdc/archon && git checkout -q --detach <previous sha> && docker compose up -d --no-build --force-recreate app
```

The previous sha and the stamp are printed by the script at the pin and fetch steps.

## Boot evidence and the cold-cache walk (WO-HARNESS-BOOT-CHOWN-WALK-AND-REBUILD-EVIDENCE-01)

On 2026-11-13 two rebuilds hung before the container printed a single line and were rolled back (bdc-xo #5970). The entrypoint's ownership check walks `/.archon` and `/home/appuser` on every start; on a cold cache, right after the image build, walking the ~1.5M run-workspace entries outlasted the health window. Now:

- The ownership check prunes `/.archon/workspaces` below its top two levels (those two levels are still checked and fixed), and prints `[archon] ownership check: <dir> ...` before each walk and `... done in <N>s` after it, so a slow walk shows in `docker logs`.
- **W: warm directory cache** runs `sudo timeout 600 find /opt/bdc/archon-data /opt/bdc/archon-user-home -xdev` just before `up` and prints its duration. A timeout or error is printed and never aborts the rebuild.
- **V** waits up to 360 seconds. Docker's `unhealthy` does not end the wait (Docker keeps checking); only `healthy`, a restart count above 1, or the bound do.
- **Before any rollback** the script saves `docker logs --timestamps archon-app-1`, the health log and `docker top archon-app-1` to `$HOME/rebuild-fail-<stamp>.log`, `.health.json` and `.top.txt` (or `$REBUILD_FAIL_DIR` when set) and prints the three paths. The rollback removes the container and its output, so read these files first when a rebuild exits 4.
- **P4** checks the backup with `sudo test -s`, and the backup **prune** runs inside one `sudo sh -c` with the folder as an argument: `/opt/bdc/archon-data` is mode 750 owned by the app user, so a plain `[ -s ]` or `ls` as the ssh user saw nothing (bdc-xo #6097).

## Keys are not part of a build

The GitHub App private keys live in `/opt/bdc/archon/secrets/`, which is inside the build context. `.dockerignore` and `.gitignore` both list `secrets/` and `*.private-key.pem` so they cannot be copied into an image layer or staged by `git add -A`. Check: `git check-ignore -q secrets/thinman-overseer-app.private-key.pem` exits 0.

## serve-lanes.sh

`scripts/xo/serve-lanes.sh` (also moved into the repo from the host, unchanged) compares the lane YAML files served from the `/.archon/workflows` volume with the baked defaults in the running image. Run with no argument it prints `<file> SAME` or `<file> DIFFERS` for each `bdc-feature-development*.yaml`; with `--apply` it copies the baked file over the served one wherever they differ. `rebuild-xo.sh` runs it after a healthy rebuild. A served file with the same name as a baked default shadows it (the engine prefers the volume), so a served copy that differs from the image is the stale-lane case this script repairs; a served copy identical to the baked file is harmless.
