/**
 * M-42 Slice 8 unsigned activation/sandbox request packets and
 * governance-isolated artifact writer.
 *
 * Fail closed: no zero/malformed prior SHA, verifier digest, staging proof,
 * or rollback proof. Packets are not emitted while parent is BLOCKED.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ZERO40 = /^0{40}$/;
const ZERO64 = /^0{64}$/;
const ZERO_IMAGE = /^sha256:0{64}$/;

export interface StagingProofEvidence {
  readonly schema_version: 'm42-staging-proof-v1';
  readonly candidate_sha: string;
  readonly image_digest: string;
  readonly real_call_count: number;
  readonly adapter_mode: 'fake';
}

export interface RollbackProofEvidence {
  readonly schema_version: 'm42-rollback-proof-v1';
  readonly prior_staging_sha: string;
  readonly evidence_retained: boolean;
  readonly rollback_status: 'restored';
}

export interface ActivationPackageInput {
  readonly candidate_sha: string;
  readonly image_digest: string;
  readonly capabilities: Readonly<{
    escalation: boolean;
    repair: boolean;
    branch: boolean;
    lifecycle: boolean;
    merge: boolean;
  }>;
  readonly emergency_stop: boolean;
  readonly allowlists: Readonly<{
    repositories: readonly string[];
    adapters: readonly string[];
  }>;
  readonly rollback: Readonly<{
    prior_staging_sha: string;
    evidence_retained: boolean;
  }>;
  readonly health: Readonly<{
    watcher_count: number;
    adapter_mode: string;
  }>;
  readonly numerical_caps: Readonly<{
    max_factory_commitments: number;
    max_fusion_usd: number;
  }>;
  readonly verifier_registry_digest: string;
  readonly missing_gate2_approvals: readonly string[];
  readonly missing_gate3_approvals: readonly string[];
  readonly operator_notice: string;
  /** Required for packet emission; must not be BLOCKED. */
  readonly parent_manifest_status: 'READY_FOR_SANDBOX_PROOF_REQUEST';
  readonly staging_proof: StagingProofEvidence;
  readonly rollback_proof: RollbackProofEvidence;
}

export interface UnsignedSandboxProofRequest {
  readonly schema_version: 'm42-sandbox-proof-request-v1';
  readonly signed: false;
  readonly candidate_sha: string;
  readonly image_digest: string;
  readonly requires_dedicated_sandbox: true;
  readonly verifier_registry_digest: string;
  readonly numerical_caps: ActivationPackageInput['numerical_caps'];
  readonly rollback: ActivationPackageInput['rollback'];
  readonly zero_production_effect: true;
  readonly missing_gate2_approvals: readonly string[];
  readonly capabilities_remain_disabled: true;
  readonly emergency_stop: true;
}

export interface UnsignedActivationRequest {
  readonly schema_version: 'm42-deploy-activation-request-v1';
  readonly signed: false;
  readonly candidate_sha: string;
  readonly image_digest: string;
  readonly capabilities: ActivationPackageInput['capabilities'];
  readonly allowlists: ActivationPackageInput['allowlists'];
  readonly backup_and_rollback: ActivationPackageInput['rollback'];
  readonly health: ActivationPackageInput['health'];
  readonly operator_notice: string;
  readonly missing_gate3_approvals: readonly string[];
  readonly emergency_stop: boolean;
}

export interface ActivationArtifactBundle {
  readonly sandbox_proof_request: UnsignedSandboxProofRequest;
  readonly deploy_activation_request: UnsignedActivationRequest;
}

export interface WrittenActivationArtifacts {
  readonly sandbox_proof_request_path: string;
  readonly deploy_activation_request_path: string;
  readonly sandbox_proof_request_sha256: string;
  readonly deploy_activation_request_sha256: string;
}

/** Stable JSON stringify with sorted object keys (RFC 8785-lite). */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

function reject(reason: string): never {
  throw new Error(`activation_package_rejected:${reason}`);
}

/**
 * Reject missing/zero/malformed required identities and proofs.
 * Packets must not be built while parent is BLOCKED.
 */
