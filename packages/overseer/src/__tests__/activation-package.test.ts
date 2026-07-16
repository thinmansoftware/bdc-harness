import { describe, expect, test, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertActivationPackageInput,
  buildUnsignedActivationRequest,
  buildUnsignedSandboxProofRequest,
  writeNonGovernanceActivationArtifacts,
  type ActivationPackageInput,
} from '../activation-package';

const NONZERO64 = 'a1'.repeat(32);
const HEX40 = 'd'.repeat(40);
const PRIOR40 = 'e'.repeat(40);
const IMAGE = `sha256:${'b2'.repeat(32)}`;

function baseInput(overrides: Partial<ActivationPackageInput> = {}): ActivationPackageInput {
  return {
    candidate_sha: HEX40,
    image_digest: IMAGE,
    capabilities: {
      escalation: false,
      repair: false,
      branch: false,
      lifecycle: false,
      merge: false,
    },
    emergency_stop: true,
    allowlists: {
      repositories: ['bluedevilcollectibles/bdc-harness'],
      adapters: ['fake'],
    },
    rollback: {
      prior_staging_sha: PRIOR40,
      evidence_retained: true,
    },
    health: {
      watcher_count: 1,
      adapter_mode: 'fake',
    },
    numerical_caps: {
      max_factory_commitments: 10,
      max_fusion_usd: 0,
    },
    verifier_registry_digest: NONZERO64,
    missing_gate2_approvals: ['sandbox_spend_motion', 'fusion_calibration'],
    missing_gate3_approvals: ['deploy_activation_motion'],
    operator_notice: 'Build-only candidate; no live operator authority.',
    parent_manifest_status: 'READY_FOR_SANDBOX_PROOF_REQUEST',
    staging_proof: {
      schema_version: 'm42-staging-proof-v1',
      candidate_sha: HEX40,
      image_digest: IMAGE,
      real_call_count: 0,
      adapter_mode: 'fake',
    },
    rollback_proof: {
      schema_version: 'm42-rollback-proof-v1',
      prior_staging_sha: PRIOR40,
      evidence_retained: true,
      rollback_status: 'restored',
    },
    ...overrides,
  };
}

function canonicalSha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('activation-package', () => {
  test('unsigned packets are complete and canonical', () => {
    const input = baseInput();
    const sandbox = buildUnsignedSandboxProofRequest(input);
    const deploy = buildUnsignedActivationRequest(input);

    expect(sandbox.signed).toBe(false);
    expect(deploy.signed).toBe(false);
    expect(sandbox.schema_version).toBe('m42-sandbox-proof-request-v1');
    expect(deploy.schema_version).toBe('m42-deploy-activation-request-v1');

    expect(sandbox.candidate_sha).toBe(HEX40);
    expect(sandbox.image_digest).toBe(IMAGE);
    expect(sandbox.requires_dedicated_sandbox).toBe(true);
    expect(sandbox.verifier_registry_digest).toBe(NONZERO64);
    expect(sandbox.numerical_caps.max_factory_commitments).toBe(10);
    expect(sandbox.rollback.prior_staging_sha).toBe(PRIOR40);
    expect(sandbox.zero_production_effect).toBe(true);
    expect(sandbox.missing_gate2_approvals.length).toBeGreaterThan(0);

    expect(deploy.candidate_sha).toBe(HEX40);
    expect(deploy.image_digest).toBe(IMAGE);
    expect(deploy.capabilities).toEqual({
      escalation: false,
      repair: false,
      branch: false,
      lifecycle: false,
      merge: false,
    });
    expect(deploy.allowlists.repositories).toContain('bluedevilcollectibles/bdc-harness');
    expect(deploy.backup_and_rollback.evidence_retained).toBe(true);
    expect(deploy.health.watcher_count).toBe(1);
    expect(deploy.operator_notice.length).toBeGreaterThan(0);
    expect(deploy.missing_gate3_approvals.length).toBeGreaterThan(0);

    expect(canonicalSha(sandbox)).toBe(canonicalSha(buildUnsignedSandboxProofRequest(input)));
    expect(canonicalSha(deploy)).toBe(canonicalSha(buildUnsignedActivationRequest(input)));
  });

  test('rejects zero prior SHA, zero verifier digest, and BLOCKED parent', () => {
    expect(() =>
      assertActivationPackageInput(
        baseInput({
          rollback: { prior_staging_sha: '0'.repeat(40), evidence_retained: true },
          rollback_proof: {
            schema_version: 'm42-rollback-proof-v1',
            prior_staging_sha: '0'.repeat(40),
            evidence_retained: true,
            rollback_status: 'restored',
          },
        })
      )
    ).toThrow(/prior_staging_sha/);

    expect(() =>
      assertActivationPackageInput(baseInput({ verifier_registry_digest: '0'.repeat(64) }))
    ).toThrow(/verifier_registry_digest/);

    expect(() =>
      buildUnsignedSandboxProofRequest(baseInput({ parent_manifest_status: 'BLOCKED' as never }))
    ).toThrow(/parent_manifest_not_ready|activation_package_rejected/);

    expect(() =>
      buildUnsignedSandboxProofRequest(
        baseInput({
          staging_proof: undefined as never,
        })
      )
    ).toThrow(/staging_proof/);
  });

  test('governance path packet writes are rejected', () => {
    const input = baseInput();
    const sandbox = buildUnsignedSandboxProofRequest(input);
    const deploy = buildUnsignedActivationRequest(input);

    expect(() =>
      writeNonGovernanceActivationArtifacts(
        { sandbox_proof_request: sandbox, deploy_activation_request: deploy },
        join(process.cwd(), 'docs', 'board', 'packets')
      )
    ).toThrow(/governance|docs\/board|rejected/i);

    expect(() =>
      writeNonGovernanceActivationArtifacts(
        { sandbox_proof_request: sandbox, deploy_activation_request: deploy },
        join(process.cwd(), '.github', 'workflows')
      )
    ).toThrow(/governance|\.github|rejected/i);

    expect(() =>
      writeNonGovernanceActivationArtifacts(
        { sandbox_proof_request: sandbox, deploy_activation_request: deploy },
        join(process.cwd(), 'packages', 'overseer', 'src')
      )
    ).toThrow(/source|rejected/i);
  });

  test('caller-supplied external artifact directory succeeds with digests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm42-activation-'));
    temps.push(dir);
    const input = baseInput();
    const sandbox = buildUnsignedSandboxProofRequest(input);
    const deploy = buildUnsignedActivationRequest(input);

    const written = writeNonGovernanceActivationArtifacts(
      { sandbox_proof_request: sandbox, deploy_activation_request: deploy },
      dir
    );

    expect(written.sandbox_proof_request_path).toBe(join(dir, 'sandbox-proof-request.json'));
    expect(written.deploy_activation_request_path).toBe(
      join(dir, 'deploy-activation-request.json')
    );
    expect(written.sandbox_proof_request_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(written.deploy_activation_request_sha256).toMatch(/^[0-9a-f]{64}$/);

    const sandboxOnDisk = JSON.parse(readFileSync(written.sandbox_proof_request_path, 'utf8'));
    const deployOnDisk = JSON.parse(readFileSync(written.deploy_activation_request_path, 'utf8'));
    expect(sandboxOnDisk.signed).toBe(false);
    expect(deployOnDisk.signed).toBe(false);
  });
});
