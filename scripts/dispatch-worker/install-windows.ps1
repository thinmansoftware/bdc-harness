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
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Output "DISPATCH_WINDOWS_TASK_REGISTERED=$TaskName"
}
