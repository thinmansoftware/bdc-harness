import {
  buildUnsignedActivationRequest,
  buildUnsignedSandboxProofRequest,
  type ActivationArtifactBundle,
  type ActivationPackageInput,
} from './activation-package';
import {
  validateIndependentReviewEvidence,
  type IndependentReviewArtifact,
  type IndependentReviewValidationResult,
} from './independent-review-evidence';
import { REQUIRED_M42_CHILD_WO_IDS } from './integration-manifest';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const SHA1_RE = /^[0-9a-f]{40}$/;
const IMAGE_RE = /^sha256:[0-9a-f]{64}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export interface ExternalSeedChild {
  readonly wo_id: string;
  readonly base_sha: string;
  readonly pr_head: string;
  readonly reviewed_head: string;
  readonly merge_sha: string;
  readonly pr_number: number;
  readonly [key: string]: unknown;
}

export interface ExternalSeedManifest {
  readonly schema_version: string;
  readonly wo_id: string;
  readonly builder: { readonly provider: string; readonly model: string };
  readonly prior_staging_sha: string;
  readonly children: readonly ExternalSeedChild[];
  readonly migrations: Readonly<Record<string, readonly string[]>>;
  readonly verifier_registry_digest?: string;
  readonly [key: string]: unknown;
}

export interface CompleteStagingProof {
  readonly schema_version: 'm42-staging-proof-v1';
  readonly candidate_sha: string;
  readonly image_digest: string;
  readonly container_name: string;
  readonly host: string;
  readonly watcher_count: number;
  readonly adapter_mode: 'fake';
  readonly emergency_stop: boolean;
  readonly disabled_capabilities: readonly string[];
  readonly receipt_count: number;
  readonly operator_card_count: number;
  readonly real_call_count: number;
  readonly credential_env_present: readonly string[];
  readonly credential_files_present: readonly string[];
}

export interface CompleteRollbackProof {
  readonly schema_version: 'm42-rollback-proof-v1';
  readonly candidate_sha: string;
  readonly prior_staging_sha: string;
  readonly rollback_status: 'restored';
  readonly active_sha: string;
  readonly candidate_running: boolean;
  readonly evidence_retained: boolean;
}

export interface FinalizeExternalEvidenceInput {
  readonly seed: ExternalSeedManifest;
  readonly current_head: string;
  readonly live_pr_head: string;
  readonly pr_number: number;
  readonly staging_proof: CompleteStagingProof;
  readonly rollback_proof: CompleteRollbackProof;
  readonly review_artifact: IndependentReviewArtifact;
  readonly raw_review_transcript: string;
}

export interface FinalizeExternalEvidenceResult {
  readonly manifest: Record<string, unknown>;
  readonly activation_bundle: ActivationArtifactBundle;
  readonly review_validation: IndependentReviewValidationResult;
}

function reject(reason: string): never {
  throw new Error(`m42_external_finalization_rejected:${reason}`);
}

