[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$TaskName = 'BlueDevil-Dispatch-Worker',
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.local.json'),
    [string]$SshHost = 'hetzner-prod',
    [int]$LocalPort = 3900
)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'start-windows.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Launcher is missing: $launcher"
}

$arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + $launcher + '"'),
    '-ConfigPath', ('"' + $ConfigPath + '"'),
    '-SshHost', $SshHost,
    '-LocalPort', [string]$LocalPort
) -join ' '

if ($PSCmdlet.ShouldProcess($TaskName, 'Register logon dispatch worker task')) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    # Bounded watchdog restart (M-51 AMEND-9 gap 2): Task Scheduler restarts the
    # task up to RestartCount times, spaced RestartInterval apart, on ANY
    # trigger type including AtLogOn -- this is not limited to scheduled-time
    # triggers. RestartCount=5 / RestartInterval=1 minute bounds it to at most
    # 5 restarts total rather than an infinite tight crash-restart loop.
    # ExecutionTimeLimit bounds a hung/wedged instance to a finite lifetime
    # (1 day) so Task Scheduler will terminate and restart it instead of
    # letting a stuck process sit forever consuming the single-instance slot.
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 1)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Output "DISPATCH_WINDOWS_TASK_REGISTERED=$TaskName"
}
