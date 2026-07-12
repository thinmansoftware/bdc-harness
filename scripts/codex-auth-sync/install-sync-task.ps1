param(
  [string]$TaskName = "BDC Codex Auth Sync",
  [string]$SourceScriptPath = "$PSScriptRoot\sync-codex-auth.ps1",
  [int]$IntervalMinutes = 30
)

# Registers the Codex auth sync as a Windows scheduled task. The 30-minute
# default is inside the WO-approved 15-60 minute window.

$ErrorActionPreference = "Stop"

if ($IntervalMinutes -lt 15 -or $IntervalMinutes -gt 60) {
  throw "IntervalMinutes must be between 15 and 60."
}

if (-not (Test-Path -LiteralPath $SourceScriptPath)) {
  throw "sync-codex-auth.ps1 not found at $SourceScriptPath"
}

$InstallDirectory = Join-Path $env:LOCALAPPDATA "BlueDevil\codex-auth-sync"
$InstalledScriptPath = Join-Path $InstallDirectory "sync-codex-auth.ps1"

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
Copy-Item -LiteralPath $SourceScriptPath -Destination $InstalledScriptPath -Force

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$InstalledScriptPath`""

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Sync BDC Codex OAuth auth.json to Hetzner with newest-wins safety." `
  -Force | Out-Null

Write-Output "task='$TaskName' interval_minutes=$IntervalMinutes installed_path='$InstalledScriptPath'"
