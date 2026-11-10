[CmdletBinding()]
param(
    # The launcher to check. Defaults to the one next to this script, so run it from the checkout you are about to point the task at.
    [string]$Launcher = ''
)

# PRECHECK for any swap of the dispatch worker launcher (bdc-xo #3418). Run it with Windows PowerShell 5.1,
# the Task Scheduler shell:  powershell.exe -NoProfile -ExecutionPolicy Bypass -File preflight-launcher.ps1
# It dot-sources the launcher, then runs the REAL Start-WorkerProcess (job object, PATH resolution of bun)
# against a harmless probe entry instead of the worker, and checks the probe received its arguments.
# It never starts the real worker, never touches the task, the lock or the tunnel.
# Prints LAUNCHER_DRY_START_OK and exits 0, or LAUNCHER_DRY_START_FAIL: <reason> and exits 1.

$ErrorActionPreference = 'Stop'
# ($PSScriptRoot is empty inside a param default under Windows PowerShell 5.1, so the default is set here.)
if (-not $Launcher) { $Launcher = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'start-windows.ps1' }
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('dispatch-preflight-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    . $Launcher
    $probe = Join-Path $temp 'probe.ts'
    $out = Join-Path $temp 'argv.json'
    Set-Content -LiteralPath $probe -Encoding ascii -Value "import { writeFileSync } from 'fs'; writeFileSync(process.env.PROBE_OUT as string, JSON.stringify(process.argv.slice(2)));"
    $config = Join-Path $temp 'config.local.json'
    $env:PROBE_OUT = $out
    $p = Start-WorkerProcess -ConfigPath $config -Entry $probe
    if (-not $p.WaitForExit(30000)) { throw 'the probe did not exit within 30 s' }
    if ($p.ExitCode -ne 0) { throw ('the probe exited with code ' + $p.ExitCode) }
    $received = Get-Content -LiteralPath $out -Raw | ConvertFrom-Json
    if ($received.Count -ne 2 -or $received[0] -ne '--config' -or $received[1] -ne $config) {
        throw ('the probe received unexpected arguments: ' + ($received -join ' '))
    }
    $left = 0
    if ($p.PSObject.Properties['DispatchJob']) { $left = [int]$p.DispatchJob.ActiveProcesses(); $p.DispatchJob.Close() }
    if ($left -ne 0) { throw ("$left process(es) left in the job after the probe exited") }
    Write-Output ('PSVersion=' + $PSVersionTable.PSVersion + ' bun=' + (Get-Command bun -CommandType Application | Select-Object -First 1).Source)
    Write-Output 'LAUNCHER_DRY_START_OK'
    exit 0
}
catch {
    Write-Output ('LAUNCHER_DRY_START_FAIL: ' + $_.Exception.Message)
    exit 1
}
finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
