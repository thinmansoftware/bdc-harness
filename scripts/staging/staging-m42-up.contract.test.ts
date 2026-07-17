import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const launcherPath = join(repoRoot, 'scripts', 'staging', 'staging-m42-up.ps1');
const integrationPath = join(repoRoot, 'scripts', 'staging', 'staging-overseer-integration.ps1');
const composePath = join(repoRoot, 'docker-compose.m42-staging.yml');
const parentManifestPath = join(
  repoRoot,
  'artifacts',
  'manifests',
  'wo-harness-overseer-integration-activation-01.json'
);
const packetSandbox = join(
  repoRoot,
  'artifacts',
  'overseer',
  'm42-wave2',
  'sandbox-proof-request.json'
);
const packetDeploy = join(
  repoRoot,
  'artifacts',
  'overseer',
  'm42-wave2',
  'deploy-activation-request.json'
);

const CREDENTIAL_KEYS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'CLAUDE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'CODEX_API_KEY',
] as const;

describe('staging-m42-up credential-free contract', () => {
  test('launcher never references host credential or shared staging paths', () => {
    expect(existsSync(launcherPath)).toBe(true);
    const src = readFileSync(launcherPath, 'utf8');

    const forbidden = [
      'gh auth',
      'USERPROFILE',
      '.credentials.json',
      '.env.staging',
      'staging-up.ps1',
    ];
    for (const token of forbidden) {
      expect(src.includes(token)).toBe(false);
    }

    expect(src.includes('archon-m42-staging')).toBe(true);
    expect(src.includes('docker-compose.m42-staging.yml')).toBe(true);
    expect(src.includes('DEPLOYED_COMMIT')).toBe(true);
    expect(src.includes('staging-data\\m42') || src.includes('staging-data/m42')).toBe(true);
  });

  test('launcher fails nonzero when health never becomes ready and never SkipBuild', () => {
    const src = readFileSync(launcherPath, 'utf8');
    expect(src.includes('[switch]$SkipBuild')).toBe(false);
    expect(/\bparam\s*\([\s\S]*SkipBuild/.test(src)).toBe(false);
    expect(src.includes('health endpoint never became ready')).toBe(true);
    expect(src.includes('Write-Error "[m42-up] health endpoint never became ready')).toBe(true);
    // Always builds exact detached ref
    expect(src.includes('worktree add --detach')).toBe(true);
    expect(src.includes('Invoke-DockerAllowingProgressStderr -Arguments @("build"')).toBe(true);
  });

  test('launcher retains prior M-42 image/config/data before candidate replacement', () => {
    const src = readFileSync(launcherPath, 'utf8');
    expect(src.includes('staging-m42-prior')).toBe(true);
    expect(src.includes('archon-m42-staging:prior')).toBe(true);
    expect(src.includes('prior-meta.json')).toBe(true);
    expect(src.includes('Save-PriorM42Staging') || src.includes('retained prior')).toBe(true);
    expect(src.includes('failed to stop prior M-42 staging before retention')).toBe(true);
    expect(src.includes('prior image exists but DEPLOYED_COMMIT is missing or invalid')).toBe(true);
    expect(src.includes('Get-DockerImageIdIfPresent')).toBe(true);
    expect(src.includes('$ErrorActionPreference = "Continue"')).toBe(true);
    expect(src.includes('$ErrorActionPreference = $previousErrorActionPreference')).toBe(true);
  });

  test('Windows PowerShell 5.1 tolerates expected Docker progress stderr but checks exits', () => {
    const launcher = readFileSync(launcherPath, 'utf8');
    const integration = readFileSync(integrationPath, 'utf8');
    for (const src of [launcher, integration]) {
      expect(src.includes('Invoke-DockerAllowingProgressStderr')).toBe(true);
      expect(src.includes('$ErrorActionPreference = "Continue"')).toBe(true);
      expect(src.includes('$LASTEXITCODE')).toBe(true);
    }
    expect(launcher.includes('Invoke-DockerAllowingProgressStderr -Arguments @("build"')).toBe(
      true
    );
    expect(integration.includes('Invoke-DockerAllowingProgressStderr -Arguments @("compose"')).toBe(
      true
    );
  });

  test('standalone compose has no env_file, credential keys ABSENT, only two M-42 mounts', () => {
    expect(existsSync(composePath)).toBe(true);
    const src = readFileSync(composePath, 'utf8');

    expect(src.toLowerCase().includes('env_file')).toBe(false);
    expect(src.includes('archon-m42-staging')).toBe(true);
    expect(src.includes('127.0.0.1:3092:3092')).toBe(true);

    const volumeLines = src
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.startsWith('- ./'));
    expect(volumeLines).toEqual([
      '- ./staging-m42-data:/.archon',
      '- ./staging-m42-user-home:/home/appuser',
    ]);

    // printenv KEY fails only when key is absent -- empty string is still present.
    for (const key of CREDENTIAL_KEYS) {
      expect(src.includes(`${key}:`)).toBe(false);
      expect(src.includes(`\${${key}`)).toBe(false);
      expect(src.includes(`${key}=`)).toBe(false);
    }

    expect(src.includes('OVERSEER_EMERGENCY_STOP: "true"')).toBe(true);
    expect(src.includes('OVERSEER_USE_FAKE_GITHUB_ADAPTER: "1"')).toBe(true);
    for (const cap of ['ESCALATION', 'REPAIR', 'BRANCH', 'LIFECYCLE', 'MERGE']) {
      expect(src.includes(`OVERSEER_${cap}_ACTIONS_ENABLED: "false"`)).toBe(true);
    }
  });
});

