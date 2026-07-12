# Codex Auth Sync

Windows-side sync for `C:\Users\pcmed\.codex\auth.json` to the Hetzner host copy at:

```text
/opt/bdc/archon-user-home/.codex/auth.json
```

## Files

- `sync-codex-auth.ps1`: newest-wins sync with SHA-256 no-op detection, dated host backup, owner/mode repair, container verify probe, restore-on-failure, and builder-status posts.
- `install-sync-task.ps1`: copies `sync-codex-auth.ps1` to `%LOCALAPPDATA%\BlueDevil\codex-auth-sync\` and registers that stable copy as a Windows Scheduled Task every 30 minutes.

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

## Dry Verification

Before installation, verify the scripts without registering a task or syncing credentials:

```powershell
bun test .\scripts\codex-auth-sync\codex-auth-sync.test.ts
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path .\scripts\codex-auth-sync\install-sync-task.ps1),
  [ref]$tokens,
  [ref]$errors
) | Out-Null
if ($errors.Count -ne 0) { $errors | Format-List; exit 1 }
```

## Install The Recurring Task

Install only after the PR is merged and the installer is available in the canonical `C:\Users\pcmed\projects\bdc-harness` checkout. Do not install from a branch or worktree.

From the canonical checkout:

```powershell
Set-Location C:\Users\pcmed\projects\bdc-harness
powershell -ExecutionPolicy Bypass -File scripts\codex-auth-sync\install-sync-task.ps1
```

The installer copies the sync script to:

```text
%LOCALAPPDATA%\BlueDevil\codex-auth-sync\sync-codex-auth.ps1
```

The scheduled task action references that installed copy, so removing or updating a worktree cannot break the task path.

## Verification

Inspect the task without running it:

```powershell
Get-ScheduledTask -TaskName "BDC Codex Auth Sync" |
  Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName "BDC Codex Auth Sync" |
  Select-Object LastRunTime, LastTaskResult, NextRunTime
```

After a scheduled or manual sync attempt, scan silently for credential markers first. Fail closed before emitting any log content, then print only allowlisted redacted metadata fields:

```powershell
$ErrorActionPreference = "Stop"
$logPath = "$env:USERPROFILE\.codex\codex-auth-sync.log"
if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) { throw "Auth sync log is missing" }
$leakFound = Select-String -LiteralPath $logPath `
  -Pattern 'access_token|refresh_token|id_token|Bearer\s|eyJ[A-Za-z0-9_-]' `
  -CaseSensitive:$false -Quiet
if ($leakFound) { throw "Credential marker found in auth sync log" }

$allowedField = '^(?:action|status|comparison|desktop_sha|remote_sha|desktop_bytes|remote_bytes)=[A-Za-z0-9_-]+$'
Select-String -LiteralPath $logPath -Pattern 'action=' | Select-Object -Last 20 | ForEach-Object {
  (($_.Line -split ' ') | Where-Object { $_ -match $allowedField }) -join ' '
}
```

For a real sync attempt, backup evidence can be inspected separately:

```powershell
ssh hetzner-prod "ls /opt/bdc/archon-user-home/.codex/auth.json.bak.*"
```

If the sync output was `skipped` or `no-op`, a new backup may not exist for that run. Use the log line as evidence for that branch.

Static script check from the repo:

```bash
grep -rnP "[^\x00-\x7F]" scripts/codex-auth-sync/
```

Expected: no output.
