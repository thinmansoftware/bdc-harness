# Host scripts (hetzner-prod)

These are the scripts installed on the harness host. The copies here are the
source of truth: edit them here, then install them on the host.

| Script | Installed at | Schedule |
|---|---|---|
| `cauldron-worktree-prune.sh` | `/usr/local/sbin/cauldron-worktree-prune.sh` | `/etc/cron.d/cauldron-worktree-prune`, daily 05:00 UTC, root |
| `cauldron-disk-cleanup.sh` | `/opt/bdc/backups/cauldron-disk-cleanup.sh` | root crontab, daily 05:17 UTC, plus `--pressure-check` hourly (retention step only, quiet unless `/mnt/bdc-builds` is at or above 85% used) |
| `archon-db-backup-retention.sh` | `/usr/local/sbin/archon-db-backup-retention.sh` | no cron file of its own: run by `cauldron-disk-cleanup.sh` (daily 05:17 UTC) and by its hourly `--pressure-check` line; report-only unless a retention variable is set |

`archon-db-backup-retention.sh` reports on the `archon.db.pre-rebuild-<STAMP>`
snapshots that every `archon-app-1` rebuild leaves (about 2.2 GB each). It is not
a second scheduler or watcher: the existing nightly `cauldron-disk-cleanup.sh`
runs it (step 1c, before the DRY_RUN exit), and that same script's
`--pressure-check` mode, run hourly from the root crontab, runs only this step and
only when `PRESSURE_MOUNT` (default `/mnt/bdc-builds`) is at or above
`PRESSURE_PCT` (default 85) used; below that it logs nothing. A low-disk,
refused or failed retention result is logged and never stops the rest of the
cleanup.

By default it only reports and never moves, copies or deletes anything, and
writes nothing to the root filesystem except its own log line
(`/var/log/archon-db-backup-retention.log`). It prints one `SNAPSHOT_REPORT` line
per location (`/mnt/bdc-builds/backups/archon`, which is the same directory as
`/opt/bdc/backups/archon` on sdb, then the root-disk leftovers
`/opt/bdc/backups-root/archon-db-snapshots`, `/opt/bdc/backups-overflow-20261103`,
`/opt/bdc/backups-overflow`), one `DISK_FREE` line for `/` and one for
`/mnt/bdc-builds`, one `PINNED_SNAPSHOTS` line, and a `SNAPSHOT_DISK_LOW` line
with exit status 3 when `/mnt/bdc-builds` has less than `SDB_MIN_FREE_GB` (default
20) or `/` less than `ROOT_MIN_FREE_GB` (default 25) free. A snapshot is a regular
file named exactly `archon.db.pre-rebuild-<YYYYMMDD>T<HHMM>Z` (what
`rebuild-archon.sh` writes) or `...T<HHMMSS>Z` (what `rebuild-xo.sh` writes);
sidecar files, symlinks and anything else are never counted or touched.

Delete mode is OFF. It turns on only when `KEEP_NEWEST_SNAPSHOTS` or
`DELETE_AFTER_DAYS` (a positive integer of at most 6 digits; leading zeros are
read as decimal) is set in the environment of whatever runs it; any other value
stops the run with exit 2 before anything is touched. The cleanup script never
sets either variable. Then it deletes oldest first and always preserves:

- the newest `max(3, KEEP_NEWEST_SNAPSHOTS)` snapshots of the snapshot disk;
- every file under 24 hours old;
- the snapshot of the current rollback pin (the stamp in
  `LAST_ROLLBACK_PIN`) and of every `archon:rollback-<STAMP>` image tag that
  still exists, in every location (a snapshot and its pin share one stamp).

If the pin record or the docker tag list cannot be read, nothing is deleted
(`SNAPSHOT_DELETE_REFUSED`, exit 5). Each deletion is one `SNAPSHOT_DELETED` line.
`KEEP_NEWEST_SNAPSHOTS` acts on the snapshot disk only; `DELETE_AFTER_DAYS` acts on
every location. `DRY_RUN=1` prints `WOULD_DELETE` lines for the same plan and
deletes nothing. Turning deletion on is an activation step that waits on John's
own recorded answer (XO-Q-20261112-07 and the exact deletion list); nothing here
does it.

Tests (no host, no docker, no real snapshot):
`bash scripts/host/__tests__/archon-db-backup-retention.test.sh` and
`bash scripts/host/__tests__/cauldron-disk-cleanup-retention.test.sh`.
Read-only check on the host:
`ssh hetzner-prod 'LOG=/dev/null bash -s' < scripts/host/archon-db-backup-retention.sh`.

