# staging-overseer-integration.ps1 -- M-42 Slice 8 integrated staging proof.
# Produces staging-proof.json and optional rollback-proof.json under -OutputPath.
# Credential-free. Fake scenarios only. Never enables live capabilities.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/staging/staging-overseer-integration.ps1 `
#     -Ref <sha> -OutputPath <absolute-external-root> `
#     -ManifestPath <absolute-external-manifest> `
#     -ApprovedExternalArtifactRoot <absolute-external-root>
#   ... -InjectHealthFailure -RollbackTo <prior_sha>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Ref,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath,
  [Parameter(Mandatory = $true)]
  [string]$ApprovedExternalArtifactRoot,
  [switch]$InjectHealthFailure,
  [string]$RollbackTo = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Compose  = Join-Path $RepoRoot "docker-compose.m42-staging.yml"
$DeployMarker = Join-Path $RepoRoot "staging-data\m42\DEPLOYED_COMMIT"
$PriorDir = Join-Path $RepoRoot "staging-m42-prior"
$PriorMeta = Join-Path $PriorDir "prior-meta.json"
$PriorMarker = Join-Path $PriorDir "DEPLOYED_COMMIT"
$PriorDataDir = Join-Path $PriorDir "data"
$PriorHomeDir = Join-Path $PriorDir "user-home"
$PriorImageTag = "archon-m42-staging:prior"
$DataDir  = Join-Path $RepoRoot "staging-m42-data"
$HomeDir  = Join-Path $RepoRoot "staging-m42-user-home"
$OfficialProofHost = 'LAPTOP-BQ6IEJNC'

$CredentialEnvKeys = @(
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "CLAUDE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "CODEX_API_KEY"
)

$CredentialFilePaths = @(
  "/.archon/.credentials.json",
  "/.archon/credentials.json",
  "/home/appuser/.config/gh/hosts.yml",
  "/home/appuser/.config/gh/config.yml",
  "/home/appuser/.claude/.credentials.json",
  "/home/appuser/.codex/auth.json",
  "/home/appuser/.grok/auth.json",
  "/home/appuser/.openrouter/credentials",
  "/home/claude/.claude/.credentials.json",
  "/home/claude/.codex/auth.json",
  "/home/claude/.grok/auth.json",
  "/home/claude/.config/gh/hosts.yml"
)

function Get-DockerCli {
  $cmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallback = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
  if (Test-Path $fallback) { return $fallback }
  Write-Error "docker CLI not found"
  exit 1
}
$Docker = Get-DockerCli

function Assert-NoReparseAncestor {
  param([Parameter(Mandatory = $true)][string]$Path)

  $probe = [System.IO.Path]::GetFullPath($Path)
  while (-not (Test-Path -LiteralPath $probe)) {
    $parent = Split-Path -Parent $probe
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $probe) { break }
    $probe = $parent
  }
  while (-not [string]::IsNullOrWhiteSpace($probe) -and (Test-Path -LiteralPath $probe)) {
    $item = Get-Item -LiteralPath $probe -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      Write-Error "output_path_rejected: symlink/reparse ancestor not allowed: $probe"
      exit 1
    }
    $parent = Split-Path -Parent $probe
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $probe) { break }
    $probe = $parent
  }
}

function Invoke-DockerAllowingProgressStderr {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $Docker @Arguments | Out-Host
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  return $code
}

$sha = (git -C $RepoRoot rev-parse --verify "$Ref^{commit}").Trim()
if (-not $sha) { Write-Error "cannot resolve ref $Ref"; exit 1 }

