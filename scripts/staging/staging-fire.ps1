# staging-fire.ps1 -- canary-fire a WO at the laptop Cauldron STAGING instance.
# WO-HARNESS-CAULDRON-LAPTOP-STAGING-01. Mirrors bdc-xo scripts/cauldron/fire.ps1
# (the proven atomic POST /api/conversations pattern) but targets localhost:3091
# with the STAGING operator token. No SSH, no prod anywhere.
#
# Usage:
#   powershell -File scripts/staging/staging-fire.ps1 -Wo <WO-ID> -Project <shortname> [-Workflow <lane>] [-WhatIf] [-SkipSpecCheck]
#
# Success is dispatched:true (NOT accepted:true) -- doctrine
# xo-wiki/wiki/doctrine/cauldron-fire-via-atomic-conversation/.

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Wo,
  [Parameter(Mandatory=$true)][string]$Project,
  [string]$Workflow = "bdc-feature-development",
  [string]$Extra = "",
  [switch]$WhatIf,
  [switch]$SkipSpecCheck
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$EnvFile  = Join-Path $RepoRoot ".env.staging"
$BaseUrl  = "http://127.0.0.1:3091"

# --- staging operator token from .env.staging (never the prod value) -----------
if (-not (Test-Path $EnvFile)) { Write-Error "[staging-fire] .env.staging missing -- run staging-up.ps1 first"; exit 1 }
$tokLine = (Get-Content $EnvFile) | Where-Object { $_ -match "^ARCHON_OPERATOR_TOKEN=" } | Select-Object -First 1
$tok = ($tokLine -replace "^ARCHON_OPERATOR_TOKEN=", "").Trim()
if (-not $tok -or $tok -like "REPLACE_*") { Write-Error "[staging-fire] ARCHON_OPERATOR_TOKEN not set in .env.staging"; exit 1 }
$hdr = @{ "x-archon-operator-token" = $tok }

# --- resolve codebaseId via the staging API (never prod archon.db) --------------
try {
  $codebases = Invoke-RestMethod -Uri "$BaseUrl/api/codebases" -Headers $hdr -TimeoutSec 10
} catch {
  Write-Error "[staging-fire] staging API unreachable on :3091 -- run staging-up.ps1 first ($($_.Exception.Message))"
  exit 1
}
$cb = @($codebases) | Where-Object { $_.name -eq "bluedevilcollectibles/$Project" -or $_.name -eq $Project } | Select-Object -First 1
if (-not $cb) {
  Write-Error "[staging-fire] codebase '$Project' not registered in staging -- run scripts/staging/register-codebases.ps1"
  exit 1
}
Write-Host "[staging-fire] codebaseId: $($cb.id) (project: $Project)"

# --- pre-flight: spec on bdc-xo main (same rule as prod fires) -------------------
if (-not $SkipSpecCheck) {
  $specOk = $false
  try {
    $name = gh api "repos/thinmansoftware/bdc-xo/contents/docs/work-orders/$Wo.md?ref=main" --jq .name 2>$null
    if ($name) { $specOk = $true }
  } catch {}
  if (-not $specOk) {
    Write-Error "[staging-fire] spec NOT on bdc-xo main: docs/work-orders/$Wo.md (use -SkipSpecCheck only for intentional issue-body WOs)"
    exit 1
  }
  Write-Host "[staging-fire] spec OK on bdc-xo main"
}

# --- build message + fire ---------------------------------------------------------
$firedBy = $env:BDC_OPERATOR
if (-not $firedBy) { $firedBy = "$env:USERNAME-staging" }
$msg = "/workflow run $Workflow WO_ID=$Wo --project $Project --fired_by=$firedBy"
if ($Extra) { $msg = "$msg $Extra" }

if ($WhatIf) {
  Write-Host "[staging-fire] WhatIf: would POST $BaseUrl/api/conversations {codebaseId=$($cb.id), message='$msg'}"
  exit 0
}

$payload = @{ codebaseId = $cb.id; message = $msg } | ConvertTo-Json -Compress
try {
  $resp = Invoke-RestMethod -Uri "$BaseUrl/api/conversations" -Method Post -Headers $hdr -ContentType "application/json" -Body $payload -TimeoutSec 30
} catch {
  Write-Error "[staging-fire] POST failed: $($_.Exception.Message)"
  exit 1
}
$respJson = $resp | ConvertTo-Json -Compress
Write-Host "[staging-fire] lane:     $Workflow"
Write-Host "[staging-fire] wo:       $Wo  (project $Project)"
Write-Host "[staging-fire] response: $respJson"

if ($respJson -match '"dispatched"\s*:\s*true') {
  Write-Host "[staging-fire] DISPATCHED -- canary running. Verify with scripts/staging/staging-status.ps1"
  exit 0
} else {
  Write-Error "[staging-fire] NOT dispatched -- see response above. Expected dispatched:true."
  exit 1
}