The two cleanup scripts take `DRY_RUN=1`, which lists candidate worktrees with their sizes
and removes nothing. Cleanup runs overnight only (John 2026-10-21).

A worktree past the age cutoff is removed only if it is also abandoned. That means
no file inside it changed within the retention window, no process has its cwd in
it, and `git status` shows no uncommitted changes. If git cannot answer, the
worktree is kept. Each kept worktree is logged with its reason.

`cauldron-disk-cleanup.sh` also prunes the `archon:rollback-<STAMP>` image pins
that every `archon-app-1` rebuild leaves behind (about 8 GB each). It keeps the
newest `KEEP_ROLLBACK_PINS` pins by image creation time (env, default 3) and
removes older ones with plain `docker rmi` (no `-f`). The newest pin is always
kept, even with `KEEP_ROLLBACK_PINS=0`, because it is the current rebuild's
rollback target. A pin whose image ID is used by any container, running or
stopped, is skipped and logged as `in-use`. The tag named in the rollback record
file `/opt/bdc/backups/archon/LAST_ROLLBACK_PIN` (one line, for example
`archon:rollback-20261104T0204Z`; override the path with `ROLLBACK_RECORD_FILE`)
is never removed, even outside the newest pins, and is logged as
`rollback-record`. The rebuild procedure writes that file; that procedure change
is tracked separately in WO-XO-HARNESS-REBUILD-SCRIPT-01. If the file is missing
or unreadable, the other rules still apply. So at most `KEEP_ROLLBACK_PINS` pins
remain, plus protected exceptions, each with a logged skip. If docker cannot list
containers, no pin is removed.

With `DRY_RUN=1` the script prints the rollback-pin plan (`keep`, `skip`,
`DRY_RUN would remove`) after the worktree list and removes nothing:
`sudo env DRY_RUN=1 KEEP_ROLLBACK_PINS=3 /opt/bdc/backups/cauldron-disk-cleanup.sh`.

A worktree's `.git` points at a container path (`/.archon/workspaces/...`), so
every git command (`status`, `worktree prune`) runs inside `archon-app-1` through
`docker exec -u appuser`. A host-side `git worktree prune` would treat every
worktree as missing and drop live ones.

Install:

```
scp scripts/host/cauldron-worktree-prune.sh hetzner-prod:/home/claude/cwp.new
ssh hetzner-prod 'sudo cp -p /usr/local/sbin/cauldron-worktree-prune.sh{,.bak-$(date -u +%Y%m%d)} && sudo install -m 755 -o root -g root /home/claude/cwp.new /usr/local/sbin/cauldron-worktree-prune.sh'
```

Verify: `ssh hetzner-prod 'sudo env DRY_RUN=1 /usr/local/sbin/cauldron-worktree-prune.sh | tail -1'`

Install the snapshot retention (operator step, root, only on the acting XO's word;
neither retention variable is set anywhere in this procedure):

```
scp scripts/host/archon-db-backup-retention.sh hetzner-prod:/home/claude/adbr.new
scp scripts/host/cauldron-disk-cleanup.sh hetzner-prod:/home/claude/cdc.new
ssh hetzner-prod 'sudo install -m 755 -o root -g root /home/claude/adbr.new /usr/local/sbin/archon-db-backup-retention.sh'
ssh hetzner-prod 'sudo cp -p /opt/bdc/backups/cauldron-disk-cleanup.sh{,.bak-$(date -u +%Y%m%d)} && sudo install -m 755 -o root -g root /home/claude/cdc.new /opt/bdc/backups/cauldron-disk-cleanup.sh'
```

Then add ONE line to the root crontab (`sudo crontab -e`), beside the existing
`17 5 * * *` line, for the hourly pressure check:

```
0 * * * * /opt/bdc/backups/cauldron-disk-cleanup.sh --pressure-check
```

No `/etc/cron.d/archon-db-backup-retention` file exists or is needed. Verify:
`ssh hetzner-prod 'sudo crontab -l | grep -c -E "KEEP_NEWEST_SNAPSHOTS|DELETE_AFTER_DAYS"'` prints 0,
and `ssh hetzner-prod 'sudo env DRY_RUN=1 /opt/bdc/backups/cauldron-disk-cleanup.sh | tail -3'`
shows the `[retention]` lines and removes nothing.