# Artifacts are authoritative only under an explicit absolute external root.
# Never write proof, packets, or the finalized manifest into the repository.
foreach ($path in @($OutputPath, $ManifestPath, $ApprovedExternalArtifactRoot)) {
  if ([string]::IsNullOrWhiteSpace($path) -or -not [System.IO.Path]::IsPathRooted($path)) {
    Write-Error "output_path_rejected: all artifact paths must be absolute"
    exit 1
  }
  if (($path -split '[\\/]') -contains '..') {
    Write-Error "output_path_rejected: traversal is not allowed"
    exit 1
  }
  Assert-NoReparseAncestor -Path $path
}
$approvedRoot = [System.IO.Path]::GetFullPath($ApprovedExternalArtifactRoot).TrimEnd([char[]]'\/')
$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath).TrimEnd([char[]]'\/')
$ParentManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)
$repoFull = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd([char[]]'\/')
$approvedPrefix = $approvedRoot + [System.IO.Path]::DirectorySeparatorChar
$repoPrefix = $repoFull + [System.IO.Path]::DirectorySeparatorChar
if (
  $approvedRoot -eq $repoFull -or
  $approvedRoot.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
  $repoFull.StartsWith($approvedPrefix, [System.StringComparison]::OrdinalIgnoreCase)
) {
  Write-Error "output_path_rejected: approved root must be outside repository"
  exit 1
}
foreach ($path in @($resolvedOutputPath, $ParentManifestPath)) {
  if (
    $path -ne $approvedRoot -and
    -not $path.StartsWith($approvedPrefix, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    Write-Error "output_path_rejected: artifact path is outside approved external root"
    exit 1
  }
}
if (-not (Test-Path $approvedRoot)) {
  New-Item -ItemType Directory -Force -Path $approvedRoot | Out-Null
}
if (-not (Test-Path $resolvedOutputPath)) {
  New-Item -ItemType Directory -Force -Path $resolvedOutputPath | Out-Null
}
$item = Get-Item -LiteralPath $resolvedOutputPath -Force
$OutputPath = [System.IO.Path]::GetFullPath($item.FullName)

$hostName = $env:COMPUTERNAME
if ($hostName -ne $OfficialProofHost) {
  Write-Warning "HOST is $hostName (expected $OfficialProofHost for official proof)"
}

# Ensure container surface exists (caller normally ran staging-m42-up first).
$state = (& $Docker inspect -f "{{.State.Status}}" archon-m42-staging 2>$null)
if ($state -ne "running") {
  Write-Error "archon-m42-staging is not running; run staging-m42-up.ps1 first"
  exit 1
}

# ---------------------------------------------------------------------------
# Real image digest only -- never fabricate a hash from the candidate SHA.
# Requires docker image Id form sha256:<64 hex>.
# ---------------------------------------------------------------------------
function Get-RealImageDigest {
  param([string]$ImageRef)
  $rawId = (& $Docker image inspect -f "{{.Id}}" $ImageRef 2>$null)
  if ($rawId -match '^(sha256:[0-9a-f]{64})$') {
    return $Matches[1]
  }
  if ($rawId -match 'sha256:([0-9a-f]{64})') {
    return "sha256:$($Matches[1])"
  }
  return $null
}

$digest = $null
$imageId = (& $Docker inspect -f "{{.Image}}" archon-m42-staging 2>$null)
if ($imageId) {
  $digest = Get-RealImageDigest -ImageRef $imageId
}
if (-not $digest) {
  $digest = Get-RealImageDigest -ImageRef "archon-m42-staging:current"
}
if (-not $digest) {
  Write-Error "image_digest_unavailable: docker image inspect did not return sha256:<64>"
  exit 1
}
if ($digest -notmatch '^sha256:[0-9a-f]{64}$') {
  Write-Error "image_digest_invalid: expected sha256:<64>, got non-conforming value"
  exit 1
}

# ---------------------------------------------------------------------------
# Credential probes: printenv KEY / test -e path inside container.
# Capture NAMES only. Fail closed if any present.
# ---------------------------------------------------------------------------
function Get-CredentialEnvPresent {
  $present = New-Object System.Collections.Generic.List[string]
  foreach ($key in $CredentialEnvKeys) {
    # printenv KEY exits nonzero when absent; present-but-empty also reports the key.
    $out = & $Docker exec archon-m42-staging printenv $key 2>$null
    $code = $LASTEXITCODE
    if ($code -eq 0) {
      # Key is present in the environment (even if empty string).
      $present.Add($key) | Out-Null
    }
  }
  return ,$present.ToArray()
}

function Get-CredentialFilesPresent {
  $present = New-Object System.Collections.Generic.List[string]
  foreach ($path in $CredentialFilePaths) {
    & $Docker exec archon-m42-staging test -e $path 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $present.Add($path) | Out-Null
    }
  }
  return ,$present.ToArray()
}

$credEnvPresent = @(Get-CredentialEnvPresent)
$credFilesPresent = @(Get-CredentialFilesPresent)
if ($credEnvPresent.Count -gt 0 -or $credFilesPresent.Count -gt 0) {
  Write-Error ("credential_probe_failed: env=[{0}] files=[{1}]" -f ($credEnvPresent -join ','), ($credFilesPresent -join ','))
  exit 1
}

