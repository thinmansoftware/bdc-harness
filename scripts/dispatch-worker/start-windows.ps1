[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.local.json'),
    [string]$SshHost = 'hetzner-prod',
    [int]$LocalPort = 3900,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'

function Read-DispatchTunnelObservation {
    param($Tunnel, [scriptblock]$Probe)
    try {
        $state = & $Probe $Tunnel
        if ($state -in @('owned', 'absent', 'foreign')) { return $state }
    } catch { }
    return 'unknown'
}

function Get-DispatchOwnedListenerState {
    param($OwnedTunnel, [int]$Port)
    try {
        # Successful enumeration is required before absence can be established.
        $listeners = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object {
            $_.State -eq 'Listen' -and $_.LocalPort -eq $Port -and
            $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::')
        })
        if ($listeners.Count -eq 0) { return 'absent' }
        if ($null -eq $OwnedTunnel -or $OwnedTunnel.HasExited) { return 'foreign' }
        foreach ($listener in $listeners) {
            if ($listener.LocalAddress -ne '127.0.0.1' -or $listener.OwningProcess -ne $OwnedTunnel.Id) { return 'foreign' }
        }
        return 'owned'
    } catch {
        return 'unknown'
    }
}

function Wait-DispatchOwnedTunnel {
    param($Tunnel, $Worker, [scriptblock]$Probe, [scriptblock]$Wait, [int]$Checks = 30)
    for ($check = 0; $check -lt $Checks; $check++) {
        if ($null -ne $Worker -and $Worker.HasExited) { return 'worker-exited' }
        if ($Tunnel.HasExited) { return 'failed' }
        $listener = Read-DispatchTunnelObservation $Tunnel $Probe
        if ($listener -eq 'unknown') { return 'unknown' }
        if ($listener -eq 'foreign') { return 'foreign' }
        if ($listener -eq 'owned') { return 'ready' }
        & $Wait
    }
    return 'failed'
}

function Stop-DispatchOwnedTunnel {
    param($OwnedTunnel)
    if ($OwnedTunnel.HasExited) { return $true }
    try {
        $OwnedTunnel.Kill()
        return $OwnedTunnel.WaitForExit(5000)
    } catch { return $false }
}

function Invoke-DispatchTunnelSupervision {
    param($Worker, $Tunnel, [scriptblock]$StartTunnel, [scriptblock]$StopTunnel,
        [scriptblock]$Probe, [scriptblock]$Wait, [scriptblock]$Report, [int]$ReadinessChecks = 30)
    $attempts = 0
    $held = $false
    $uncertain = $false
    try {
        while (-not $Worker.HasExited) {
            $observation = 'unknown'
            if (-not $held) {
                $observation = Read-DispatchTunnelObservation $Tunnel $Probe
                if ($observation -eq 'unknown') {
                    $held = $true
                    & $Report 'OBSERVATION_UNCERTAIN'
                }
            }
            if (-not $held -and ($Tunnel.HasExited -or $observation -ne 'owned')) {
                if (-not (& $StopTunnel $Tunnel)) {
                    $uncertain = $true
                    $held = $true
                    & $Report 'CLEANUP_UNCERTAIN'
                } else {
                    $Tunnel = $null
                    $ready = $false
                    while (-not $Worker.HasExited -and $attempts -lt 3) {
                        $vacancy = Read-DispatchTunnelObservation $null $Probe
                        if ($vacancy -eq 'unknown') {
                            $held = $true
                            & $Report 'OBSERVATION_UNCERTAIN'
                            break
                        }
                        if ($vacancy -ne 'absent') {
                            $held = $true
                            & $Report 'FOREIGN_LISTENER_REFUSED'
                            break
                        }
                        $delay = [int][Math]::Pow(2, $attempts)
                        for ($tick = 0; $tick -lt $delay -and -not $Worker.HasExited; $tick++) { & $Wait }
                        if ($Worker.HasExited) { break }
                        $attempts++
                        & $Report "RECONNECT_ATTEMPT_$attempts"
                        try { $Tunnel = & $StartTunnel } catch { $Tunnel = $null }
                        if ($null -eq $Tunnel) { continue }
                        $state = Wait-DispatchOwnedTunnel $Tunnel $Worker $Probe $Wait $ReadinessChecks
                        if ($state -eq 'ready') {
                            $ready = $true
                            & $Report 'TRANSPORT_RECOVERED'
                            break
                        }
                        if ($state -eq 'unknown') {
                            $held = $true
                            & $Report 'OBSERVATION_UNCERTAIN'
                            break
                        }
                        if (-not (& $StopTunnel $Tunnel)) {
                            $uncertain = $true
                            $held = $true
                            & $Report 'CLEANUP_UNCERTAIN'
                            break
                        }
                        $Tunnel = $null
                        if ($state -eq 'foreign') {
                            $held = $true
                            & $Report 'FOREIGN_LISTENER_REFUSED'
                            break
                        }
                        if ($state -eq 'worker-exited') { break }
                    }
                    if (-not $ready -and -not $Worker.HasExited -and -not $held) {
                        $held = $true
                        & $Report 'DEGRADED_EXHAUSTED'
                    }
                }
            }
            & $Wait
        }
        & $Report 'WORKER_EXITED'
    } finally {
        if (-not $uncertain -and $null -ne $Tunnel -and -not (& $StopTunnel $Tunnel)) {
            $uncertain = $true
            & $Report 'CLEANUP_UNCERTAIN'
        }
    }
    return @{ ReconnectAttempts = $attempts; CleanupUncertain = $uncertain; Held = $held }
}

