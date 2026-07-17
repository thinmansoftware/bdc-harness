# staging-m42-up.ps1 -- credential-free M-42 Slice 8 isolated staging launcher.
# WO-HARNESS-OVERSEER-INTEGRATION-ACTIVATION-01.
#
# Always builds the exact ref into image archon-m42-staging:<shortsha>, tags
# :current, starts only container archon-m42-staging from docker-compose.m42-staging.yml.
# Before candidate replacement, retains any existing prior M-42 image/config/data
# under staging-m42-prior/ for credential-free rollback.
# Never reads shared staging env files, never invokes host auth tooling,
# never calls the shared credential-seeding staging launcher, and never
# copies any host credential file.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/staging/staging-m42-up.ps1 -Ref <sha>
#
# Exit codes: 0 only when container is healthy on 127.0.0.1:3092. Nonzero on health timeout.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Ref
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Compose  = Join-Path $RepoRoot "docker-compose.m42-staging.yml"
$BuildDir = Join-Path $RepoRoot ".m42-staging-build"
$DataDir  = Join-Path $RepoRoot "staging-m42-data"
$HomeDir  = Join-Path $RepoRoot "staging-m42-user-home"
$DeployMarkerDir = Join-Path $RepoRoot "staging-data\m42"
$DeployMarker = Join-Path $DeployMarkerDir "DEPLOYED_COMMIT"
$PriorDir = Join-Path $RepoRoot "staging-m42-prior"
$PriorMeta = Join-Path $PriorDir "prior-meta.json"
$PriorDataDir = Join-Path $PriorDir "data"
$PriorHomeDir = Join-Path $PriorDir "user-home"
$PriorMarker = Join-Path $PriorDir "DEPLOYED_COMMIT"
$PriorImageTag = "archon-m42-staging:prior"

function Get-DockerCli {
  $cmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallback = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
  if (Test-Path $fallback) { return $fallback }
  Write-Error "docker CLI not found"
  exit 1
}
$Docker = Get-DockerCli

function Invoke-DockerAllowingProgressStderr {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  # Docker build/compose writes ordinary progress to stderr. Windows
  # PowerShell 5.1 promotes that stream to NativeCommandError under Stop.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $Docker @Arguments | Out-Host
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  return $code
}

if (-not (Test-Path $Compose)) {
  Write-Error "[m42-up] missing docker-compose.m42-staging.yml"
  exit 1
}

# Resolve exact commit (no credential tooling).
$sha = (git -C $RepoRoot rev-parse --verify "$Ref^{commit}").Trim()
if (-not $sha) { Write-Error "[m42-up] cannot resolve ref '$Ref'"; exit 1 }
$short = $sha.Substring(0, 8)
Write-Host "[m42-up] ref $Ref -> $sha"

# ---------------------------------------------------------------------------
# Retain prior M-42 staging image/config/data BEFORE candidate replacement.
# Credential-free only: image tag + data dirs + deploy marker. No secrets.
# ---------------------------------------------------------------------------
function Get-DockerImageIdIfPresent {
  param([Parameter(Mandatory = $true)][string]$ImageRef)

  # A missing first-run image is expected. Windows PowerShell 5.1 otherwise
  # promotes docker's stderr to a terminating NativeCommandError under Stop.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $rawId = (& $Docker image inspect -f "{{.Id}}" $ImageRef 2>$null)
  $inspectExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference

  if ($inspectExitCode -eq 0) { return $rawId }
  if ($inspectExitCode -eq 1) { return $null }
  Write-Error "[m42-up] docker image inspect failed for $ImageRef (exit $inspectExitCode)"
  exit 1
}