# ---------------------------------------------------------------------------
# Derive health/gates from live /api/health -- never hardcode watcher/adapter.
# ---------------------------------------------------------------------------
function Get-LiveOverseerHealth {
  $healthRaw = $null
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:3092/api/health" -UseBasicParsing -TimeoutSec 5
    $healthRaw = $resp.Content
  } catch {
    Write-Error "failed to fetch /api/health: $($_.Exception.Message)"
    exit 1
  }
  $health = $healthRaw | ConvertFrom-Json
  if (-not $health.overseer) {
    Write-Error "health_missing_overseer: /api/health has no overseer object"
    exit 1
  }
  $o = $health.overseer
  $watcherState = [string]$o.watcher
  $adapterMode = [string]$o.adapter
  $emergencyStop = [bool]$o.emergency_stop
  $caps = $o.capability_flags
  $circuits = $o.circuit_states

  $watcherCount = 0
  if ($watcherState -eq "running") { $watcherCount = 1 }

  $disabled = @()
  $allCapsFalse = $true
  foreach ($cap in @("escalation", "repair", "branch", "lifecycle", "merge")) {
    if ($null -eq $caps -or $caps.PSObject.Properties.Name -notcontains $cap) {
      Write-Error "health_gate_failed: capability flag missing for $cap"
      exit 1
    }
    $flag = [bool]$caps.$cap
    if ($flag) { $allCapsFalse = $false } else { $disabled += $cap }
  }
  $disabled = @($disabled | Sort-Object)

  $circuitMap = @{}
  foreach ($cap in @("escalation", "repair", "branch", "lifecycle", "merge")) {
    if ($null -eq $circuits -or $circuits.PSObject.Properties.Name -notcontains $cap) {
      Write-Error "health_gate_failed: circuit state missing for $cap"
      exit 1
    }
    $cval = [string]$circuits.$cap
    if ($cval -notin @("closed", "open", "unknown")) {
      Write-Error "health_gate_failed: invalid circuit state for $cap"
      exit 1
    }
    $circuitMap[$cap] = $cval
  }

  return [pscustomobject]@{
    watcher_count         = $watcherCount
    watcher_state         = $watcherState
    adapter_mode          = $adapterMode
    emergency_stop        = $emergencyStop
    disabled_capabilities = $disabled
    all_caps_false        = $allCapsFalse
    circuits              = $circuitMap
  }
}

$liveHealth = Get-LiveOverseerHealth
if ($liveHealth.watcher_count -ne 1) {
  Write-Error "health_gate_failed: expected exactly one running watcher, got watcher_state=$($liveHealth.watcher_state) count=$($liveHealth.watcher_count)"
  exit 1
}
if ($liveHealth.adapter_mode -ne "fake") {
  Write-Error "health_gate_failed: expected adapter_mode=fake, got $($liveHealth.adapter_mode)"
  exit 1
}
if (-not $liveHealth.emergency_stop) {
  Write-Error "health_gate_failed: emergency_stop must be true"
  exit 1
}
if (-not $liveHealth.all_caps_false) {
  Write-Error "health_gate_failed: all five capability flags must be false"
  exit 1
}

# ---------------------------------------------------------------------------
# In-container integration runner against the exact candidate image.
# Host working-tree bun -e does NOT count as candidate proof.
# Real-call count is observed by the fake adapter boundary inside the image.
# ---------------------------------------------------------------------------
function Invoke-M42IntegrationRunnerInContainer {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  # Production Dockerfile copies packages/overseer into the candidate image.
  $output = & $Docker exec archon-m42-staging bun run /app/packages/overseer/src/m42-integration-runner.ts 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  return [pscustomobject]@{ ExitCode = $code; Output = ($output | Out-String) }
}

