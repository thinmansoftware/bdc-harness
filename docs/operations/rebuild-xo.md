# rebuild-xo.sh: the XO's drain-gated rebuild of archon-app-1

`scripts/xo/rebuild-xo.sh` rebuilds the harness container (`archon-app-1`) to the tip of `origin/dev`. It is the XO's standing harness-rebuild path (the one container the XO may rebuild on its own authority, by the recorded plan). Before bdc-xo#5444 it lived only on the host at `/opt/bdc/scripts/xo/rebuild-xo.sh`; this copy is the reviewed one. The host copy is replaced from this file by an operator step after merge.

## When to use it

When merged harness code is not yet running in the container (compare `git rev-parse --short HEAD` in `/opt/bdc/archon` with `origin/dev`) and no Cauldron runs are active. For a rebuild that also runs a list of purpose checks and a canary, bdc-xo's `scripts/harness/rebuild-batch.sh` is the fuller path.

## Usage

```bash
bash /opt/bdc/scripts/xo/rebuild-xo.sh [max_wait_minutes]
```

Steps, in order: drain on; wait for zero active runs (default 120 minutes); disk at least 15G free; clean tree; database backup; pin the current image as `archon:rollback-<stamp>`; fetch and check out `origin/dev`; build; up; health wait (150 seconds); serve lanes; drain off; prune old backups and pins.

Test overrides (not needed on the host): `ARCHON_DIR`, `DB`, `SCRIPTS_DIR`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Rebuilt and healthy |
| 2 | No archon checkout at `ARCHON_DIR` |
| 3 | Stopped before the build: runs never went idle, low disk, dirty tree, or checkout failed. Drain is switched off again |
| 4 | The new container was not healthy; the pinned image was restored |
| 5 | The image BUILD FAILED. The output has `ABORT_BUILD rc=<n>`. The old container is still running, the checkout is put back on the commit it started from, drain is switched off. Nothing was replaced |

Before bdc-xo#5444 a failed build was piped through `tail`, so the script carried on, ran `up -d` on the old image and passed the health gate. Exit 5 is the guard against that.

## Rollback

```bash
docker tag archon:rollback-<stamp> archon:latest && cd /opt/bdc/archon && git checkout -q --detach <previous sha> && docker compose up -d --no-build --force-recreate app
```

The previous sha and the stamp are printed by the script at the pin and fetch steps.

## Keys are not part of a build

The GitHub App private keys live in `/opt/bdc/archon/secrets/`, which is inside the build context. `.dockerignore` and `.gitignore` both list `secrets/` and `*.private-key.pem` so they cannot be copied into an image layer or staged by `git add -A`. Check: `git check-ignore -q secrets/thinman-overseer-app.private-key.pem` exits 0.
