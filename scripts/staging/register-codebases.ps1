# register-codebases.ps1 -- seed codebase registrations in the laptop STAGING instance.
# WO-HARNESS-CAULDRON-LAPTOP-STAGING-01 section 5.3.
#
# Registers (clones) the repos canary fires need to bind against. Idempotent:
# the API returns 200 alreadyExisted for repos already registered, 201 for new.
# Clone auth uses the GITHUB_TOKEN inside the container (.env.staging).
#
# Usage:
#   powershell -File scripts/staging/register-codebases.ps1
#   powershell -File scripts/staging/register-codebases.ps1 -Repos bluedevilcollectibles/shopops

[CmdletBinding()]
param(
  [string[]]$Repos = @("bluedevilcollectibles/bdc-harness", "bluedevilcollectibles/bdc-xo")
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$EnvFile  = Join-Path $RepoRoot ".env.staging"
$BaseUrl  = "http://127.0.0.1:3091"

if (-not (Test-Path $EnvFile)) { Write-Error "[register] .env.staging missing -- run staging-up.ps1 first"; exit 1 }
$tokLine = (Get-Content $EnvFile) | Where-Object { $_ -match "^ARCHON_OPERATOR_TOKEN=" } | Select-Object -First 1
$tok = ($tokLine -replace "^ARCHON_OPERATOR_TOKEN=", "").Trim()
if (-not $tok -or $tok -like "REPLACE_*") { Write-Error "[register] ARCHON_OPERATOR_TOKEN not set in .env.staging"; exit 1 }
$hdr = @{ "x-archon-operator-token" = $tok }

$failed = 0
foreach ($repo in $Repos) {
  $url = "https://github.com/$repo"
  Write-Host "[register] POST /api/codebases url=$url"
  try {
    $resp = Invoke-RestMethod -Uri "$BaseUrl/api/codebases" -Method Post -Headers $hdr -ContentType "application/json" -Body (@{ url = $url } | ConvertTo-Json -Compress) -TimeoutSec 300
    Write-Host "[register] OK: $($resp.name) id=$($resp.id)"
  } catch {
    Write-Warning "[register] FAILED for $repo : $($_.Exception.Message)"
    $failed++
  }
}

Write-Host "[register] registered codebases now:"
(Invoke-RestMethod -Uri "$BaseUrl/api/codebases" -Headers $hdr -TimeoutSec 10) | ForEach-Object { Write-Host "  - $($_.name) ($($_.id))" }
if ($failed -gt 0) { exit 1 }