$scenarioRun = Invoke-M42IntegrationRunnerInContainer
if ($scenarioRun.ExitCode -ne 0) {
  Write-Error "scenario runner failed: $($scenarioRun.Output)"
  exit 1
}
$scenarioLine = ($scenarioRun.Output -split "`n" | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
if (-not $scenarioLine) {
  Write-Error "scenario runner produced no JSON: $($scenarioRun.Output)"
  exit 1
}
$scenario = $scenarioLine | ConvertFrom-Json
if ($null -eq $scenario.real_call_count) {
  Write-Error "scenario_receipt_missing_real_call_count"
  exit 1
}
if ([int]$scenario.real_call_count -ne 0) {
  Write-Error "real_call_count must be 0 (observed by container fake boundary)"
  exit 1
}
if ([string]$scenario.adapter_mode -ne "fake") {
  Write-Error "scenario_adapter_mode_not_fake"
  exit 1
}

$deployed = $sha
if (Test-Path $DeployMarker) {
  $deployed = (Get-Content $DeployMarker -Raw).Trim()
}
if ($deployed -ne $sha) {
  Write-Error "deployed_ref_mismatch: marker=$deployed candidate=$sha"
  exit 1
}

# Proof fields derived from live health only -- no fabricated emergency_stop/default true.
$proof = [ordered]@{
  schema_version           = "m42-staging-proof-v1"
  candidate_sha            = $sha
  image_digest             = $digest
  container_name           = "archon-m42-staging"
  host                     = $hostName
  watcher_count            = [int]$liveHealth.watcher_count
  adapter_mode             = [string]$liveHealth.adapter_mode
  emergency_stop           = [bool]$liveHealth.emergency_stop
  disabled_capabilities    = @($liveHealth.disabled_capabilities)
  receipt_count            = [int]$scenario.receipt_count
  operator_card_count      = [int]$scenario.operator_card_count
  real_call_count          = [int]$scenario.real_call_count
  credential_env_present   = @($credEnvPresent)
  credential_files_present = @($credFilesPresent)
}

$proofPath = Join-Path $OutputPath "staging-proof.json"
($proof | ConvertTo-Json -Depth 6) | Set-Content -Path $proofPath -Encoding ascii
Write-Host "[m42-integration] wrote $proofPath"

# ---------------------------------------------------------------------------
# Unsigned packets only after completed staging proof AND satisfied child reviews.
# Fail closed: do not store packets while parent manifest is BLOCKED.
# ---------------------------------------------------------------------------
function Test-ChildEvidenceSatisfiedForPackets {
  if (-not (Test-Path $ParentManifestPath)) {
    Write-Host "[m42-integration] parent manifest missing; skip packet write"
    return $false
  }
  $man = Get-Content $ParentManifestPath -Raw | ConvertFrom-Json
  if ($man.status -eq "READY_FOR_SANDBOX_PROOF_REQUEST") {
    return $true
  }
  Write-Host "[m42-integration] parent status=$($man.status); skip unsigned packet write (fail-closed)"
  return $false
}

# Packets require READY parent manifest + real prior SHA + real verifier digest
# + completed staging/rollback proofs. No zero-SHA or zero-digest placeholders.
if (Test-ChildEvidenceSatisfiedForPackets) {
  Write-Host "[m42-integration] parent READY but in-container packet writer is gated on complete rollback_proof + non-zero verifier registry; skipping host packet fabrication"
  Write-Host "[m42-integration] unsigned packets not written (require READY+staging+rollback evidence; no placeholder digests)"
} else {
  Write-Host "[m42-integration] unsigned packets not written (staging/review gate closed)"
}

# ---------------------------------------------------------------------------
# Real retained-prior rollback on InjectHealthFailure.
# ---------------------------------------------------------------------------
if ($InjectHealthFailure) {
  if (-not $RollbackTo) {
    Write-Error "-RollbackTo is required with -InjectHealthFailure"
    exit 1
  }
  $prior = (git -C $RepoRoot rev-parse --verify "$RollbackTo^{commit}").Trim()
  Write-Host "[m42-integration] injecting synthetic health failure; rolling back to $prior"

  if (-not (Test-Path $PriorMeta) -or -not (Test-Path $PriorMarker)) {
    Write-Error "retained_prior_missing: staging-m42-prior evidence not found (prior-meta.json / DEPLOYED_COMMIT)"
    exit 1
  }
  $priorMetaObj = Get-Content $PriorMeta -Raw | ConvertFrom-Json
  $retainedSha = (Get-Content $PriorMarker -Raw).Trim()
  if ($retainedSha -ne $prior) {
    Write-Error "retained_prior_mismatch: retained=$retainedSha requested=$prior"
    exit 1
  }
  $priorImg = (& $Docker image inspect -f "{{.Id}}" $PriorImageTag 2>$null)
  if (-not $priorImg) {
    Write-Error "retained_prior_image_missing: $PriorImageTag not present"
    exit 1
  }

  # Stop candidate container.
  $downCode = Invoke-DockerAllowingProgressStderr -Arguments @("compose", "-f", $Compose, "down", "--remove-orphans")
  if ($downCode -ne 0) {
    Write-Error "rollback compose down failed"
    exit 1
  }

  # Restore prior image as :current and restore data/home + deploy marker.
  & $Docker tag $PriorImageTag "archon-m42-staging:current"
  if ($LASTEXITCODE -ne 0) {
    Write-Error "failed to retag prior image as current"
    exit 1
  }

  if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir }
  if (Test-Path $HomeDir) { Remove-Item -Recurse -Force $HomeDir }
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
  if (Test-Path $PriorDataDir) {
    Copy-Item -Recurse -Force (Join-Path $PriorDataDir "*") $DataDir -ErrorAction SilentlyContinue
  }
  if (Test-Path $PriorHomeDir) {
    Copy-Item -Recurse -Force (Join-Path $PriorHomeDir "*") $HomeDir -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $DeployMarker) | Out-Null
  Set-Content -Path $DeployMarker -Value $retainedSha -Encoding ascii -NoNewline

  $upCode = Invoke-DockerAllowingProgressStderr -Arguments @("compose", "-f", $Compose, "up", "-d")
  if ($upCode -ne 0) {
    Write-Error "rollback compose up failed"
    exit 1
  }

  $restoredHealthy = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $resp = Invoke-WebRequest -Uri "http://127.0.0.1:3092/api/health" -UseBasicParsing -TimeoutSec 2
      if ($resp.StatusCode -eq 200) { $restoredHealthy = $true; break }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  if (-not $restoredHealthy) {
    Write-Error "rollback_health_failed: prior image never became ready"
    exit 1
  }

  $activeSha = (Get-Content $DeployMarker -Raw).Trim()
  if ($activeSha -ne $prior) {
    Write-Error "rollback_marker_mismatch: active=$activeSha expected=$prior"
    exit 1
  }

  $runningAfter = (& $Docker inspect -f "{{.State.Running}}" archon-m42-staging 2>$null)
  $containerRunning = $runningAfter -eq "true"
  $restoredContainerImage = (& $Docker inspect -f "{{.Image}}" archon-m42-staging 2>$null)
  $restoredImageDigest = Get-RealImageDigest -ImageRef $restoredContainerImage
  if ($restoredImageDigest -ne [string]$priorMetaObj.prior_image_digest) {
    Write-Error "rollback_image_mismatch: active=$restoredImageDigest retained=$($priorMetaObj.prior_image_digest)"
    exit 1
  }
  $candidateRunning = $containerRunning -and ($activeSha -eq $sha)
  if ($candidateRunning) {
    Write-Error "rollback_candidate_still_active"
    exit 1
  }

  # Derive evidence_retained from actual retained artifacts -- never hardcode true.
  $priorImageStillPresent = $false
  $priorImgCheck = (& $Docker image inspect -f "{{.Id}}" $PriorImageTag 2>$null)
  if ($priorImgCheck) { $priorImageStillPresent = $true }
  $evidenceRetained = (
    (Test-Path $PriorMeta) -and
    (Test-Path $PriorMarker) -and
    $priorImageStillPresent -and
    ($restoredImageDigest -eq [string]$priorMetaObj.prior_image_digest)
  )
  if (-not $evidenceRetained) {
    Write-Error "rollback_evidence_not_retained"
    exit 1
  }

  $rollback = [ordered]@{
    schema_version      = "m42-rollback-proof-v1"
    candidate_sha       = $sha
    prior_staging_sha   = $prior
    rollback_status     = "restored"
    active_sha          = $activeSha
    candidate_running   = [bool]$candidateRunning
    evidence_retained   = [bool]$evidenceRetained
  }

  $rbPath = Join-Path $OutputPath "rollback-proof.json"
  ($rollback | ConvertTo-Json -Depth 6) | Set-Content -Path $rbPath -Encoding ascii
  Write-Host "[m42-integration] wrote $rbPath"
}

Write-Host "[m42-integration] complete"
exit 0