describe('staging-overseer-integration contract', () => {
  test('official proof host is the Docker-capable laptop', () => {
    const src = readFileSync(integrationPath, 'utf8');
    expect(src.includes("$OfficialProofHost = 'LAPTOP-BQ6IEJNC'")).toBe(true);
    expect(src.includes('ASUS-ROG-DSK-2T')).toBe(false);
  });

  test('probes credential env keys and files; never hardcodes empty present arrays as sole check', () => {
    const src = readFileSync(integrationPath, 'utf8');
    expect(src.includes('printenv')).toBe(true);
    expect(src.includes('Get-CredentialEnvPresent') || src.includes('credential_env_present')).toBe(
      true
    );
    expect(src.includes('test -e')).toBe(true);
    expect(src.includes('credential_probe_failed')).toBe(true);
    expect(src.includes('/home/claude/.grok/auth.json')).toBe(true);
    expect(src.includes('/home/appuser/.grok/auth.json')).toBe(true);
    // Must not only assign empty arrays without probing
    expect(src.includes('credential_env_present   = @()') && !src.includes('printenv')).toBe(false);
    // PowerShell 5.1 treats `return ,$emptyStringArray` as one array object,
    // which makes the fail-closed caller report a false credential finding.
    expect(src.includes('return ,$present.ToArray()')).toBe(false);
  });

  test('rejects fabricated m42-image digest fallback; requires real sha256:64', () => {
    const src = readFileSync(integrationPath, 'utf8');
    expect(src.includes('m42-image:')).toBe(false);
    expect(src.includes('SHA256]::Create')).toBe(false);
    expect(src.includes('ComputeHash')).toBe(false);
    expect(src.includes('Get-RealImageDigest')).toBe(true);
    expect(src.includes('image_digest_unavailable')).toBe(true);
    expect(src.includes('sha256:[0-9a-f]{64}') || src.includes('sha256:')).toBe(true);
  });

  test('runs committed in-container integration runner; no host working-tree theater', () => {
    const src = readFileSync(integrationPath, 'utf8');
    const runnerPath = join(repoRoot, 'packages', 'overseer', 'src', 'm42-integration-runner.ts');
    expect(existsSync(runnerPath)).toBe(true);
    expect(src.includes('m42-integration-runner.ts')).toBe(true);
    expect(src.includes('Invoke-M42IntegrationRunnerInContainer')).toBe(true);
    expect(src.includes('docker exec') || src.includes('$Docker exec')).toBe(true);
    // Host working-tree bun -e must not count as candidate proof
    expect(src.includes('getRealCallCount: () => 0')).toBe(false);
    expect(src.includes('getRealCallCount:()=>0')).toBe(false);
    expect(src.includes('Invoke-BunFromRepoRoot')).toBe(false);
    // Forbidden pattern: write temp modules under OS temp with relative packages imports
    expect(src.includes('Join-Path $env:TEMP')).toBe(false);
    expect(src.includes('m42-scenario-run')).toBe(false);
    expect(src.includes('m42-packets-')).toBe(false);
    expect(src.includes('Set-Content -Path $scenarioFile')).toBe(false);
    expect(src.includes('Set-Content -Path $packetFile')).toBe(false);
    // No fabricated zero prior SHA / zero verifier digest for packets
    expect(src.includes('"0" * 40') || src.includes("'0' * 40")).toBe(false);
    expect(src.includes('0".repeat(64)') || src.includes("0'.repeat(64)")).toBe(false);
    const runner = readFileSync(runnerPath, 'utf8');
    expect(runner.includes('operatorCardCount')).toBe(true);
    expect(runner.includes('operator_card_count: operatorCardCount')).toBe(true);
  });

  test('derives watcher/adapter/emergency/capabilities/circuits from /api/health', () => {
    const src = readFileSync(integrationPath, 'utf8');
    expect(src.includes('/api/health')).toBe(true);
    expect(src.includes('Get-LiveOverseerHealth') || src.includes('overseer')).toBe(true);
    expect(src.includes('health_gate_failed')).toBe(true);
    expect(src.includes('watcher_count')).toBe(true);
    expect(src.includes('adapter_mode')).toBe(true);
    expect(src.includes('capability_flags') || src.includes('all_caps_false')).toBe(true);
    expect(src.includes('capability flag missing')).toBe(true);
    expect(src.includes('circuit state missing')).toBe(true);
    expect(src.includes('deployed_ref_mismatch')).toBe(true);
  });

  test('rollback restores retained prior and fails without prior evidence', () => {
    const src = readFileSync(integrationPath, 'utf8');
    expect(src.includes('retained_prior_missing')).toBe(true);
    expect(src.includes('staging-m42-prior')).toBe(true);
    expect(src.includes('archon-m42-staging:prior')).toBe(true);
    expect(src.includes('rollback_status')).toBe(true);
    expect(src.includes('restored')).toBe(true);
    expect(src.includes('prior_health_ok') || src.includes('rollback_health_failed')).toBe(true);
    expect(src.includes('rollback_image_mismatch')).toBe(true);
    expect(src.includes('$candidateRunning = $containerRunning -and ($activeSha -eq $sha)')).toBe(
      true
    );
    expect(src.includes('candidate_running   = [bool]$candidateRunning')).toBe(true);
    // Must start prior, not only stop candidate
    expect(src.includes('compose up') || src.includes('compose -f $Compose up')).toBe(true);
  });

  test('writes only proof fields under an explicit approved external root', () => {
    const src = readFileSync(integrationPath, 'utf8');
    expect(src.includes('output_path_rejected')).toBe(true);
    expect(src.includes('[string]$ManifestPath')).toBe(true);
    expect(src.includes('[string]$ApprovedExternalArtifactRoot')).toBe(true);
    expect(src.includes('approved root must be outside repository')).toBe(true);
    expect(src.includes('Assert-NoReparseAncestor')).toBe(true);
    expect(src.includes('symlink/reparse ancestor not allowed')).toBe(true);
    expect(src.includes('traversal is not allowed')).toBe(true);
    expect(src.includes('artifacts\\overseer\\m42-wave2')).toBe(false);
    expect(src.includes('circuits                 = $proofCircuits')).toBe(false);
    expect(src.includes('deployed_marker_sha')).toBe(false);
    expect(src.includes('prior_container_up')).toBe(false);
    expect(src.includes('prior_health_ok     =')).toBe(false);
    expect(src.includes('prior_image_digest  =')).toBe(false);
  });

  test('packets gated on satisfied child evidence; not written when BLOCKED', () => {
    const src = readFileSync(integrationPath, 'utf8');
    expect(
      src.includes('Test-ChildEvidenceSatisfiedForPackets') || src.includes('skip packet')
    ).toBe(true);
    expect(src.includes('READY_FOR_SANDBOX_PROOF_REQUEST')).toBe(true);
  });
});

describe('pre-PR parent manifest fail-closed static artifacts', () => {
  test('checked-in parent manifest is BLOCKED with blockers and no readiness packet files', () => {
    expect(existsSync(parentManifestPath)).toBe(true);
    const man = JSON.parse(readFileSync(parentManifestPath, 'utf8')) as {
      status: string;
      blockers?: string[];
      readiness_packet?: unknown;
      children: unknown[];
    };
    expect(man.status).toBe('BLOCKED');
    expect(Array.isArray(man.blockers)).toBe(true);
    expect((man.blockers ?? []).length).toBeGreaterThan(0);
    expect(man.readiness_packet ?? null).toBeNull();
    expect(man.children.length).toBe(9);
    // No premature unsigned packets checked in
    expect(existsSync(packetSandbox)).toBe(false);
    expect(existsSync(packetDeploy)).toBe(false);
  });
});
