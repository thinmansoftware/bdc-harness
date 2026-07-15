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

try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
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

    Push-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..'))
    try {
        & bun run scripts/dispatch-worker/index.ts --config $ConfigPath
        if ($LASTEXITCODE -ne 0) {
            throw "Dispatch worker exited with code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    if (-not $tunnel.HasExited) {
        Stop-Process -Id $tunnel.Id -Force
    }
}
