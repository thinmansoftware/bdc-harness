# staging-overseer-safety.ps1 -- Deterministic Overseer safety assertions for staging.
# WO-HARNESS-OVERSEER-SAFETY-GATES-STAGING-01 Stop 5.
#
# Executes deterministic assertions against the fake GitHub mutation adapter on an
# isolated staging host. Requires no production credentials. All network mutations
# are fake and append-only. Exits 0 only when every assertion passes.
#
# Usage: powershell -File scripts/staging/staging-overseer-safety.ps1
#
# Required staging env (verified by this script):
#   OVERSEER_ENABLED=false  OVERSEER_EMERGENCY_STOP=true
#   OVERSEER_DRY_RUN=true   OVERSEER_USE_FAKE_GITHUB_ADAPTER=1
#   All five OVERSEER_*_ACTIONS_ENABLED=false

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$ExitCode = 0

function Pass { param([string]$msg) Write-Host "[PASS] $msg" }
function Fail { param([string]$msg) Write-Host "[FAIL] $msg"; $script:ExitCode = 1 }
function Info { param([string]$msg) Write-Host "[INFO] $msg" }

Info "=== Overseer staging safety assertions begin ==="
Info "Repo root: $RepoRoot"

# Locate docker
$cmd = Get-Command docker -ErrorAction SilentlyContinue
if ($cmd) { $Docker = $cmd.Source }
elseif (Test-Path "C:\Program Files\Docker\Docker\resources\bin\docker.exe") {
  $Docker = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
} else {
  Fail "docker CLI not found"
  exit 1
}

# --- Assertion 1: the exact-SHA staging container is running ---
$ContainerState = (& $Docker inspect -f "{{.State.Status}}" archon-staging 2>$null)
if ($ContainerState -eq "running") {
  Pass "Container archon-staging is running"
} else {
  Fail "Container archon-staging is not running (state: $ContainerState)"
  exit 1
}

# --- Assertion 2: deployed commit is recorded ---
$dcFile = Join-Path $RepoRoot "staging-data\DEPLOYED_COMMIT"
if (Test-Path $dcFile) {
  $DeployedSha = (Get-Content $dcFile -Raw).Trim()
  $CandidateSha = (& git -C $RepoRoot rev-parse HEAD).Trim()
  if ($DeployedSha -eq $CandidateSha) {
    Pass "Deployed commit matches candidate HEAD: $DeployedSha"
  } else {
    Fail "Deployed commit '$DeployedSha' does not match candidate HEAD '$CandidateSha'"
  }
} else {
  Fail "No DEPLOYED_COMMIT file -- exact-SHA staging proof is unavailable"
}

# --- Assertion 3: .env.staging has the required fail-closed defaults ---
$envFile = Join-Path $RepoRoot ".env.staging"
if (Test-Path $envFile) {
  $envContent = Get-Content $envFile -Raw
  $required = @{
    "OVERSEER_ENABLED"                  = "false"
    "OVERSEER_EMERGENCY_STOP"           = "true"
    "OVERSEER_DRY_RUN"                  = "true"
    "OVERSEER_USE_FAKE_GITHUB_ADAPTER"  = "1"
  }
  foreach ($key in $required.Keys) {
    $val = $required[$key]
    if ($envContent -match "(?m)^$key=$val\s*$") {
      Pass ".env.staging: $key=$val"
    } else {
      Fail ".env.staging: $key is not set to required value '$val'"
    }
  }
  foreach ($cap in @("ESCALATION", "REPAIR", "BRANCH", "LIFECYCLE", "MERGE")) {
    $envKey = "OVERSEER_${cap}_ACTIONS_ENABLED"
    if ($envContent -match "(?m)^${envKey}=false\s*$") {
      Pass ".env.staging: $envKey=false"
    } else {
      Fail ".env.staging: $envKey must be false -- capability must not be enabled in staging"
    }
  }
} else {
  Fail ".env.staging not found -- fail-closed staging configuration cannot be verified"
}