# Dot-source only the pure supervision functions for isolated tests.
if ($MyInvocation.InvocationName -eq '.') { return }

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Dispatch worker config is missing: $ConfigPath"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$expectedServerUrl = "http://127.0.0.1:$LocalPort"
if ($config.server_url -ne $expectedServerUrl) {
    throw "config.server_url must be $expectedServerUrl for the managed SSH tunnel"
}
if (-not (Get-Command bun -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'bun is not available on PATH'
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    throw 'ssh is not available on PATH'
}

if ($ValidateOnly) {
    Write-Output 'DISPATCH_WINDOWS_LAUNCHER_VALID'
    exit 0
}

$forward = "127.0.0.1:${LocalPort}:127.0.0.1:3090"
$sshArgs = @(
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', $forward,
    $SshHost
)
$probe = {
    param($OwnedTunnel)
    Get-DispatchOwnedListenerState $OwnedTunnel $LocalPort
}
$startTunnel = {
    $process = Start-Process -FilePath 'ssh' -ArgumentList $sshArgs -WindowStyle Hidden -PassThru
    # Hold the captured process handle, not a later PID lookup.
    $null = $process.Handle
    $process
}
$stopTunnel = {
    param($OwnedTunnel)
    Stop-DispatchOwnedTunnel $OwnedTunnel
}
$wait = { Start-Sleep -Seconds 1 }
$report = { param($State) Write-Host "DISPATCH_TUNNEL_$State" }
$initialObservation = Read-DispatchTunnelObservation $null $probe
if ($initialObservation -eq 'unknown') { throw 'DISPATCH_TUNNEL_OBSERVATION_UNCERTAIN' }
if ($initialObservation -ne 'absent') { throw 'DISPATCH_FOREIGN_LISTENER_REFUSED' }
$tunnel = & $startTunnel
$supervised = $false

try {
    if ((Wait-DispatchOwnedTunnel $tunnel $null $probe $wait) -ne 'ready') {
        throw "SSH tunnel did not establish its owned local port $LocalPort"
    }
    $workingDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $worker = Start-Process -FilePath (Get-Command bun -CommandType Application | Select-Object -First 1).Source `
        -ArgumentList @('run', 'scripts/dispatch-worker/index.ts', '--config', ('"' + $ConfigPath + '"')) `
        -WorkingDirectory $workingDirectory -WindowStyle Hidden -PassThru
    $null = $worker.Handle
    $supervised = $true
    $result = Invoke-DispatchTunnelSupervision $worker $tunnel $startTunnel $stopTunnel $probe $wait $report
    $worker.WaitForExit()
    if ($result.CleanupUncertain) { throw 'DISPATCH_TUNNEL_CLEANUP_UNCERTAIN' }
    if ($worker.ExitCode -ne 0) {
        throw "Dispatch worker exited with code $($worker.ExitCode)"
    }
}
finally {
    if (-not $supervised -and -not (& $stopTunnel $tunnel)) {
        throw 'DISPATCH_TUNNEL_CLEANUP_UNCERTAIN'
    }
}