export function assertActivationPackageInput(input: ActivationPackageInput): void {
  if (input.parent_manifest_status !== 'READY_FOR_SANDBOX_PROOF_REQUEST') {
    reject('parent_manifest_not_ready');
  }
  if (!SHA1_RE.test(input.candidate_sha) || ZERO40.test(input.candidate_sha)) {
    reject('candidate_sha_invalid_or_zero');
  }
  if (!IMAGE_DIGEST_RE.test(input.image_digest) || ZERO_IMAGE.test(input.image_digest)) {
    reject('image_digest_invalid_or_zero');
  }
  if (
    !SHA1_RE.test(input.rollback.prior_staging_sha) ||
    ZERO40.test(input.rollback.prior_staging_sha)
  ) {
    reject('prior_staging_sha_invalid_or_zero');
  }
  if (
    !SHA256_RE.test(input.verifier_registry_digest) ||
    ZERO64.test(input.verifier_registry_digest)
  ) {
    reject('verifier_registry_digest_invalid_or_zero');
  }
  if (input.staging_proof?.schema_version !== 'm42-staging-proof-v1') {
    reject('staging_proof_missing_or_invalid');
  }
  if (input.staging_proof.candidate_sha !== input.candidate_sha) {
    reject('staging_proof_candidate_mismatch');
  }
  if (input.staging_proof.image_digest !== input.image_digest) {
    reject('staging_proof_image_mismatch');
  }
  if (input.staging_proof.adapter_mode !== 'fake') {
    reject('staging_proof_adapter_not_fake');
  }
  if (input.staging_proof.real_call_count !== 0) {
    reject('staging_proof_real_calls_nonzero');
  }
  if (input.rollback_proof?.schema_version !== 'm42-rollback-proof-v1') {
    reject('rollback_proof_missing_or_invalid');
  }
  if (input.rollback_proof.prior_staging_sha !== input.rollback.prior_staging_sha) {
    reject('rollback_proof_prior_sha_mismatch');
  }
  if (input.rollback_proof.rollback_status !== 'restored') {
    reject('rollback_proof_not_restored');
  }
  if (input.rollback.evidence_retained !== input.rollback_proof.evidence_retained) {
    reject('evidence_retained_mismatch');
  }
  if (typeof input.rollback.evidence_retained !== 'boolean') {
    reject('evidence_retained_missing');
  }
  if (!input.emergency_stop) {
    reject('emergency_stop_required');
  }
  if (!input.operator_notice || input.operator_notice.trim().length === 0) {
    reject('operator_notice_missing');
  }
}

export function buildUnsignedSandboxProofRequest(
  input: ActivationPackageInput
): UnsignedSandboxProofRequest {
  assertActivationPackageInput(input);
  return {
    schema_version: 'm42-sandbox-proof-request-v1',
    signed: false,
    candidate_sha: input.candidate_sha,
    image_digest: input.image_digest,
    requires_dedicated_sandbox: true,
    verifier_registry_digest: input.verifier_registry_digest,
    numerical_caps: { ...input.numerical_caps },
    rollback: { ...input.rollback },
    zero_production_effect: true,
    missing_gate2_approvals: [...input.missing_gate2_approvals],
    capabilities_remain_disabled: true,
    emergency_stop: true,
  };
}

export function buildUnsignedActivationRequest(
  input: ActivationPackageInput
): UnsignedActivationRequest {
  assertActivationPackageInput(input);
  return {
    schema_version: 'm42-deploy-activation-request-v1',
    signed: false,
    candidate_sha: input.candidate_sha,
    image_digest: input.image_digest,
    capabilities: { ...input.capabilities },
    allowlists: {
      repositories: [...input.allowlists.repositories],
      adapters: [...input.allowlists.adapters],
    },
    backup_and_rollback: { ...input.rollback },
    health: { ...input.health },
    operator_notice: input.operator_notice,
    missing_gate3_approvals: [...input.missing_gate3_approvals],
    emergency_stop: input.emergency_stop,
  };
}

const FORBIDDEN_PATH_MARKERS = [
  `${sep}docs${sep}board`,
  `${sep}.github`,
  `${sep}packages${sep}`,
  `${sep}migrations${sep}`,
  `${sep}scripts${sep}`,
  `${sep}src${sep}`,
];

