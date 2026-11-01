# Container image revision

`archon-app-1` used to report `org.opencontainers.image.revision` as `a04817ce`. That value was inherited from the base image `oven/bun:1.3.11-slim`. It is not a commit in this repo: `git cat-file -e` could not resolve it. `ARCHON_BUILD_SHA` inside the container was `unknown` because the image build did not set the build arg.

The production stage now sets `org.opencontainers.image.revision` from `ARCHON_BUILD_SHA`. The wrapper below stamps that arg with `git rev-parse HEAD` and checks the label on the built image.

## Build

Run from a clean checkout of the repo root:

```bash
bash scripts/container/build-app-image.sh
```

The wrapper does not restart, stop, remove, or recreate containers. Its only Docker commands are `docker compose build app` and `docker image inspect` of image `archon`. Inspect `archon-app-1` only after the separate governed recreate.

## Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Success. Stdout is `built archon revision=<SHA>`. |
| 3 | Dirty tree (`git status --porcelain` printed something), or HEAD is not 40 lowercase hex. Docker is not called. |
| Docker status | `docker compose build app` failed. The wrapper exits with that status and does not inspect the image. |
| 4 | Image `archon` revision label does not match HEAD. Stderr is `revision label mismatch: expected <SHA> found <found>`. |
| 10 | Rebuild hold file exists. Stderr is `refusing to build: rebuild hold present` plus the file contents. Git and Docker are not called. |

## Post-merge acceptance

On the harness host, after merged `dev` is checked out in `/opt/bdc/archon` with a clean tree:

```bash
cd /opt/bdc/archon && bash scripts/container/build-app-image.sh
```

Then recreate `archon-app-1` under the governed rebuild, and verify:

```bash
L=$(docker inspect archon-app-1 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
git -C /opt/bdc/archon cat-file -e "$L" && test "$L" = "$(git -C /opt/bdc/archon rev-parse HEAD)" && echo LABEL_OK
docker exec archon-app-1 printenv ARCHON_BUILD_SHA
```

Expected: `LABEL_OK`, and `printenv` prints the same 40-hex value.

## Rebuild hold

The hold file lives on the host at `/opt/bdc/archon/.rebuild-hold`. It is not in git. `build-app-image.sh` and `rebuild-archon-app.sh` only read it. They never create, update, or remove it. Setting or clearing the hold is an operator action. The stop file at `/opt/bdc/archon/.rebuild-stop` is the same kind of host-local flag.

On 2026-11-01 a desktop background job was stopped with TaskStop. TaskStop reported success, but its Git Bash child survived. At 20:49Z that child rebuilt `archon-app-1` from `a1e6fd2c` to `b7e9d279` during an acting-XO hold and raised root disk use from 91% to 96%. Nothing on the host knew a hold existed, so the rebuild ran.

Set a hold:

```bash
printf '%s\n' 'held by operator: reason here' > /opt/bdc/archon/.rebuild-hold
```

Clear it:

```bash
rm /opt/bdc/archon/.rebuild-hold
```

Create or clear the stop file the same way, with `printf` and `rm`, at `/opt/bdc/archon/.rebuild-stop`.

Optional overrides:

- `ARCHON_REBUILD_HOLD_FILE` (default `/opt/bdc/archon/.rebuild-hold`)
- `ARCHON_REBUILD_STOP_FILE` (default `/opt/bdc/archon/.rebuild-stop`)
- `ARCHON_REBUILD_BACKUP_DIR` (default `/opt/bdc/backups/archon/compose`)

Both compose files are copied into that directory as `*.pre-rebuild-<STAMP>`. They are never copied into `/opt/bdc/archon`. The database backup remains `/opt/bdc/backups/archon/archon.db.pre-rebuild-<STAMP>` and is unaffected by `ARCHON_REBUILD_BACKUP_DIR`.

`build-app-image.sh` checks the hold file before `git status`. When that file exists it prints `refusing to build: rebuild hold present`, prints the file contents to stderr, and exits 10. Git and Docker are not called.

`rebuild-archon-app.sh` does that same hold check first and exits 10 before sqlite3, git, or Docker. It checks the hold file and the stop file again immediately before the image build, and again immediately before `docker compose up -d app`. If either file exists it prints `refusing to rebuild: hold or stop file present` and exits 11 without that next step.

Run a rebuild from the host checkout:

```bash
cd /opt/bdc/archon
TARGET=<40-hex-sha> bash scripts/container/rebuild-archon-app.sh
```

`TARGET` is required. The script refuses to start while a workflow run is `running` or `pending`. It copies both compose files into `ARCHON_REBUILD_BACKUP_DIR`, backs up the database, tags `archon:rollback-<STAMP>`, checks out `TARGET`, builds by calling `scripts/container/build-app-image.sh`, waits until live dispatch claims drain, then runs `docker compose up -d app`.

Untracked files such as `.env.bak-*` are still rejected later by `build-app-image.sh` (bdc-xo #4112). That dirty-tree rule is unchanged. This script does not prune images, delete backups, or remove old tags. Cleanup stays a separate overnight job.

On success the script prints one rollback line:

```text
docker tag archon:rollback-<STAMP> archon:latest && git checkout --detach <PREV> && docker compose up -d --no-build app
```
