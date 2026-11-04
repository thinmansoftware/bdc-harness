# Host scripts (hetzner-prod)

These are the scripts installed on the harness host. The copies here are the
source of truth: edit them here, then install them on the host.

| Script | Installed at | Schedule |
|---|---|---|
| `cauldron-worktree-prune.sh` | `/usr/local/sbin/cauldron-worktree-prune.sh` | `/etc/cron.d/cauldron-worktree-prune`, daily 05:00 UTC, root |
| `cauldron-disk-cleanup.sh` | `/opt/bdc/backups/cauldron-disk-cleanup.sh` | root crontab, daily 05:17 UTC |

Both scripts take `DRY_RUN=1`, which lists candidate worktrees with their sizes
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