function isWithinOrEqual(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function resolveThroughExistingAncestor(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) reject('artifact_root_no_existing_ancestor');
    suffix.unshift(ancestor.slice(parent.length).replace(/^[/\\]+/, ''));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

export function resolveExternalArtifactRoot(path: string, repoRoot: string): string {
  if (!isAbsolute(path)) reject('artifact_root_not_absolute');
  if (path.split(/[\\/]+/).includes('..')) reject('artifact_root_traversal');
  const repo = realpathSync(repoRoot);
  const predicted = resolveThroughExistingAncestor(path);
  if (isWithinOrEqual(predicted, repo) || isWithinOrEqual(repo, predicted)) {
    reject('artifact_root_repository_overlap');
  }
  mkdirSync(path, { recursive: true });
  const actual = realpathSync(path);
  if (actual !== predicted) reject('artifact_root_changed_during_creation');
  return actual;
}

export function resolveExternalArtifactInput(path: string, root: string, label: string): string {
  if (!isAbsolute(path)) reject(`${label}_not_absolute`);
  if (path.split(/[\\/]+/).includes('..')) reject(`${label}_traversal`);
  const actual = realpathSync(path);
  if (!isWithinOrEqual(actual, root)) reject(`${label}_outside_artifact_root`);
  return actual;
}

export function prepareExternalManifest(
  seed: ExternalSeedManifest,
  currentHead: string,
  livePrHead: string,
  prNumber: number,
  verifierRegistryDigest: string
): Record<string, unknown> {
  if (seed.schema_version !== 'm42-parent-manifest-v1') reject('seed_schema_invalid');
  if (seed.wo_id !== 'WO-HARNESS-OVERSEER-INTEGRATION-ACTIVATION-01') {
    reject('seed_wo_invalid');
  }
  if (!seed.builder?.provider || !seed.builder.model) reject('seed_builder_invalid');
  if (!SHA1_RE.test(seed.prior_staging_sha)) reject('prior_staging_sha_invalid');
  if (!SHA1_RE.test(currentHead) || currentHead !== livePrHead) reject('pr_head_mismatch');
  if (!Number.isInteger(prNumber) || prNumber <= 0) reject('pr_number_invalid');
  if (!DIGEST_RE.test(verifierRegistryDigest) || /^0{64}$/.test(verifierRegistryDigest)) {
    reject('verifier_registry_digest_invalid');
  }
  return {
    ...seed,
    pr_number: prNumber,
    head_sha: currentHead,
    verifier_registry_digest: verifierRegistryDigest,
    status: 'BLOCKED',
    ready: false,
    readiness_packet: null,
  };
}

export function finalizeExternalEvidence(
  input: FinalizeExternalEvidenceInput
): FinalizeExternalEvidenceResult {
  const { seed, staging_proof: staging, rollback_proof: rollback } = input;
  if (!SHA1_RE.test(input.current_head) || input.current_head !== input.live_pr_head) {
    reject('pr_head_mismatch');
  }
  if (!Number.isInteger(input.pr_number) || input.pr_number <= 0) reject('pr_number_invalid');
  if (!SHA1_RE.test(seed.prior_staging_sha)) reject('prior_staging_sha_invalid');

  const childIds = seed.children.map(child => child.wo_id);
  const childHeads = Object.fromEntries(seed.children.map(child => [child.wo_id, child.pr_head]));
  if (
    seed.children.length !== REQUIRED_M42_CHILD_WO_IDS.length ||
    new Set(childIds).size !== seed.children.length ||
    REQUIRED_M42_CHILD_WO_IDS.some(woId => !childHeads[woId])
  ) {
    reject('child_coverage_incomplete');
  }
  if (
    !seed.verifier_registry_digest ||
    !DIGEST_RE.test(seed.verifier_registry_digest) ||
    /^0{64}$/.test(seed.verifier_registry_digest)
  ) {
    reject('verifier_registry_digest_invalid');
  }

  const review = validateIndependentReviewEvidence(
    input.review_artifact,
    input.raw_review_transcript,
    {
      candidate_sha: input.current_head,
      child_heads: childHeads,
      builder: seed.builder,
    }
  );
  if (!review.ok) reject(`independent_review_invalid:${review.errors.join('|')}`);

  const disabled = [...staging.disabled_capabilities].sort();
  if (
    staging.schema_version !== 'm42-staging-proof-v1' ||
    staging.candidate_sha !== input.current_head ||
    !IMAGE_RE.test(staging.image_digest) ||
    staging.container_name !== 'archon-m42-staging' ||
    staging.host !== 'LAPTOP-BQ6IEJNC' ||
    staging.watcher_count !== 1 ||
    staging.adapter_mode !== 'fake' ||
    !staging.emergency_stop ||
    disabled.join(',') !== 'branch,escalation,lifecycle,merge,repair' ||
    !Number.isInteger(staging.receipt_count) ||
    staging.receipt_count < 1 ||
    !Number.isInteger(staging.operator_card_count) ||
    staging.operator_card_count < 0 ||
    staging.real_call_count !== 0 ||
    staging.credential_env_present.length !== 0 ||
    staging.credential_files_present.length !== 0
  ) {
    reject('staging_proof_invalid');
  }
  if (
    rollback.schema_version !== 'm42-rollback-proof-v1' ||
    rollback.candidate_sha !== input.current_head ||
    rollback.prior_staging_sha !== seed.prior_staging_sha ||
    rollback.rollback_status !== 'restored' ||
    rollback.active_sha !== seed.prior_staging_sha ||
    rollback.candidate_running ||
    !rollback.evidence_retained
  ) {
    reject('rollback_proof_invalid');
  }

  const activationInput: ActivationPackageInput = {
    candidate_sha: input.current_head,
    image_digest: staging.image_digest,
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
      adapters: ['fake-github'],
    },
    rollback: {
      prior_staging_sha: seed.prior_staging_sha,
      evidence_retained: rollback.evidence_retained,
    },
    health: { watcher_count: staging.watcher_count, adapter_mode: staging.adapter_mode },
    numerical_caps: { max_factory_commitments: 10, max_fusion_usd: 0 },
    verifier_registry_digest: seed.verifier_registry_digest,
    missing_gate2_approvals: ['sandbox_spend_motion', 'fusion_calibration'],
    missing_gate3_approvals: ['board_production_deploy_motion'],
    operator_notice: 'Build-only candidate; no live operator authority.',
    parent_manifest_status: 'READY_FOR_SANDBOX_PROOF_REQUEST',
    staging_proof: staging,
    rollback_proof: rollback,
  };
  const activationBundle: ActivationArtifactBundle = {
    sandbox_proof_request: buildUnsignedSandboxProofRequest(activationInput),
    deploy_activation_request: buildUnsignedActivationRequest(activationInput),
  };

  const reviewedChildren = seed.children.map(child => ({
    ...child,
    review_state: 'satisfied',
    reviewer_provider: input.review_artifact.reviewer.provider,
    reviewer_model: input.review_artifact.reviewer.model,
  }));
  const manifest: Record<string, unknown> = {
    ...seed,
    pr_number: input.pr_number,
    head_sha: input.current_head,
    image_digest: staging.image_digest,
    status: 'READY_FOR_SANDBOX_PROOF_REQUEST',
    ready: true,
    blockers: [],
    children: reviewedChildren,
    readiness_packet: {
      candidate_sha: input.current_head,
      image_digest: staging.image_digest,
      children: reviewedChildren,
      status: 'READY_FOR_SANDBOX_PROOF_REQUEST',
    },
    scenario_receipts: {
      receipt_count: staging.receipt_count,
      operator_card_count: staging.operator_card_count,
      real_call_count: staging.real_call_count,
      adapter_mode: staging.adapter_mode,
    },
    rollback,
    verifier_registry_digest: seed.verifier_registry_digest,
    independent_review: {
      state: 'satisfied',
      artifact_sha256: review.artifact_sha256,
      raw_transcript_sha256: review.raw_transcript_sha256,
      reviewed_at: input.review_artifact.reviewed_at,
      reviewer: input.review_artifact.reviewer,
    },
    completion_statement:
      'Slice 8 build complete; no provider canary, paid Fusion, production deploy, live operator authority, or capability activation occurred.',
    proceed_deploy: 'N/A',
  };

  return { manifest, activation_bundle: activationBundle, review_validation: review };
}