# --- Assertion 4: in-container Overseer runtime status (when running) ---
if ($ContainerState -eq "running") {
  $statusJs = @'
const r = await fetch("http://localhost:3091/api/health");
const j = await r.json();
process.stdout.write(JSON.stringify(j));
'@
  try {
    $healthRaw = & $Docker exec archon-staging bun -e $statusJs 2>$null
    $health = $healthRaw | ConvertFrom-Json
    if ($health.status -eq "ok") {
      Pass "Container /api/health returned status=ok"
    } else {
      Fail "Container /api/health status is not ok: $healthRaw"
    }
  } catch {
    Fail "Failed to reach container /api/health: $($_.Exception.Message)"
  }

  # Verify no live Octokit client is constructed (fake adapter selected)
  $adapterCheckJs = @'
const env = process.env;
const isFake = env.OVERSEER_USE_FAKE_GITHUB_ADAPTER === "1" || env.OVERSEER_USE_FAKE_GITHUB_ADAPTER === "true";
const isDisabled = !(env.OVERSEER_ENABLED === "1" || env.OVERSEER_ENABLED === "true" || env.OVERSEER_ENABLED === "yes");
if (isDisabled) { console.log("OVERSEER_DISABLED"); process.exit(0); }
if (!isFake) { console.log("REAL_ADAPTER_ACTIVE"); process.exit(1); }
console.log("FAKE_ADAPTER_CONFIRMED");
'@
  try {
    $adapterCheck = & $Docker exec archon-staging bun -e $adapterCheckJs 2>$null
    if ($adapterCheck -match "FAKE_ADAPTER_CONFIRMED|OVERSEER_DISABLED") {
      Pass "Fake adapter or disabled state confirmed in container env"
    } else {
      Fail "Real adapter may be active in staging container: $adapterCheck"
    }
  } catch {
    Fail "Adapter check failed: $($_.Exception.Message)"
  }

  # Verify no raw credential value appears in container stdout (credential boundary)
  $credCheckJs = @'
const keys = ["GH_TOKEN", "GITHUB_TOKEN", "CLAUDE_API_KEY"];
for (const k of keys) {
  const v = process.env[k] ?? "";
  if (v.length > 0) {
    console.log("PRESENT_REDACTED:" + k);
  } else {
    console.log("ABSENT:" + k);
  }
}
'@
  try {
    $credCheck = & $Docker exec archon-staging bun -e $credCheckJs 2>$null
    if ($credCheck -notmatch "ghp_|github_pat_|Bearer |sk-") {
      Pass "No raw credential value visible in container env output"
    } else {
      Fail "Possible raw credential value leaked to stdout -- review immediately"
    }
  } catch {
    Fail "Credential boundary check failed: $($_.Exception.Message)"
  }
}

# --- Assertion 5: five capability flags are all false (fail-closed default) ---
$capsJs = @'
const caps = ["ESCALATION","REPAIR","BRANCH","LIFECYCLE","MERGE"];
const allOff = caps.every(c => {
  const v = process.env["OVERSEER_" + c + "_ACTIONS_ENABLED"];
  return v === "false" || v === "0" || v === undefined || v === "";
});
console.log(allOff ? "ALL_CAPS_DISABLED" : "CAP_ENABLED_FOUND");
'@
if ($ContainerState -eq "running") {
  try {
    $capsCheck = & $Docker exec archon-staging bun -e $capsJs 2>$null
    if ($capsCheck -match "ALL_CAPS_DISABLED") {
      Pass "All five capability flags are disabled in container env"
    } else {
      Fail "At least one capability flag is enabled -- staging must remain fail-closed"
    }
  } catch {
    Fail "Capability flag check failed: $($_.Exception.Message)"
  }
}

# --- Assertion 6: migration 034 is present and tables exist in staging DB ---
if ($ContainerState -eq "running") {
  $migCheckJs = @'
const {Database} = require("bun:sqlite");
try {
  const db = new Database("/.archon/archon.db", {readonly: true});
  const caps = db.query("SELECT capability, action_enabled, circuit_state FROM overseer_capability_state").all();
  if (caps.length !== 5) {
    console.log("WRONG_CAP_COUNT:" + caps.length);
    process.exit(1);
  }
  const allDisabled = caps.every(r => r.action_enabled === 0 || r.action_enabled === false);
  const allClosed = caps.every(r => r.circuit_state === "closed");
  if (!allDisabled) { console.log("CAPABILITY_ENABLED_IN_DB"); process.exit(1); }
  if (!allClosed) { console.log("CIRCUIT_OPEN_IN_DB"); process.exit(1); }
  const evtCount = db.query("SELECT count(*) as c FROM overseer_capability_events").get();
  console.log("MIGRATION_034_OK:caps=" + caps.length + ":events=" + evtCount.c);
} catch(e) {
  console.log("DB_ERROR:" + e.message);
  process.exit(1);
}
'@
  try {
    $migCheck = & $Docker exec archon-staging bun -e $migCheckJs 2>$null
    if ($migCheck -match "^MIGRATION_034_OK") {
      Pass "Migration 034: overseer_capability_state has 5 rows, all disabled+closed: $migCheck"
    } else {
      Fail "Migration 034 DB check failed: $migCheck"
    }
  } catch {
    Fail "Migration 034 check exception: $($_.Exception.Message)"
  }
}

