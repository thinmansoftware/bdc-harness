[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.local.json'),
    [string]$SshHost = 'hetzner-prod',
    [int]$LocalPort = 3900,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'

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

$forward = "127.0.0.1:${LocalPort}:127.0.0.1:3090"
$tunnel = Start-Process -FilePath 'ssh' -ArgumentList @(
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', $forward,
    $SshHost
) -WindowStyle Hidden -PassThru

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$stdoutLog = Join-Path ([System.IO.Path]::GetTempPath()) ('dispatch-worker-stdout-' + [guid]::NewGuid().ToString() + '.log')
$stderrLog = Join-Path ([System.IO.Path]::GetTempPath()) ('dispatch-worker-stderr-' + [guid]::NewGuid().ToString() + '.log')
$retrySleepSeconds = @(30, 60, 90, 120)

try {
    $ready = $false
    for ($tunnelAttempt = 0; $tunnelAttempt -lt 30; $tunnelAttempt++) {
        if ($tunnel.HasExited) {
            throw "SSH tunnel exited with code $($tunnel.ExitCode)"
        }
        if (Test-NetConnection -ComputerName '127.0.0.1' -Port $LocalPort -InformationLevel Quiet) {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        throw "SSH tunnel did not open local port $LocalPort"
    }

    # One SSH tunnel is reused for every worker attempt. Tunnel failures above
    # throw immediately and never enter this retry loop.
    $configArg = $ConfigPath
    if ($configArg.IndexOf(' ') -ge 0) {
        $configArg = '"' + $configArg + '"'
    }

    for ($attempt = 1; $attempt -le 5; $attempt++) {
        # Windows PowerShell 5.1 errors when a -RedirectStandard* file already exists.
        if (Test-Path -LiteralPath $stdoutLog) {
            Remove-Item -LiteralPath $stdoutLog -Force
        }
        if (Test-Path -LiteralPath $stderrLog) {
            Remove-Item -LiteralPath $stderrLog -Force
        }

        $proc = Start-Process -FilePath 'bun' -ArgumentList @(
            'run',
            'scripts/dispatch-worker/index.ts',
            '--config',
            $configArg
        ) -WorkingDirectory $repoRoot -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

        $code = 1
        if ($null -ne $proc.ExitCode) {
            $code = $proc.ExitCode
        }

        $alreadyRunning = $false
        if (Test-Path -LiteralPath $stderrLog) {
            $stderrText = Get-Content -LiteralPath $stderrLog -Raw -ErrorAction SilentlyContinue
            if ($stderrText -and $stderrText.Contains('dispatch_worker_already_running')) {
                $alreadyRunning = $true
            }
        }
        if ($alreadyRunning) {
            Write-Output 'DISPATCH_WORKER_ALREADY_RUNNING'
            break
        }
        if ($code -eq 0) {
            break
        }
        if ($attempt -ge 5) {
            throw "Dispatch worker exited with code $code"
        }

        $sleepSeconds = $retrySleepSeconds[$attempt - 1]
        Write-Output "DISPATCH_WORKER_RETRY attempt=$attempt exit=$code sleep_s=$sleepSeconds"
        Start-Sleep -Seconds $sleepSeconds
    }
}
finally {
    if (Test-Path -LiteralPath $stdoutLog) {
        Remove-Item -LiteralPath $stdoutLog -Force
    }
    if (Test-Path -LiteralPath $stderrLog) {
        Remove-Item -LiteralPath $stderrLog -Force
    }
    if (-not $tunnel.HasExited) {
        Stop-Process -Id $tunnel.Id -Force
    }
}
