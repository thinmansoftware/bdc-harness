[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.local.json'),
    [string]$SshHost = 'hetzner-prod',
    [int]$LocalPort = 3900,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'

# Exit code the worker uses when a GENUINE live instance already holds the lock
# (see EXIT_ALREADY_RUNNING in scripts/dispatch-worker/index.ts). It means "do not retry".
$script:WorkerAlreadyRunningExit = 75

# ---------------------------------------------------------------------------
# Adapters. Each one is a small function so a test can redefine it after
# dot-sourcing this file (start-windows.test.ts runs the real supervisor with
# stub processes, a fake clock and no real sleep).
# ---------------------------------------------------------------------------

function Write-LauncherLog {
    param([string]$Message)
    # Write-Host, not Write-Output: callers return values and must not be polluted.
    Write-Host ("dispatch_launcher: " + $Message)
}

function Invoke-LauncherSleep {
    param([int]$Seconds)
    Start-Sleep -Seconds $Seconds
}

function Get-LauncherNow {
    return [DateTime]::UtcNow
}

function Test-LocalPortOpen {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(1000)) { return $false }
        $client.EndConnect($pending)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

function Start-TunnelProcess {
    param([string]$SshHost, [int]$LocalPort)
    $forward = "127.0.0.1:${LocalPort}:127.0.0.1:3090"
    $process = Start-Process -FilePath 'ssh' -ArgumentList @(
        '-N',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-L', $forward,
        $SshHost
    ) -WindowStyle Hidden -PassThru
    $null = $process.Handle
    return $process
}

function Start-WorkerProcess {
    param([string]$ConfigPath)
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $bun = (Get-Command bun -ErrorAction Stop).Source
    $process = Start-Process -FilePath $bun -ArgumentList @(
        'run', 'scripts/dispatch-worker/index.ts', '--config', $ConfigPath
    ) -WorkingDirectory $repoRoot -NoNewWindow -PassThru
    $null = $process.Handle
    return $process
}

# Stops ONLY a process object this launcher started, and only if the live PID
# still has the start time recorded when it was started (a reused PID is left alone).
function Stop-OwnedProcess {
    param($Process)
    if ($null -eq $Process) { return }
    try {
        if ($Process.HasExited) { return }
        $live = Get-Process -Id $Process.Id -ErrorAction SilentlyContinue
        if ($null -eq $live) { return }
        if ($live.StartTime -ne $Process.StartTime) { return }
        Stop-Process -Id $Process.Id -Force
    }
    catch {
        Write-LauncherLog ("could not stop owned process " + $Process.Id)
    }
}

# ---------------------------------------------------------------------------
# One tunnel + worker pair, supervised until something ends it.
# Returns @{ Outcome = 'clean'|'holder'|'failed'; Reason = '...' }.
# Reasons carry exit codes and port numbers only: never config, token or prompt text.
# ---------------------------------------------------------------------------
function Invoke-DispatchPairOnce {
    param(
        [string]$ConfigPath,
        [string]$SshHost,
        [int]$LocalPort,
        [int]$ReadySeconds = 30,
        [int]$PollSeconds = 5
    )

    # A listener we did not start is never touched: fail loudly and let the bounded
    # retry (and the operator) deal with it.
    if (Test-LocalPortOpen -Port $LocalPort) {
        return @{ Outcome = 'failed'; Reason = "local port $LocalPort is held by a process this launcher did not start; it was not terminated" }
    }

    $tunnel = Start-TunnelProcess -SshHost $SshHost -LocalPort $LocalPort
    $worker = $null
    try {
        $ready = $false
        for ($waited = 0; $waited -lt $ReadySeconds; $waited++) {
            if ($tunnel.HasExited) {
                return @{ Outcome = 'failed'; Reason = "ssh tunnel exited before readiness (exit code $($tunnel.ExitCode))" }
            }
            if (Test-LocalPortOpen -Port $LocalPort) { $ready = $true; break }
            Invoke-LauncherSleep -Seconds 1
        }
        if (-not $ready) {
            return @{ Outcome = 'failed'; Reason = "ssh tunnel did not open local port $LocalPort within $ReadySeconds s" }
        }

        $worker = Start-WorkerProcess -ConfigPath $ConfigPath
        while ($true) {
            Invoke-LauncherSleep -Seconds $PollSeconds
            if ($worker.HasExited) {
                $code = $worker.ExitCode
                if ($code -eq 0) { return @{ Outcome = 'clean'; Reason = 'worker exited 0' } }
                if ($code -eq $script:WorkerAlreadyRunningExit) {
                    return @{ Outcome = 'holder'; Reason = 'a genuine live worker already holds the instance lock' }
                }
                return @{ Outcome = 'failed'; Reason = "worker exited with code $code" }
            }
            if ($tunnel.HasExited) {
                return @{ Outcome = 'failed'; Reason = "ssh tunnel exited while the worker ran (exit code $($tunnel.ExitCode))" }
            }
            if (-not (Test-LocalPortOpen -Port $LocalPort)) {
                return @{ Outcome = 'failed'; Reason = "tunnel listener on port $LocalPort was lost while the worker ran" }
            }
        }
    }
    finally {
        # Our own pair only: the worker first, then the tunnel.
        Stop-OwnedProcess -Process $worker
        Stop-OwnedProcess -Process $tunnel
    }
}

# ---------------------------------------------------------------------------
# Supervisor: bounded retry with backoff. Exits 0 on a clean stop or a genuine
# existing holder; exits 1 when consecutive failures are exhausted so Task
# Scheduler's own restart policy takes over.
# ---------------------------------------------------------------------------
function Invoke-DispatchSupervisor {
    param(
        [string]$ConfigPath,
        [string]$SshHost,
        [int]$LocalPort,
        [int]$MaxAttempts = 5,
        [int[]]$BackoffSeconds = @(10, 30, 60, 120),
        [int]$StableSeconds = 600
    )

    $failures = 0
    while ($true) {
        $startedAt = Get-LauncherNow
        $result = Invoke-DispatchPairOnce -ConfigPath $ConfigPath -SshHost $SshHost -LocalPort $LocalPort
        if ($result.Outcome -eq 'clean') {
            Write-LauncherLog "worker stopped cleanly"
            return 0
        }
        if ($result.Outcome -eq 'holder') {
            Write-LauncherLog ("not retrying: " + $result.Reason)
            return 0
        }

        $ranSeconds = ((Get-LauncherNow) - $startedAt).TotalSeconds
        if ($ranSeconds -ge $StableSeconds) { $failures = 0 }
        $failures++
        Write-LauncherLog ("attempt $failures of $MaxAttempts failed: " + $result.Reason)
        if ($failures -ge $MaxAttempts) {
            Write-LauncherLog "retry budget exhausted; exiting non-zero for the scheduled task restart policy"
            return 1
        }
        $wait = $BackoffSeconds[[Math]::Min($failures - 1, $BackoffSeconds.Count - 1)]
        Write-LauncherLog ("retrying in $wait s (retry $failures)")
        Invoke-LauncherSleep -Seconds $wait
    }
}

# Dot-sourcing (the test harness) loads the functions above and stops here.
if ($MyInvocation.InvocationName -eq '.') { return }

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Dispatch worker config is missing: $ConfigPath"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$expectedServerUrl = "http://127.0.0.1:$LocalPort"
if ($config.server_url -ne $expectedServerUrl) {
    throw "config.server_url must be $expectedServerUrl for the managed SSH tunnel"
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw 'bun is not available on PATH'
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    throw 'ssh is not available on PATH'
}

if ($ValidateOnly) {
    Write-Output 'DISPATCH_WINDOWS_LAUNCHER_VALID'
    exit 0
}

exit (Invoke-DispatchSupervisor -ConfigPath $ConfigPath -SshHost $SshHost -LocalPort $LocalPort)
