[CmdletBinding()]
param(
    [string]$WorkerId = "dispatch-worker-$env:COMPUTERNAME",
    [string]$TaskName = 'BlueDevil-Dispatch-Worker'
)

# Thin wrapper: the repeating watchdog scheduled task invokes this, which runs
# the injected-deps watchdog.ts. watchdog.ts restarts the worker task if the
# worker PID lockfile is missing or holds a dead PID.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'watchdog.ts'
& bun run $script --worker-id $WorkerId --task-name $TaskName
exit $LASTEXITCODE
