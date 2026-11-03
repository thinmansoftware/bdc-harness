# Host scripts (hetzner-prod)

These are the scripts installed on the harness host. The copies here are the
source of truth: edit them here, then install them on the host.

| Script | Installed at | Schedule |
|---|---|---|
| `cauldron-worktree-prune.sh` | `/usr/local/sbin/cauldron-worktree-prune.sh` | `/etc/cron.d/cauldron-worktree-prune`, daily 05:00 UTC, root |
| `cauldron-disk-cleanup.sh` | `/opt/bdc/backups/cauldron-disk-cleanup.sh` | root crontab, daily 05:17 UTC |

Both scripts take `DRY_RUN=1`, which lists candidate worktrees with their sizes
and removes nothing. Cleanup runs overnight only (John 2026-10-21).

Install:

```
scp scripts/host/cauldron-worktree-prune.sh hetzner-prod:/home/claude/cwp.new
ssh hetzner-prod 'sudo cp -p /usr/local/sbin/cauldron-worktree-prune.sh{,.bak-$(date -u +%Y%m%d)} && sudo install -m 755 -o root -g root /home/claude/cwp.new /usr/local/sbin/cauldron-worktree-prune.sh'
```

Verify: `ssh hetzner-prod 'sudo env DRY_RUN=1 /usr/local/sbin/cauldron-worktree-prune.sh | tail -1'`
