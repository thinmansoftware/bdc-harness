# staging-up.ps1 -- build + boot the laptop Cauldron STAGING instance at a named git ref.
# WO-HARNESS-CAULDRON-LAPTOP-STAGING-01. See docs/staging.md for the promote flow.
#
# Usage:
#   powershell -File scripts/staging/staging-up.ps1 [-Ref origin/dev] [-SkipBuild]
#
# What it does:
#   1. Ensures .env.staging exists (creates from .env.staging.example with a fresh
#      random operator token + gh auth token on first run).
#   2. git fetch, resolves -Ref to a commit, checks out a CLEAN build worktree at
#      .staging-build/ and docker-builds the SAME Dockerfile as prod.
#   3. Tags archon-staging:<shortsha> + archon-staging:current, compose up.
#   4. Waits for http://127.0.0.1:3091/api/health to return 200, prints the
#      deployed commit (also written to staging-data/DEPLOYED_COMMIT).
#
# NOTE: the ref you stage MUST include the jq fix (PR #392) once merged --
# pre-#392 images are missing jq and fail workflow nodes (2026-07-10 outage #2).

[CmdletBinding()]
param(
  [string]$Ref = "origin/dev",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Compose  = Join-Path $RepoRoot "docker-compose.staging.yml"
$EnvFile  = Join-Path $RepoRoot ".env.staging"
$EnvExample = Join-Path $RepoRoot ".env.staging.example"
$BuildDir = Join-Path $RepoRoot ".staging-build"

function Get-DockerCli {
  $cmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallback = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
  if (Test-Path $fallback) { return $fallback }
  Write-Error "docker CLI not found. Install Docker Desktop (with WSL2 backend) and retry."
  exit 1
}
$Docker = Get-DockerCli

# --- 1. .env.staging bootstrap ------------------------------------------------
if (-not (Test-Path $EnvFile)) {
  Write-Host "[staging-up] .env.staging missing -- creating from template"
  $content = Get-Content $EnvExample -Raw

  # Fresh random operator token (32 bytes hex). NEVER the prod value.
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $tok = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
  $content = $content -replace "REPLACE_WITH_FRESH_RANDOM_HEX_NEVER_THE_PROD_VALUE", $tok

  # GitHub token from local gh CLI identity (documented choice, WO 5.1).
  $ghTok = ""
  try { $ghTok = (gh auth token 2>$null).Trim() } catch {}
  if ($ghTok) {
    $content = $content -replace "REPLACE_WITH_GH_AUTH_TOKEN", $ghTok
    Write-Host "[staging-up] GITHUB_TOKEN filled from 'gh auth token'"
  } else {
    Write-Warning "[staging-up] gh auth token unavailable -- edit .env.staging and set GITHUB_TOKEN manually"
  }
  Set-Content -Path $EnvFile -Value $content -Encoding ascii
  Write-Host "[staging-up] wrote .env.staging (gitignored) with a fresh staging operator token"
}
if ((Get-Content $EnvFile -Raw) -match "REPLACE_WITH_GH_AUTH_TOKEN") {
  Write-Warning "[staging-up] GITHUB_TOKEN is still a placeholder in .env.staging -- clones and canary pushes will fail"
}

# --- 1b. optional Claude creds seed for canary fires ---------------------------
$stagingClaude = Join-Path $RepoRoot "staging-user-home\.claude"
$hostCreds = Join-Path $env:USERPROFILE ".claude\.credentials.json"
if (-not (Test-Path (Join-Path $stagingClaude ".credentials.json"))) {
  if (Test-Path $hostCreds) {
    New-Item -ItemType Directory -Force -Path $stagingClaude | Out-Null
    Copy-Item $hostCreds (Join-Path $stagingClaude ".credentials.json")
    Write-Host "[staging-up] seeded staging-user-home/.claude/.credentials.json from laptop ~/.claude (local only, gitignored)"
  } else {
    Write-Warning "[staging-up] no Claude credentials found to seed -- canary fires on the claude lane will fail auth"
  }
}

# --- 2. resolve ref + clean build worktree -------------------------------------
git -C $RepoRoot fetch origin | Out-Null
$sha = (git -C $RepoRoot rev-parse --verify "$Ref^{commit}").Trim()
if (-not $sha) { Write-Error "[staging-up] cannot resolve ref '$Ref'"; exit 1 }
$short = $sha.Substring(0, 8)
Write-Host "[staging-up] ref $Ref -> $sha"

if (-not $SkipBuild) {
  if (Test-Path $BuildDir) {
    git -C $RepoRoot worktree remove --force $BuildDir 2>$null
    if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
  }
  git -C $RepoRoot worktree add --detach $BuildDir $sha | Out-Null
  Write-Host "[staging-up] building archon-staging:$short from clean worktree (same Dockerfile as prod)..."
  & $Docker build -t "archon-staging:$short" -t "archon-staging:current" $BuildDir
  if ($LASTEXITCODE -ne 0) { Write-Error "[staging-up] docker build failed"; exit 1 }
  git -C $RepoRoot worktree remove --force $BuildDir 2>$null
}

# --- 3. compose up --------------------------------------------------------------
New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot "staging-data") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot "staging-user-home") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot "staging-artifacts") | Out-Null
& $Docker compose -f $Compose up -d
if ($LASTEXITCODE -ne 0) { Write-Error "[staging-up] compose up failed"; exit 1 }

# --- 4. health wait + deployed-commit record ------------------------------------
$deadline = (Get-Date).AddSeconds(180)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:3091/api/health" -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $healthy = $true; break }
  } catch {}
  Start-Sleep -Seconds 3
}
if (-not $healthy) {
  Write-Error "[staging-up] /api/health did not return 200 on :3091 within 180s. Logs: docker logs archon-staging"
  exit 1
}
Set-Content -Path (Join-Path $RepoRoot "staging-data\DEPLOYED_COMMIT") -Value $sha -Encoding ascii
Write-Host "[staging-up] HEALTHY  http://127.0.0.1:3091/api/health = 200"
Write-Host "[staging-up] deployed commit: $sha ($Ref)"
Write-Host "[staging-up] next: scripts/staging/register-codebases.ps1 (first boot only), then staging-fire.ps1 for a canary"
