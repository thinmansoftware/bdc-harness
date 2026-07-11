# Codex Auth Sync

Windows-side sync for `C:\Users\pcmed\.codex\auth.json` to the Hetzner host copy at:

```text
/opt/bdc/archon-user-home/.codex/auth.json
```

## Files

- `sync-codex-auth.ps1`: newest-wins sync with SHA-256 no-op detection, dated host backup, owner/mode repair, container verify probe, restore-on-failure, and builder-status posts.
- `install-sync-task.ps1`: registers `sync-codex-auth.ps1` as a Windows Scheduled Task every 30 minutes.

## Logging

Default log:

```text
%USERPROFILE%\.codex\codex-auth-sync.log
```

The log only records action, timestamps, hash prefixes, byte counts, backup paths, and status labels. It must never contain token bytes.

Backups use:

```text
auth.json.bak.YYYYMMDD-HHMMSS
```

## Manual Run

From this repo on the Windows desktop:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\codex-auth-sync\sync-codex-auth.ps1
```

Install the recurring task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\codex-auth-sync\install-sync-task.ps1
```

## Verification

Run after a real sync attempt:

```powershell
ssh hetzner-prod "ls /opt/bdc/archon-user-home/.codex/auth.json.bak.*"
grep -c "eyJ" "$env:USERPROFILE\.codex\codex-auth-sync.log"
```

Expected token-leak result:

```text
0
```

If the sync output was `skipped` or `no-op`, a new backup may not exist for that run. Use the log line as evidence for that branch.

Static script check from the repo:

```bash
grep -rnP "[^\x00-\x7F]" scripts/codex-auth-sync/
```

Expected: no output.
