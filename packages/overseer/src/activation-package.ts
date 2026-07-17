/**
 * M-42 Slice 8 unsigned activation/sandbox request packets and
 * governance-isolated artifact writer.
 *
 * Fail closed: no zero/malformed prior SHA, verifier digest, staging proof,
 * or rollback proof. Packets are not emitted while parent is BLOCKED.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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

function isWithinOrEqual(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertApprovedExternalOutputDirectory(
  outputDirectory: string,
  approvedExternalArtifactRoot: string
): string {
  if (!approvedExternalArtifactRoot?.trim()) {
    throw new Error('activation_artifact_path_rejected: approved_external_artifact_root_required');
  }
  if (!isAbsolute(approvedExternalArtifactRoot) || !isAbsolute(outputDirectory)) {
    throw new Error(
      'activation_artifact_path_rejected: approved_external_artifact_root_must_be_absolute'
    );
  }

  const requestedRoot = resolve(approvedExternalArtifactRoot);
  const requestedOutput = resolve(outputDirectory);
  const requestedRepo = resolve(process.cwd());

  if (
    isWithinOrEqual(requestedRoot, requestedRepo) ||
    isWithinOrEqual(requestedRepo, requestedRoot)
  ) {
    throw new Error(
      'activation_artifact_path_rejected: approved_external_artifact_root_is_repository'
    );
  }
  if (!isWithinOrEqual(requestedOutput, requestedRoot)) {
    throw new Error('activation_artifact_path_rejected: outside_approved_external_artifact_root');
  }

  mkdirSync(requestedRoot, { recursive: true });
  mkdirSync(requestedOutput, { recursive: true });

  const actualRoot = realpathSync(requestedRoot);
  const actualOutput = realpathSync(requestedOutput);
  const actualRepo = realpathSync(requestedRepo);
  if (isWithinOrEqual(actualRoot, actualRepo) || isWithinOrEqual(actualRepo, actualRoot)) {
    throw new Error(
      'activation_artifact_path_rejected: approved_external_artifact_root_is_repository'
    );
  }
  if (!isWithinOrEqual(actualOutput, actualRoot)) {
    throw new Error('activation_artifact_path_rejected: outside_approved_external_artifact_root');
  }

  return actualOutput;
}

/**
 * Write unsigned canonical JSON packets plus SHA-256 digests to a
 * caller-supplied directory under an explicit approved external artifact root.
 * Both paths must be absolute, and the approved root must be outside the repo.
 */
export function writeNonGovernanceActivationArtifacts(
  input: ActivationArtifactBundle,
  outputDirectory: string,
  approvedExternalArtifactRoot: string
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

  const dir = assertApprovedExternalOutputDirectory(outputDirectory, approvedExternalArtifactRoot);

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
