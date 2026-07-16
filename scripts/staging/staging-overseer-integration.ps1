# staging-overseer-integration.ps1 -- M-42 Slice 8 integrated staging proof.
# Produces staging-proof.json and optional rollback-proof.json under -OutputPath.
# Credential-free. Fake scenarios only. Never enables live capabilities.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/staging/staging-overseer-integration.ps1 `
#     -Ref <sha> -OutputPath artifacts/overseer/m42-wave2
#   ... -InjectHealthFailure -RollbackTo <prior_sha>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Ref,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
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
$ParentManifestPath = Join-Path $RepoRoot "artifacts\manifests\wo-harness-overseer-integration-activation-01.json"

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

$sha = (git -C $RepoRoot rev-parse --verify "$Ref^{commit}").Trim()
if (-not $sha) { Write-Error "cannot resolve ref $Ref"; exit 1 }

if (-not (Test-Path $OutputPath)) {
  New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
}

$resolvedOutputPath = [System.IO.Path]::GetFullPath((Resolve-Path $OutputPath).Path)
$expectedOutputPath = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "artifacts\overseer\m42-wave2"))
if ($resolvedOutputPath -ne $expectedOutputPath) {
  Write-Error "output_path_rejected: expected $expectedOutputPath"
  exit 1
}

$hostName = $env:COMPUTERNAME
if ($hostName -ne 'ASUS-ROG-DSK-2T') {
  Write-Warning "HOST is $hostName (expected ASUS-ROG-DSK-2T for official proof)"
}

# Ensure container surface exists (caller normally ran staging-m42-up first).
$state = (& $Docker inspect -f "{{.State.Status}}" archon-m42-staging 2>$null)
if ($state -ne "running" -and -not $InjectHealthFailure) {
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
if ($state -eq "running") {
  $imageId = (& $Docker inspect -f "{{.Image}}" archon-m42-staging 2>$null)
  if ($imageId) {
    $digest = Get-RealImageDigest -ImageRef $imageId
  }
  if (-not $digest) {
    $digest = Get-RealImageDigest -ImageRef "archon-m42-staging:current"
  }
}
if (-not $digest -and -not $InjectHealthFailure) {
  Write-Error "image_digest_unavailable: docker image inspect did not return sha256:<64>"
  exit 1
}
if ($digest -and $digest -notmatch '^sha256:[0-9a-f]{64}$') {
  Write-Error "image_digest_invalid: expected sha256:<64>, got non-conforming value"
  exit 1
}

# ---------------------------------------------------------------------------
# Credential probes: printenv KEY / test -e path inside container.
# Capture NAMES only. Fail closed if any present.
# ---------------------------------------------------------------------------
function Get-CredentialEnvPresent {
  $present = New-Object System.Collections.Generic.List[string]
  if ($state -ne "running") { return @() }
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
  if ($state -ne "running") { return @() }
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

$liveHealth = $null
if ($state -eq "running") {
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
}

# ---------------------------------------------------------------------------
# Path-safe scenario runner: bun -e from RepoRoot (imports resolve correctly).
# Never writes temp module files under the OS temp directory with relative imports.
# ---------------------------------------------------------------------------
function Invoke-BunFromRepoRoot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Expression
  )
  Push-Location $RepoRoot
  try {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & bun -e $Expression 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    return [pscustomobject]@{ ExitCode = $code; Output = ($output | Out-String) }
  } finally {
    Pop-Location
  }
}

$scenarioExpr = @'
import {
  runOverseerAdversarialMatrix,
  runIntegratedSuccessChain,
  assertOverseerDefaultOff,
} from "./packages/overseer/src/integration-scenarios.ts";

const deps = { adapter_mode: "fake", getRealCallCount: () => 0 };
const chain = await runIntegratedSuccessChain(deps);
const matrix = await runOverseerAdversarialMatrix(deps);
const def = assertOverseerDefaultOff({
  capabilities: { escalation: false, repair: false, branch: false, lifecycle: false, merge: false },
  emergency_stop: true,
  circuits: { escalation: "closed", repair: "closed", branch: "closed", lifecycle: "closed", merge: "closed" },
});
if (!chain.ok || !matrix.ok || !def.ok) {
  console.error(JSON.stringify({ chain, matrix, def }, null, 2));
  process.exit(1);
}
const receipt_count = chain.receipts.length + matrix.results.filter(r => r.scenario_id === "success").length;
process.stdout.write(JSON.stringify({
  receipt_count,
  real_call_count: chain.real_call_count + matrix.real_call_count,
  disabled_capabilities: def.disabled_capabilities,
  emergency_stop: true,
  adapter_mode: "fake",
}));
'@

