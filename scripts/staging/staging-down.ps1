# staging-down.ps1 -- stop the laptop Cauldron STAGING instance.
# WO-HARNESS-CAULDRON-LAPTOP-STAGING-01.
#
# Data PERSISTS: staging-data/ (event store), staging-user-home/, staging-artifacts/
# are host bind mounts and survive down/up cycles (WO test scenario 4).
#
# Usage: powershell -File scripts/staging/staging-down.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Compose  = Join-Path $RepoRoot "docker-compose.staging.yml"

$cmd = Get-Command docker -ErrorAction SilentlyContinue
if ($cmd) { $Docker = $cmd.Source }
elseif (Test-Path "C:\Program Files\Docker\Docker\resources\bin\docker.exe") { $Docker = "C:\Program Files\Docker\Docker\resources\bin\docker.exe" }
else { Write-Error "docker CLI not found"; exit 1 }

& $Docker compose -f $Compose down
if ($LASTEXITCODE -ne 0) { Write-Error "[staging-down] compose down failed"; exit 1 }
Write-Host "[staging-down] staging stopped. Event store persisted at staging-data/archon.db"