function Save-PriorM42Staging {
  $existingId = Get-DockerImageIdIfPresent -ImageRef "archon-m42-staging:current"
  if (-not $existingId) {
    Write-Host "[m42-up] no prior archon-m42-staging:current image; skip retention"
    return
  }

  $priorSha = ""
  if (Test-Path $DeployMarker) {
    $priorSha = (Get-Content $DeployMarker -Raw).Trim()
  }
  if ($priorSha -notmatch '^[0-9a-f]{40}$') {
    Write-Error "[m42-up] prior image exists but DEPLOYED_COMMIT is missing or invalid"
    exit 1
  }

  # Stop the prior M-42 container before copying its SQLite/data volume so the
  # retained backup is transactionally quiescent rather than a live file copy.
  $priorWasRunning = (& $Docker inspect -f "{{.State.Running}}" archon-m42-staging 2>$null) -eq "true"
  if ($priorWasRunning) {
    $downCode = Invoke-DockerAllowingProgressStderr -Arguments @("compose", "-f", $Compose, "down", "--remove-orphans")
    if ($downCode -ne 0) {
      Write-Error "[m42-up] failed to stop prior M-42 staging before retention"
      exit 1
    }
  }

  if (Test-Path $PriorDir) { Remove-Item -Recurse -Force $PriorDir }
  New-Item -ItemType Directory -Force -Path $PriorDir | Out-Null
  New-Item -ItemType Directory -Force -Path $PriorDataDir | Out-Null
  New-Item -ItemType Directory -Force -Path $PriorHomeDir | Out-Null

  & $Docker tag "archon-m42-staging:current" $PriorImageTag
  if ($LASTEXITCODE -ne 0) {
    Write-Error "[m42-up] failed to tag prior image"
    exit 1
  }

  if (Test-Path $DataDir) {
    Get-ChildItem -LiteralPath $DataDir -Force | Copy-Item -Destination $PriorDataDir -Recurse -Force
  }
  if (Test-Path $HomeDir) {
    Get-ChildItem -LiteralPath $HomeDir -Force | Copy-Item -Destination $PriorHomeDir -Recurse -Force
  }
  Set-Content -Path $PriorMarker -Value $priorSha -Encoding ascii -NoNewline

  $rawId = (& $Docker image inspect -f "{{.Id}}" $PriorImageTag 2>$null)
  if ($rawId -notmatch 'sha256:([0-9a-f]{64})') {
    Write-Error "[m42-up] prior image digest not a real sha256:64"
    exit 1
  }
  $priorDigest = "sha256:$($Matches[1])"
  $meta = [ordered]@{
    schema_version   = "m42-prior-retention-v1"
    prior_staging_sha = $priorSha
    prior_image_tag  = $PriorImageTag
    prior_image_digest = $priorDigest
    prior_was_running = [bool]$priorWasRunning
    retained_at      = (Get-Date).ToUniversalTime().ToString("o")
  }
  ($meta | ConvertTo-Json -Depth 4) | Set-Content -Path $PriorMeta -Encoding ascii
  Write-Host "[m42-up] retained prior staging sha=$priorSha digest=$priorDigest"
}

Save-PriorM42Staging

# Fresh empty data/home -- never seed host credentials.
if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir }
if (Test-Path $HomeDir) { Remove-Item -Recurse -Force $HomeDir }
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
New-Item -ItemType Directory -Force -Path $DeployMarkerDir | Out-Null

# Always build the exact detached ref (no skip path; no unrelated image relabel).
if (Test-Path $BuildDir) {
  git -C $RepoRoot worktree remove --force $BuildDir 2>$null
  if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
}
git -C $RepoRoot worktree add --detach $BuildDir $sha | Out-Null
Write-Host "[m42-up] building archon-m42-staging:$short (credential-free)..."
$buildCode = Invoke-DockerAllowingProgressStderr -Arguments @("build", "-t", "archon-m42-staging:$short", "-t", "archon-m42-staging:current", $BuildDir)
if ($buildCode -ne 0) { Write-Error "[m42-up] docker build failed"; exit 1 }
git -C $RepoRoot worktree remove --force $BuildDir 2>$null

# Stop any prior m42 container via this compose file only.
$downCode = Invoke-DockerAllowingProgressStderr -Arguments @("compose", "-f", $Compose, "down", "--remove-orphans")
if ($downCode -ne 0) { Write-Error "[m42-up] compose down failed"; exit 1 }

Write-Host "[m42-up] starting archon-m42-staging..."
$upCode = Invoke-DockerAllowingProgressStderr -Arguments @("compose", "-f", $Compose, "up", "-d")
if ($upCode -ne 0) { Write-Error "[m42-up] compose up failed"; exit 1 }

# Exact SHA proof marker (M-42 path, not shared staging-data/DEPLOYED_COMMIT).
Set-Content -Path $DeployMarker -Value $sha -Encoding ascii -NoNewline
Write-Host "[m42-up] wrote $DeployMarker = $sha"

# Wait for health on loopback 3092 -- fail closed if never ready.
$healthy = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:3092/api/health" -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -eq 200) { $healthy = $true; break }
  } catch {
    Start-Sleep -Seconds 2
  }
}
if (-not $healthy) {
  Write-Error "[m42-up] health endpoint never became ready on 127.0.0.1:3092"
  exit 1
}
Write-Host "[m42-up] health ok on 127.0.0.1:3092"

Write-Host "[m42-up] done. container=archon-m42-staging image=archon-m42-staging:$short"
exit 0