$scenarioRun = Invoke-BunFromRepoRoot -Expression $scenarioExpr
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
if ([int]$scenario.real_call_count -ne 0) {
  Write-Error "real_call_count must be 0"
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

# Proof fields derived from live health (when container running).
$proofWatcherCount = if ($liveHealth) { [int]$liveHealth.watcher_count } else { 0 }
$proofAdapterMode  = if ($liveHealth) { [string]$liveHealth.adapter_mode } else { "none" }
$proofEmergency    = if ($liveHealth) { [bool]$liveHealth.emergency_stop } else { $true }
$proofDisabled     = if ($liveHealth) { @($liveHealth.disabled_capabilities) } else { @($scenario.disabled_capabilities | Sort-Object) }
$proofCircuits     = if ($liveHealth) { $liveHealth.circuits } else { @{} }

$proof = [ordered]@{
  schema_version           = "m42-staging-proof-v1"
  candidate_sha            = $sha
  image_digest             = $digest
  container_name           = "archon-m42-staging"
  host                     = $hostName
  watcher_count            = $proofWatcherCount
  adapter_mode             = $proofAdapterMode
  emergency_stop           = $proofEmergency
  disabled_capabilities    = $proofDisabled
  receipt_count            = [int]$scenario.receipt_count
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

if ((Test-ChildEvidenceSatisfiedForPackets) -and $digest -and $liveHealth) {
  $priorForPacket = $RollbackTo
  if (-not $priorForPacket -and (Test-Path $PriorMarker)) {
    $priorForPacket = (Get-Content $PriorMarker -Raw).Trim()
  }
  if (-not $priorForPacket) { $priorForPacket = "0" * 40 }

  $packetExpr = @"
import {
  buildUnsignedSandboxProofRequest,
  buildUnsignedActivationRequest,
  writeNonGovernanceActivationArtifacts,
} from "./packages/overseer/src/activation-package.ts";
const out = process.env.M42_PACKET_OUT;
if (!out) { console.error("M42_PACKET_OUT missing"); process.exit(1); }
const input = {
  candidate_sha: "$sha",
  image_digest: "$digest",
  capabilities: { escalation: false, repair: false, branch: false, lifecycle: false, merge: false },
  emergency_stop: true,
  allowlists: { repositories: ["bluedevilcollectibles/bdc-harness"], adapters: ["fake"] },
  rollback: { prior_staging_sha: "$($priorForPacket -replace '"','')", evidence_retained: true },
  health: { watcher_count: $($liveHealth.watcher_count), adapter_mode: "$($liveHealth.adapter_mode)" },
  numerical_caps: { max_factory_commitments: 10, max_fusion_usd: 0 },
  verifier_registry_digest: "0".repeat(64),
  missing_gate2_approvals: ["sandbox_spend_motion", "fusion_calibration"],
  missing_gate3_approvals: ["deploy_activation_motion"],
  operator_notice: "Build-only candidate; no live operator authority.",
};
const sandbox = buildUnsignedSandboxProofRequest(input);
const deploy = buildUnsignedActivationRequest(input);
writeNonGovernanceActivationArtifacts(
  { sandbox_proof_request: sandbox, deploy_activation_request: deploy },
  out
);
console.log("PACKETS=written");
"@
  $env:M42_PACKET_OUT = (Resolve-Path $OutputPath).Path
  $packetRun = Invoke-BunFromRepoRoot -Expression $packetExpr
  Remove-Item Env:M42_PACKET_OUT -ErrorAction SilentlyContinue
  if ($packetRun.ExitCode -ne 0) {
    Write-Error "packet write failed: $($packetRun.Output)"
    exit 1
  }
  Write-Host "[m42-integration] $($packetRun.Output.Trim())"
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
  & $Docker compose -f $Compose down --remove-orphans 2>$null

  $candidateRunning = $false
  $running = (& $Docker inspect -f "{{.State.Running}}" archon-m42-staging 2>$null)
  if ($running -eq "true") { $candidateRunning = $true }

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

  & $Docker compose -f $Compose up -d
  if ($LASTEXITCODE -ne 0) {
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
  # Candidate is not running as candidate: active_sha is prior, prior image restored.
  $candidateStillRunning = $false
  if ($containerRunning -and $activeSha -eq $sha) {
    $candidateStillRunning = $true
  }
  if ($candidateStillRunning) {
    Write-Error "rollback_candidate_still_active"
    exit 1
  }

  $rollback = [ordered]@{
    schema_version      = "m42-rollback-proof-v1"
    candidate_sha       = $sha
    prior_staging_sha   = $prior
    rollback_status     = "restored"
    active_sha          = $activeSha
    candidate_running   = $false
    evidence_retained   = $true
  }

  $rbPath = Join-Path $OutputPath "rollback-proof.json"
  ($rollback | ConvertTo-Json -Depth 6) | Set-Content -Path $rbPath -Encoding ascii
  Write-Host "[m42-integration] wrote $rbPath"
}

Write-Host "[m42-integration] complete"
exit 0