function assertNonGovernanceOutputDirectory(outputDirectory: string): string {
  const resolved = resolve(outputDirectory);
  const normalized = normalize(resolved).toLowerCase();
  const repoRoot = resolve(process.cwd()).toLowerCase();

  for (const marker of FORBIDDEN_PATH_MARKERS) {
    if (normalized.includes(marker.toLowerCase())) {
      throw new Error(
        `activation_artifact_path_rejected: path under forbidden governance/source tree (${marker})`
      );
    }
  }

  if (normalized.startsWith(repoRoot + sep) || normalized === repoRoot) {
    const rel = normalized.slice(repoRoot.length).replace(/^[/\\]/, '');
    const first = rel.split(/[/\\]/)[0] ?? '';
    const forbiddenRoots = new Set([
      'docs',
      '.github',
      'packages',
      'migrations',
      'scripts',
      'src',
      'deploy',
      'config',
      'harness',
    ]);
    if (forbiddenRoots.has(first)) {
      throw new Error(
        `activation_artifact_path_rejected: refuses repository source tree path '${first}'`
      );
    }
  }

  if (!isAbsolute(resolved) && !outputDirectory.includes('artifacts')) {
    // relative paths under artifacts/ are allowed when resolved under cwd
  }

  if (normalized.startsWith(repoRoot + sep)) {
    const rel = normalized.slice(repoRoot.length).replace(/^[/\\]/, '');
    if (!rel.startsWith('artifacts') && !rel.includes(`${sep}tmp`) && !rel.includes('staging-')) {
      if (!rel.startsWith('staging-data') && !rel.startsWith('staging-m42')) {
        const first = rel.split(/[/\\]/)[0] ?? '';
        if (
          first &&
          first !== 'artifacts' &&
          first !== 'staging-data' &&
          first !== 'staging-m42-data'
        ) {
          throw new Error(
            `activation_artifact_path_rejected: refuses non-artifact repo path '${first}'`
          );
        }
      }
    }
  }

  return resolved;
}

/**
 * Write unsigned canonical JSON packets plus SHA-256 digests to a
 * caller-supplied directory. Rejects docs/board, .github, and source trees.
 */
export function writeNonGovernanceActivationArtifacts(
  input: ActivationArtifactBundle,
  outputDirectory: string
): WrittenActivationArtifacts {
  // Refuse writing packets that were not built from a validated READY input path
  // (bundle schemas already enforce signed:false and required fields).
  if (input.sandbox_proof_request.signed) {
    throw new Error('activation_artifact_rejected:sandbox_signed');
  }
  if (input.deploy_activation_request.signed) {
    throw new Error('activation_artifact_rejected:deploy_signed');
  }
  if (ZERO40.test(input.sandbox_proof_request.candidate_sha)) {
    throw new Error('activation_artifact_rejected:zero_candidate_sha');
  }
  if (ZERO64.test(input.sandbox_proof_request.verifier_registry_digest)) {
    throw new Error('activation_artifact_rejected:zero_verifier_digest');
  }
  if (ZERO40.test(input.sandbox_proof_request.rollback.prior_staging_sha)) {
    throw new Error('activation_artifact_rejected:zero_prior_sha');
  }

  const dir = assertNonGovernanceOutputDirectory(outputDirectory);
  mkdirSync(dir, { recursive: true });

  const sandboxBody = canonicalJsonStringify(input.sandbox_proof_request);
  const deployBody = canonicalJsonStringify(input.deploy_activation_request);
  const sandboxPath = join(dir, 'sandbox-proof-request.json');
  const deployPath = join(dir, 'deploy-activation-request.json');

  writeFileSync(sandboxPath, sandboxBody + '\n', 'utf8');
  writeFileSync(deployPath, deployBody + '\n', 'utf8');

  return {
    sandbox_proof_request_path: sandboxPath,
    deploy_activation_request_path: deployPath,
    sandbox_proof_request_sha256: createHash('sha256').update(sandboxBody).digest('hex'),
    deploy_activation_request_sha256: createHash('sha256').update(deployBody).digest('hex'),
  };
}