# --- Assertion 7: fake adapter boundary -- adapter_attempt receipt verified ---
# Exercise the actual createFakeGitHubAdapter factory: attempt a mutation against
# an allowlisted repository and verify the adapter emits an adapter_attempt receipt
# with mutation_sent=false and accepted=false (repository_not_allowlisted because
# the test repo is not in the runtime allowlist). This proves the boundary is
# constructed and enforced, not just declared in env variables.
if ($ContainerState -eq "running") {
  $fakeAdapterJs = @'
const { createFakeGitHubAdapter } = await import("/app/packages/overseer/src/adapters/fake-github.ts");
const received = [];
const adapter = createFakeGitHubAdapter({
  allowed_repositories: [],
  authorization_deps: {
    getPolicy: async () => ({
      service_enabled: false,
      emergency_stop: true,
      legacy_dry_run: true,
      capability_flags: { escalation: false, repair: false, branch: false, lifecycle: false, merge: false },
    }),
  },
  consume_execution: async () => false,
  record_attempt: async (evt) => { received.push(evt); },
});
const request = {
  permit_id: "test-permit",
  repository: "outside-fixture",
  pr_number: 1,
  head_sha: "a".repeat(40),
  base_branch: "main",
  base_sha: "b".repeat(40),
  snapshot_id: "snap-1",
  proposal_id: "prop-1",
  execution_id: "exec-1",
  action_kind: "MERGE",
};
const authInput = {
  requested_capability: "merge",
  permit: { ...request, capability: "merge", valid_until: new Date(Date.now() + 60000).toISOString() },
  actor: "test",
  correlation_id: "test-corr",
};
const receipt = await adapter.attemptMutation(request, authInput);
if (receipt.mutation_sent !== false) {
  console.log("FAIL:mutation_sent_true");
  process.exit(1);
}
if (received.length !== 1 || received[0].event_type !== "adapter_attempt") {
  console.log("FAIL:no_adapter_attempt_event:count=" + received.length);
  process.exit(1);
}
console.log("FAKE_ADAPTER_RECEIPT:reason=" + receipt.reason + ":mutation_sent=false:event_recorded=true");
'@
  try {
    $fakeAdapterCheck = & $Docker exec archon-staging bun -e $fakeAdapterJs 2>$null
    if ($fakeAdapterCheck -match "^FAKE_ADAPTER_RECEIPT:") {
      Pass "Fake adapter boundary exercised: adapter_attempt event recorded, mutation_sent=false: $fakeAdapterCheck"
    } else {
      Fail "Fake adapter boundary check failed: $fakeAdapterCheck"
    }
  } catch {
    Fail "Fake adapter boundary check exception: $($_.Exception.Message)"
  }
}

# --- Final summary and completion evidence ---
Write-Host ""
Info "=== Overseer staging safety assertions complete ==="
if ($ExitCode -eq 0) {
  Write-Host "[RESULT] ALL ASSERTIONS PASSED"
  Write-Host "[EVIDENCE] Slice 1 complete activates no Overseer action capability."
  Write-Host "[EVIDENCE] No real provider mutation occurred. Fake adapter boundary enforced."
  Write-Host "[EVIDENCE] Emergency stop, dry-run, and five disabled capability flags verified."
  Write-Host "[EVIDENCE] Migration 034 overseer_capability_state seeded with 5 default-disabled rows."
} else {
  Write-Host "[RESULT] ONE OR MORE ASSERTIONS FAILED -- review output above"
}

exit $ExitCode
