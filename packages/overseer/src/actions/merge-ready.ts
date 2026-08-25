/**
 * Qualified non-production merge (M-42 Slice 7).
 *
 * The merge-ready action never reaches a merge adapter unless an exact,
 * independently verified, policy-allowed tuple clears every ordered gate.
 * Assessment is a pure ordered predicate over exact evidence; execution runs
 * the M-31 v2 permit -> authorize -> identity recheck -> Grok judge -> reserve
 * chain BEFORE the injected adapter and only then appends a primary outcome.
 * The Grok second-opinion judge gate fails closed on any hold/timeout/error and
 * recuses entirely on Grok-built work (M-42, 2026-07-16). Every excluded or
 * indeterminate
 * target fails closed before any provider mutation.
 *
 * Slice 7 ships an empty live registry and leaves the merge capability disabled;
 * this module is exercised only through injected deterministic dependencies and
 * synthetic fixtures. Runtime wiring (service/watch) is owned exclusively by
 * Slice 8 and is intentionally not touched here.
 *
 * V1 isolation: this module never imports the v1 permit substrate or the
 * legacy fake mutation adapter. The merge boundary is a local
 * QualifiedMergeAdapterV2 contract injected by the caller.
 */
import { createHash } from 'node:crypto';
import { isPrGreen, isPrMergeReady } from '../judge-pr';
import { judgeWithGrok } from '../judge-second-opinion';
import type {
  GrokDispositionReceipt,
  GrokJudgeDeps,
  GrokJudgeEvidence,
  OverseerActionsDeps,
  WatchedRunRecord,
} from '../types.ts';
import {
  findMergePolicyTuple,
  type OverseerActionPolicyEntry,
  type OverseerActionPolicyRegistry,
  type OverseerDeploymentEffect,
} from '../policy-registry';
import type {
  M31ActionKind,
  M31ActionPermitV2,
  M31ExecutionReceiptEventV2,
} from '@archon/core/db/m31-target-v2';
import type { PrepareM31ActionPermitV2Result } from '../m31-target-v2';
import type { ActionPolicyV2AuthorizationResult } from '../action-policy-v2';

/** Internal repositories the Overseer may ever merge, independent of policy. */
const INTERNAL_REPO_ALLOWLIST = new Set(['bdc-harness', 'bdc-xo']);

const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * Grok/Provost family indicators. Verified against the canonical Grok operator
 * identity used throughout this package (provider 'xai', model_family 'grok';
 * see integration-fixtures.ts and merge-ready.test.ts). The Grok judge may not
 * review, verify, approve, or merge Grok-built work (M-42 board amendment
 * 2026-07-16), so a Grok-family builder recuses the judge entirely.
 */
const GROK_FAMILY_PROVIDERS = new Set(['xai']);
const GROK_FAMILY_MODEL_FAMILIES = new Set(['grok']);

/**
 * True when the independent-review builder of the work being merged is a Grok
 * family identity. Complements assessQualifiedMerge step 6's operator_recusal
 * gate (which compares operator vs. builder) -- this instead protects the Grok
 * judge from reviewing its own family's build.
 */
function isGrokFamilyBuilder(review: IndependentReviewEvidence | null): boolean {
  if (!review) return false;
  return (
    GROK_FAMILY_PROVIDERS.has(review.builder_provider.trim().toLowerCase()) ||
    GROK_FAMILY_MODEL_FAMILIES.has(review.builder_model_family.trim().toLowerCase())
  );
}

/** Deterministic disposition for a denied or excluded target. */
export type MergeExclusionDisposition = 'operator_card' | 'circuit_open' | 'deny';

export function isInternalMergeAllowed(repo: string): boolean {
  return INTERNAL_REPO_ALLOWLIST.has(repo);
}

export interface ClassifyMergeExclusionInput {
  readonly resulting_deployment_effect: OverseerDeploymentEffect;
  readonly base_branch: string;
  readonly changed_files: readonly string[];
}

export type MergeExclusionResult =
  | { readonly excluded: false }
  | {
      readonly excluded: true;
      readonly reason: string;
      readonly disposition: MergeExclusionDisposition;
    };

const RELEASE_BRANCH_RE = /^(main|master|release|prod|production|stable)(\/|-|$)/i;

/** First-match-wins path classifiers for always-excluded scopes. */
const EXCLUDED_PATH_RULES: readonly { reason: string; test: (path: string) => boolean }[] = [
  {
    reason: 'governance_doctrine',
    test: path =>
      /(^|\/)docs\/(board|governance|doctrine|motions)\//i.test(path) ||
      /(^|\/)governance\//i.test(path) ||
      /\.motion\.md$/i.test(path) ||
      /(^|\/)(CLAUDE|AGENTS)\.md$/.test(path),
  },
  {
    reason: 'migration_production',
    test: path => /(^|\/)migrations\//i.test(path) || /\.sql$/i.test(path),
  },
  {
    reason: 'secret_material',
    test: path =>
      /(^|\/)\.env(\.|$)/i.test(path) || /secret/i.test(path) || /\.(pem|key|p12|pfx)$/i.test(path),
  },
  {
    reason: 'credentials',
    test: path => /credential/i.test(path),
  },
  {
    reason: 'customer_data',
    test: path => /(^|\/)(customers?|pii)(\/|_|\.)/i.test(path),
  },
  {
    reason: 'billing',
    test: path => /(billing|invoice|payment|charge)/i.test(path),
  },
];

/**
 * Deterministically classify whether a candidate merge is excluded. Never uses
 * model discretion: production/unknown effects and always-excluded file scopes
 * fail closed. Production-linked evidence maps to an unsigned operator card; all
 * other exclusions deny (unknown effect additionally opens the merge circuit).
 */
export function classifyMergeExclusion(input: ClassifyMergeExclusionInput): MergeExclusionResult {
  if (input.resulting_deployment_effect === 'production') {
    return { excluded: true, reason: 'production_effect', disposition: 'operator_card' };
  }
  if (input.resulting_deployment_effect === 'unknown') {
    return { excluded: true, reason: 'unknown_effect', disposition: 'circuit_open' };
  }
  if (RELEASE_BRANCH_RE.test(input.base_branch)) {
    return { excluded: true, reason: 'release_branch', disposition: 'operator_card' };
  }
  for (const path of input.changed_files) {
    for (const rule of EXCLUDED_PATH_RULES) {
      if (rule.test(path)) {
        return { excluded: true, reason: `excluded_scope:${rule.reason}`, disposition: 'deny' };
      }
    }
  }
  return { excluded: false };
}

export interface RequiredCheckEvidence {
  readonly name: string;
  readonly conclusion: string;
  readonly head_sha: string;
}

export interface IndependentReviewEvidence {
  readonly present: boolean;
  readonly reviewed_head_sha: string;
  readonly reviewer_identity: string;
  readonly builder_identity: string;
  readonly reviewer_provider: string;
  readonly builder_provider: string;
  readonly reviewer_model_family: string;
  readonly builder_model_family: string;
}

export interface FusionEvidence {
  readonly present: boolean;
  readonly components: readonly string[];
  readonly raw_dissent_recorded: boolean;
  readonly cost_recorded: boolean;
  readonly verifier_correlated: boolean;
  readonly hidden_model_substitution: boolean;
  /** Lower-case 64-hex content address of the Fusion receipt. */
  readonly receipt_digest: string;
  /** Lower-case 64-hex content address of independent Fusion evidence. */
  readonly evidence_digest: string;
}

export interface QualifiedMergeEvidence {
  readonly record: WatchedRunRecord;
  readonly registry: OverseerActionPolicyRegistry;
  readonly owner: string;
  readonly repository: string;
  readonly base_branch: string;
  readonly resulting_deployment_effect: OverseerDeploymentEffect;
  readonly credential_principal: string;
  readonly action_kind: M31ActionKind;
  readonly changed_files: readonly string[];
  readonly pr_number: number;
  readonly head_sha: string;
  readonly base_sha: string;
  readonly required_checks: readonly RequiredCheckEvidence[];
  readonly reviews: readonly { readonly resolved: boolean }[];
  readonly independent_review: IndependentReviewEvidence | null;
  readonly operator: {
    readonly identity: string;
    readonly provider: string;
    readonly model_family: string;
  };
  readonly manifest: { readonly valid: boolean } | null;
  readonly proposal_id: string | null;
  readonly proposal_present: boolean;
  readonly fusion: FusionEvidence | null;
  /**
   * Independently expected verifier-registry digest (lower-case 64-hex). Must
   * equal the authorized verifier_registry_digest before reservation.
   */
  readonly expected_verifier_registry_digest: string;
  readonly final_state_consistent: boolean;
}

export type QualifiedMergeAssessment =
  | {
      readonly eligible: true;
      readonly entry: OverseerActionPolicyEntry;
      readonly proposal_id: string;
    }
  | {
      readonly eligible: false;
      readonly stage: string;
      readonly reason: string;
      readonly disposition: MergeExclusionDisposition;
    };

export const SUCCESS_CONCLUSIONS = new Set(['success', 'passed', 'neutral_ok']);

function deny(
  stage: string,
  reason: string,
  disposition: MergeExclusionDisposition = 'deny'
): QualifiedMergeAssessment {
  return { eligible: false, stage, reason, disposition };
}

/**
 * Pure ordered gate. Returns eligibility over exact evidence WITHOUT any I/O or
 * side effect. Any failing gate returns a fail-closed denial; only a target that
 * clears every gate is eligible, and even then execution re-validates live.
 */
export function assessQualifiedMerge(evidence: QualifiedMergeEvidence): QualifiedMergeAssessment {
  // 1. The PR must be genuinely green and mergeable. Zero required checks is not
  //    green (isPrGreen requires checks.total > 0), so it denies here.
  if (!isPrMergeReady(evidence.record.prEvidence) || !evidence.record.prEvidence.pr) {
    return deny('pr_evidence', 'pr_not_green_or_mergeable');
  }

  // 2. Repositories outside the internal allowlist can never merge.
  if (!isInternalMergeAllowed(evidence.repository)) {
    return deny('internal_allowlist', 'repository_not_internal', 'deny');
  }

  // 3. Deterministic exclusion of effects, release branches, and file scopes.
  const exclusion = classifyMergeExclusion({
    resulting_deployment_effect: evidence.resulting_deployment_effect,
    base_branch: evidence.base_branch,
    changed_files: evidence.changed_files,
  });
  if (exclusion.excluded) {
    return deny('exclusion', exclusion.reason, exclusion.disposition);
  }

  // 4. Only a policy-allowed tuple with MERGE listed may proceed.
  const entry = findMergePolicyTuple({
    registry: evidence.registry,
    owner: evidence.owner,
    repository: evidence.repository,
    base_branch: evidence.base_branch,
    resulting_deployment_effect: evidence.resulting_deployment_effect,
    action_kind: evidence.action_kind,
    credential_principal: evidence.credential_principal,
  });
  if (!entry) {
    return deny('policy_tuple', 'no_allowed_policy_tuple');
  }
  if (evidence.action_kind !== 'MERGE') {
    return deny('action_kind', 'action_kind_not_merge');
  }

  // 5. Non-zero required checks, all successful, all pinned to the exact head.
  if (evidence.required_checks.length === 0) {
    return deny('required_checks', 'zero_required_checks');
  }
  for (const check of evidence.required_checks) {
    if (check.head_sha !== evidence.head_sha) {
      return deny('required_checks', 'required_check_head_drift');
    }
    if (!SUCCESS_CONCLUSIONS.has(check.conclusion)) {
      return deny('required_checks', 'required_check_not_green');
    }
  }
  if (!isPrGreen(evidence.record.prEvidence)) {
    return deny('required_checks', 'pr_not_green');
  }

  // 6. Every review resolved, plus a genuinely independent review at the head.
  if (evidence.reviews.length === 0 || evidence.reviews.some(review => !review.resolved)) {
    return deny('reviews', 'reviews_unresolved');
  }
  const review = evidence.independent_review;
  if (!review?.present) {
    return deny('independent_review', 'independent_review_missing');
  }
  if (review.reviewed_head_sha !== evidence.head_sha) {
    return deny('independent_review', 'independent_review_head_drift');
  }
  if (
    review.reviewer_identity === review.builder_identity ||
    review.reviewer_provider === review.builder_provider ||
    review.reviewer_model_family === review.builder_model_family
  ) {
    return deny('independent_review', 'independent_review_correlated');
  }
  if (
    evidence.operator.identity === review.builder_identity ||
    evidence.operator.provider === review.builder_provider ||
    evidence.operator.model_family === review.builder_model_family
  ) {
    return deny('operator_recusal', 'operator_builder_correlated');
  }

  // 7. Valid manifest v2 and a current M-31 proposal.
  if (!evidence.manifest?.valid) {
    return deny('manifest', 'manifest_invalid');
  }
  if (!evidence.proposal_present || !evidence.proposal_id) {
    return deny('proposal', 'proposal_missing');
  }

  // 8. Mandatory Fusion record with disclosed components, raw dissent, and cost,
  //    content-addressed receipt/evidence digests, and an uncorrelated verifier
  //    with no hidden model substitution.
  const fusion = evidence.fusion;
  if (!fusion || !fusion.present || fusion.components.length === 0) {
    return deny('fusion', 'fusion_missing');
  }
  if (!fusion.raw_dissent_recorded || !fusion.cost_recorded) {
    return deny('fusion', 'fusion_incomplete');
  }
  if (fusion.verifier_correlated || fusion.hidden_model_substitution) {
    return deny('fusion', 'fusion_verifier_correlated');
  }
  if (!HEX64_RE.test(fusion.receipt_digest) || !HEX64_RE.test(fusion.evidence_digest)) {
    return deny('fusion', 'fusion_digest_malformed');
  }
  if (!HEX64_RE.test(evidence.expected_verifier_registry_digest)) {
    return deny('verifier', 'expected_verifier_registry_digest_malformed');
  }

  // 9. Final compare-and-act: exact live state must still match the proposal.
  if (!evidence.final_state_consistent) {
    return deny('final_compare', 'exact_state_drift');
  }

  return { eligible: true, entry, proposal_id: evidence.proposal_id };
}

/**
 * Local injected merge-adapter contract for Slice 7. Slice 8 owns runtime
 * wiring to any concrete adapter. This module never imports the legacy fake
 * mutation adapter or the v1 permit substrate.
 */
export interface QualifiedMergeAdapterRequestV2 {
  readonly schema_version: 'overseer-qualified-merge-adapter-request-v2';
  readonly permit_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly repository: string;
  readonly target_kind: 'pull_request';
  readonly target_key: string;
  readonly target_digest: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly snapshot_id: string;
  readonly action_kind: 'MERGE';
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly fusion_receipt_digest: string;
  readonly fusion_evidence_digest: string;
  readonly permit_event_digest: string;
  readonly reservation_event_digest: string;
}

export type QualifiedMergeAdapterStatusV2 = 'succeeded' | 'failed' | 'indeterminate';

export interface QualifiedMergeAdapterResultV2 {
  readonly schema_version: 'overseer-qualified-merge-adapter-result-v2';
  readonly status: QualifiedMergeAdapterStatusV2;
  readonly reason: string;
  readonly external_effect_reference: string | null;
  readonly evidence_digest: string | null;
}

export interface QualifiedMergeAdapterV2 {
  attemptMerge(request: QualifiedMergeAdapterRequestV2): Promise<QualifiedMergeAdapterResultV2>;
}

export type ReserveEffectResult =
  | { readonly ok: true; readonly value: M31ExecutionReceiptEventV2 }
  | { readonly ok: false; readonly failure: string };

export type OutcomeResult =
  | { readonly ok: true; readonly value: M31ExecutionReceiptEventV2 }
  | { readonly ok: false; readonly failure: string };

export type PrimaryOutcomeKind = 'effect_succeeded' | 'effect_failed' | 'effect_indeterminate';

export interface RecordExecutionOutcomeInput {
  readonly execution_id: string;
  readonly outcome: PrimaryOutcomeKind;
  readonly reason: string;
  readonly evidence: unknown;
  readonly external_effect_reference?: string | null;
}

export interface ReconcileQualifiedMergeInput {
  readonly execution_id: string;
  readonly outcome: 'effect_reconciled_succeeded' | 'effect_reconciled_failed';
  readonly reason: string;
  readonly evidence: unknown;
  readonly external_effect_reference?: string | null;
}

export interface ExecuteQualifiedMergeDeps extends OverseerActionsDeps, GrokJudgeDeps {
  readonly preparePermit: (proposalId: string) => Promise<PrepareM31ActionPermitV2Result>;
  readonly authorize: (permit: M31ActionPermitV2) => Promise<ActionPolicyV2AuthorizationResult>;
  readonly reserveEffect: (permit: M31ActionPermitV2) => Promise<ReserveEffectResult>;
  /**
   * Injected merge boundary. Missing DI fails closed before the permit chain.
   * Slice 8 owns the concrete wiring; this slice never constructs one.
   */
  readonly mergeAdapter: QualifiedMergeAdapterV2 | null | undefined;
  readonly recordOutcome: (input: RecordExecutionOutcomeInput) => Promise<OutcomeResult>;
  readonly reconcile: (input: ReconcileQualifiedMergeInput) => Promise<void>;
}

export interface QualifiedMergeExecution {
  readonly assessment: QualifiedMergeAssessment;
  readonly action:
    | 'merged'
    | 'merge_failed'
    | 'denied'
    | 'operator_card'
    | 'circuit_open'
    | 'permit_denied'
    | 'judge_denied'
    | 'reservation_failed'
    | 'indeterminate';
  readonly merged: boolean;
  readonly adapterCalled: boolean;
  readonly reason: string;
  readonly receipts: readonly string[];
  readonly permitEventDigest: string | null;
  readonly reservationEventDigest: string | null;
  readonly primaryOutcome: PrimaryOutcomeKind | null;
}

function dispositionAction(
  disposition: MergeExclusionDisposition
): 'operator_card' | 'circuit_open' | 'denied' {
  if (disposition === 'operator_card') return 'operator_card';
  if (disposition === 'circuit_open') return 'circuit_open';
  return 'denied';
}

async function recordAction(
  deps: ExecuteQualifiedMergeDeps,
  record: WatchedRunRecord,
  action: string,
  result: string
): Promise<void> {
  await deps.insertOverseerAction({
    runId: record.runId,
    woId: record.woId,
    class: 'tail_node_false_fail',
    action,
    result,
  });
}

function closed(
  assessment: QualifiedMergeAssessment,
  action: QualifiedMergeExecution['action'],
  reason: string,
  extras: {
    readonly adapterCalled?: boolean;
    readonly receipts?: readonly string[];
    readonly permitEventDigest?: string | null;
    readonly reservationEventDigest?: string | null;
    readonly primaryOutcome?: PrimaryOutcomeKind | null;
  } = {}
): QualifiedMergeExecution {
  return {
    assessment,
    action,
    merged: false,
    adapterCalled: extras.adapterCalled ?? false,
    reason,
    receipts: extras.receipts ?? [],
    permitEventDigest: extras.permitEventDigest ?? null,
    reservationEventDigest: extras.reservationEventDigest ?? null,
    primaryOutcome: extras.primaryOutcome ?? null,
  };
}

function isAllowedAuthorization(
  authorization: ActionPolicyV2AuthorizationResult
): authorization is Extract<ActionPolicyV2AuthorizationResult, { allowed: true }> {
  return authorization.allowed;
}

/**
 * Build the Grok judge evidence from data already present on
 * QualifiedMergeEvidence. No new evidence-gathering I/O. The evidence digest is
 * a local sha256 over the deterministic already-present subset (documented
 * deviation from the WO's "digest already present" assumption -- this evidence
 * shape carries no digest field); it is only consumed by the judge prompt and
 * stamped onto the receipt, never round-trip-validated here.
 */
function buildGrokJudgeEvidence(evidence: QualifiedMergeEvidence): GrokJudgeEvidence {
  const pr = evidence.record.prEvidence;
  const checksSummary = pr.checks;
  const filesChangedCount = pr.filesChangedCount ?? 0;
  const diffStat = pr.diffStat ?? '';
  const evidenceDigest = createHash('sha256')
    .update(
      JSON.stringify([
        evidence.record.woId,
        evidence.pr_number,
        evidence.head_sha,
        evidence.base_sha,
        checksSummary.total,
        checksSummary.passed,
        checksSummary.failed,
        checksSummary.pending,
        checksSummary.conclusion ?? '',
        filesChangedCount,
        diffStat,
      ])
    )
    .digest('hex');
  return {
    woId: evidence.record.woId,
    prNumber: evidence.pr_number,
    prTitle: pr.prTitle ?? '',
    headSha: evidence.head_sha,
    baseSha: evidence.base_sha,
    evidenceDigest,
    operator: {
      identity: evidence.operator.identity,
      provider: evidence.operator.provider,
      modelFamily: evidence.operator.model_family,
    },
    checksSummary,
    filesChangedCount,
    diffStat,
  };
}

/**
 * Exact identity recheck across evidence, permit, authorization, and the policy
 * entry before reservation. Any drift fails closed with no adapter call.
 */
function recheckIdentitiesBeforeReserve(input: {
  readonly evidence: QualifiedMergeEvidence;
  readonly entry: OverseerActionPolicyEntry;
  readonly permit: M31ActionPermitV2;
  readonly permitReceipt: M31ExecutionReceiptEventV2;
  readonly authorization: Extract<ActionPolicyV2AuthorizationResult, { allowed: true }>;
}): string | null {
  const { evidence, entry, permit, permitReceipt, authorization } = input;

  if (permitReceipt.event_type !== 'permit_issued') return 'permit_receipt_type_mismatch';
  if (permitReceipt.event_sequence !== 1) return 'permit_receipt_sequence_mismatch';
  if (!HEX64_RE.test(permitReceipt.event_digest)) return 'permit_event_digest_malformed';
  if (permitReceipt.execution_id !== permit.execution_id)
    return 'permit_receipt_execution_mismatch';
  if (permitReceipt.proposal_id !== permit.proposal_id) return 'permit_receipt_proposal_mismatch';
  if (permitReceipt.target_digest !== permit.target_digest) {
    return 'permit_receipt_target_digest_mismatch';
  }
  if (permitReceipt.previous_event_digest !== null) return 'permit_receipt_previous_not_null';

  if (permit.proposal_id !== evidence.proposal_id) return 'permit_proposal_id_mismatch';
  if (permit.action_kind !== 'MERGE') return 'permit_action_kind_not_merge';
  if (permit.repository !== `${evidence.owner}/${evidence.repository}`) {
    return 'permit_repository_mismatch';
  }
  if (permit.target.target_kind !== 'pull_request') return 'permit_target_kind_mismatch';
  if (permit.target.pr_number !== evidence.pr_number) return 'permit_pr_number_mismatch';
  if (permit.target.head_sha !== evidence.head_sha) return 'permit_head_sha_mismatch';
  if (permit.target.base_sha !== evidence.base_sha) return 'permit_base_sha_mismatch';
  if (permit.target.base_branch !== evidence.base_branch) return 'permit_base_branch_mismatch';
  if (!HEX64_RE.test(permit.target_digest)) return 'permit_target_digest_malformed';

  if (authorization.proposal_id !== permit.proposal_id) return 'auth_proposal_id_mismatch';
  if (authorization.execution_id !== permit.execution_id) return 'auth_execution_id_mismatch';
  if (authorization.repository !== permit.repository) return 'auth_repository_mismatch';
  if (authorization.target_key !== permit.target_key) return 'auth_target_key_mismatch';
  if (authorization.target_digest !== permit.target_digest) return 'auth_target_digest_mismatch';
  if (authorization.snapshot_id !== permit.snapshot_id) return 'auth_snapshot_id_mismatch';
  if (authorization.action_kind !== 'MERGE') return 'auth_action_kind_not_merge';
  if (authorization.policy_digest !== entry.policy_digest) return 'auth_policy_digest_mismatch';
  if (!HEX64_RE.test(authorization.policy_digest)) return 'auth_policy_digest_malformed';
  if (!HEX64_RE.test(authorization.verifier_registry_digest)) {
    return 'auth_verifier_registry_digest_malformed';
  }
  if (authorization.verifier_registry_digest !== evidence.expected_verifier_registry_digest) {
    return 'auth_verifier_registry_digest_mismatch';
  }
  if (!evidence.fusion || !HEX64_RE.test(evidence.fusion.receipt_digest)) {
    return 'fusion_receipt_digest_malformed';
  }
  if (!HEX64_RE.test(evidence.fusion.evidence_digest)) {
    return 'fusion_evidence_digest_malformed';
  }

  return null;
}

/**
 * Bind reservation receipt to the permit receipt digest. The reservation
 * previous digest must equal the permit receipt event digest.
 */
function bindReservationChain(
  permit: M31ActionPermitV2,
  permitReceipt: M31ExecutionReceiptEventV2,
  reservation: M31ExecutionReceiptEventV2
): string | null {
  if (reservation.event_type !== 'effect_reserved') return 'reservation_type_mismatch';
  if (reservation.event_sequence !== 2) return 'reservation_sequence_mismatch';
  if (!HEX64_RE.test(reservation.event_digest)) return 'reservation_event_digest_malformed';
  if (reservation.previous_event_digest !== permitReceipt.event_digest) {
    return 'reservation_previous_digest_mismatch';
  }
  if (reservation.execution_id !== permit.execution_id) return 'reservation_execution_mismatch';
  if (reservation.proposal_id !== permit.proposal_id) return 'reservation_proposal_mismatch';
  if (reservation.target_digest !== permit.target_digest) {
    return 'reservation_target_digest_mismatch';
  }
  if (reservation.target_key !== permit.target_key) return 'reservation_target_key_mismatch';
  return null;
}

/**
 * Bind a durable primary-outcome receipt to the exact expected v2 identity.
 * Any mismatch fails closed; callers must never report merged:true on failure.
 */
function bindPrimaryOutcomeReceipt(input: {
  readonly expectedOutcome: PrimaryOutcomeKind;
  readonly receipt: M31ExecutionReceiptEventV2;
  readonly permit: M31ActionPermitV2;
  readonly reservation: M31ExecutionReceiptEventV2;
}): string | null {
  const { expectedOutcome, receipt, permit, reservation } = input;
  if (receipt.event_type !== expectedOutcome) return 'primary_outcome_type_mismatch';
  if (receipt.event_sequence !== 3) return 'primary_outcome_sequence_mismatch';
  if (!HEX64_RE.test(receipt.event_digest)) return 'primary_outcome_event_digest_malformed';
  if (receipt.previous_event_digest !== reservation.event_digest) {
    return 'primary_outcome_previous_digest_mismatch';
  }
  if (receipt.execution_id !== permit.execution_id) return 'primary_outcome_execution_mismatch';
  if (receipt.proposal_id !== permit.proposal_id) return 'primary_outcome_proposal_mismatch';
  if (receipt.target_key !== permit.target_key) return 'primary_outcome_target_key_mismatch';
  if (receipt.target_digest !== permit.target_digest) {
    return 'primary_outcome_target_digest_mismatch';
  }
  return null;
}

async function appendPrimaryOutcome(
  deps: ExecuteQualifiedMergeDeps,
  input: RecordExecutionOutcomeInput,
  receipts: string[],
  chain: {
    readonly permit: M31ActionPermitV2;
    readonly reservation: M31ExecutionReceiptEventV2;
  }
): Promise<{ readonly recorded: PrimaryOutcomeKind | null; readonly ok: boolean }> {
  try {
    const outcome = await deps.recordOutcome(input);
    if (!outcome.ok) {
      return { recorded: null, ok: false };
    }
    // ok:true is insufficient: the durable receipt must be the exact expected
    // v2 primary outcome bound to proposal/execution/target/previous digest.
    const bindFailure = bindPrimaryOutcomeReceipt({
      expectedOutcome: input.outcome,
      receipt: outcome.value,
      permit: chain.permit,
      reservation: chain.reservation,
    });
    if (bindFailure) {
      return { recorded: null, ok: false };
    }
    receipts.push(input.outcome);
    return { recorded: input.outcome, ok: true };
  } catch {
    // Outcome-recording uncertainty after reservation: do not claim success and
    // do not retry (no replay after indeterminate / uncertain primary write).
    return { recorded: null, ok: false };
  }
}

/**
 * After reservation, every path must produce exactly one primary outcome when
 * possible: effect_succeeded only on confirmed adapter success + durable write,
 * effect_failed only on definitive zero-effect rejection, otherwise
 * effect_indeterminate. Never returns merged=true unless effect_succeeded was
 * durably recorded. No adapter or outcome replay after indeterminate.
 */
async function finalizeAfterReservation(input: {
  readonly deps: ExecuteQualifiedMergeDeps;
  readonly evidence: QualifiedMergeEvidence;
  readonly assessment: Extract<QualifiedMergeAssessment, { eligible: true }>;
  readonly permit: M31ActionPermitV2;
  readonly permitReceipt: M31ExecutionReceiptEventV2;
  readonly reservation: M31ExecutionReceiptEventV2;
  readonly authorization: Extract<ActionPolicyV2AuthorizationResult, { allowed: true }>;
  readonly receipts: string[];
}): Promise<QualifiedMergeExecution> {
  const {
    deps,
    evidence,
    assessment,
    permit,
    permitReceipt,
    reservation,
    authorization,
    receipts,
  } = input;
  const chainExtras = {
    receipts,
    permitEventDigest: permitReceipt.event_digest,
    reservationEventDigest: reservation.event_digest,
  };

  const outcomeChain = { permit, reservation };

  const adapter = deps.mergeAdapter;
  if (!adapter) {
    // Should have been caught earlier; if reached post-reserve, fail closed.
    const primary = await appendPrimaryOutcome(
      deps,
      {
        execution_id: permit.execution_id,
        outcome: 'effect_indeterminate',
        reason: 'merge_adapter_missing_after_reservation',
        evidence: { stage: 'post_reserve' },
      },
      receipts,
      outcomeChain
    );
    await recordAction(
      deps,
      evidence.record,
      'circuit_open',
      'merge_adapter_missing_after_reservation'
    );
    return closed(assessment, 'indeterminate', 'merge_adapter_missing_after_reservation', {
      ...chainExtras,
      primaryOutcome: primary.recorded ?? 'effect_indeterminate',
    });
  }

  // Fusion digests were validated at assessment and recheck; bind them into the
  // exact adapter request so the merge boundary carries content-addressed proof.
  const fusion = evidence.fusion;
  if (!fusion || !HEX64_RE.test(fusion.receipt_digest) || !HEX64_RE.test(fusion.evidence_digest)) {
    const primary = await appendPrimaryOutcome(
      deps,
      {
        execution_id: permit.execution_id,
        outcome: 'effect_indeterminate',
        reason: 'fusion_digest_missing_after_reservation',
        evidence: { stage: 'post_reserve' },
      },
      receipts,
      outcomeChain
    );
    await recordAction(
      deps,
      evidence.record,
      'circuit_open',
      'fusion_digest_missing_after_reservation'
    );
    return closed(assessment, 'indeterminate', 'fusion_digest_missing_after_reservation', {
      ...chainExtras,
      primaryOutcome: primary.recorded ?? 'effect_indeterminate',
    });
  }

  const request: QualifiedMergeAdapterRequestV2 = {
    schema_version: 'overseer-qualified-merge-adapter-request-v2',
    permit_id: permit.permit_id,
    proposal_id: permit.proposal_id,
    execution_id: permit.execution_id,
    repository: permit.repository,
    target_kind: 'pull_request',
    target_key: permit.target_key,
    target_digest: permit.target_digest,
    pr_number: evidence.pr_number,
    head_sha: evidence.head_sha,
    base_branch: evidence.base_branch,
    base_sha: evidence.base_sha,
    snapshot_id: permit.snapshot_id,
    action_kind: 'MERGE',
    policy_digest: authorization.policy_digest,
    verifier_registry_digest: authorization.verifier_registry_digest,
    fusion_receipt_digest: fusion.receipt_digest,
    fusion_evidence_digest: fusion.evidence_digest,
    permit_event_digest: permitReceipt.event_digest,
    reservation_event_digest: reservation.event_digest,
  };

  let adapterResult: QualifiedMergeAdapterResultV2;
  try {
    adapterResult = await adapter.attemptMerge(request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'adapter_threw';
    const primary = await appendPrimaryOutcome(
      deps,
      {
        execution_id: permit.execution_id,
        outcome: 'effect_indeterminate',
        reason: `adapter_threw:${reason}`,
        evidence: { stage: 'adapter_invoke' },
      },
      receipts,
      outcomeChain
    );
    await recordAction(deps, evidence.record, 'circuit_open', `adapter_threw:${reason}`);
    return closed(assessment, 'indeterminate', `adapter_threw:${reason}`, {
      ...chainExtras,
      adapterCalled: true,
      primaryOutcome: primary.recorded ?? 'effect_indeterminate',
    });
  }

  if (
    adapterResult.schema_version !== 'overseer-qualified-merge-adapter-result-v2' ||
    (adapterResult.status !== 'succeeded' &&
      adapterResult.status !== 'failed' &&
      adapterResult.status !== 'indeterminate')
  ) {
    const primary = await appendPrimaryOutcome(
      deps,
      {
        execution_id: permit.execution_id,
        outcome: 'effect_indeterminate',
        reason: 'adapter_result_invalid',
        evidence: { adapterResult },
      },
      receipts,
      outcomeChain
    );
    await recordAction(deps, evidence.record, 'circuit_open', 'adapter_result_invalid');
    return closed(assessment, 'indeterminate', 'adapter_result_invalid', {
      ...chainExtras,
      adapterCalled: true,
      primaryOutcome: primary.recorded ?? 'effect_indeterminate',
    });
  }

  if (adapterResult.status === 'failed') {
    const primary = await appendPrimaryOutcome(
      deps,
      {
        execution_id: permit.execution_id,
        outcome: 'effect_failed',
        reason: `adapter_rejected:${adapterResult.reason}`,
        evidence: {
          adapter_reason: adapterResult.reason,
          external_effect_reference: adapterResult.external_effect_reference,
          evidence_digest: adapterResult.evidence_digest,
        },
        external_effect_reference: adapterResult.external_effect_reference,
      },
      receipts,
      outcomeChain
    );
    if (!primary.ok) {
      // Could not durably record the definitive failure: escalate to indeterminate
      // once. No second adapter call.
      const indeterminate = await appendPrimaryOutcome(
        deps,
        {
          execution_id: permit.execution_id,
          outcome: 'effect_indeterminate',
          reason: `outcome_write_failed_after_adapter_reject:${adapterResult.reason}`,
          evidence: { prior_attempt: 'effect_failed' },
        },
        receipts,
        outcomeChain
      );
      await recordAction(
        deps,
        evidence.record,
        'circuit_open',
        `outcome_write_failed_after_adapter_reject:${adapterResult.reason}`
      );
      return closed(
        assessment,
        'indeterminate',
        `outcome_write_failed_after_adapter_reject:${adapterResult.reason}`,
        {
          ...chainExtras,
          adapterCalled: true,
          primaryOutcome: indeterminate.recorded ?? 'effect_indeterminate',
        }
      );
    }
    await recordAction(
      deps,
      evidence.record,
      'merge_failed',
      `adapter_rejected:${adapterResult.reason}`
    );
    return closed(assessment, 'merge_failed', `adapter_rejected:${adapterResult.reason}`, {
      ...chainExtras,
      adapterCalled: true,
      primaryOutcome: 'effect_failed',
    });
  }

  if (adapterResult.status === 'indeterminate') {
    const primary = await appendPrimaryOutcome(
      deps,
      {
        execution_id: permit.execution_id,
        outcome: 'effect_indeterminate',
        reason: `adapter_indeterminate:${adapterResult.reason}`,
        evidence: {
          adapter_reason: adapterResult.reason,
          external_effect_reference: adapterResult.external_effect_reference,
        },
        external_effect_reference: adapterResult.external_effect_reference,
      },
      receipts,
      outcomeChain
    );
    await recordAction(
      deps,
      evidence.record,
      'circuit_open',
      `adapter_indeterminate:${adapterResult.reason}`
    );
    return closed(assessment, 'indeterminate', `adapter_indeterminate:${adapterResult.reason}`, {
      ...chainExtras,
      adapterCalled: true,
      primaryOutcome: primary.recorded ?? 'effect_indeterminate',
    });
  }

  // Adapter reported definitive success: only claim merged after a durable,
  // identity-bound effect_succeeded primary outcome. effect_succeeded is the
  // terminal primary outcome under target-v2; reconciliation is allowed only
  // after effect_indeterminate and is never attempted on this success path.
  const primary = await appendPrimaryOutcome(
    deps,
    {
      execution_id: permit.execution_id,
      outcome: 'effect_succeeded',
      reason: `adapter_accepted:${adapterResult.reason}`,
      evidence: {
        adapter_reason: adapterResult.reason,
        external_effect_reference: adapterResult.external_effect_reference,
        evidence_digest: adapterResult.evidence_digest,
        entry_digest: assessment.entry.policy_digest,
        fusion_receipt_digest: fusion.receipt_digest,
        fusion_evidence_digest: fusion.evidence_digest,
      },
      external_effect_reference: adapterResult.external_effect_reference,
    },
    receipts,
    outcomeChain
  );

  if (!primary.ok) {
    // Outcome-recording uncertainty or receipt identity mismatch after a claimed
    // adapter success: never report merged. Append indeterminate once and open
    // the circuit. No replay and no reconciliation after success.
    const indeterminate = await appendPrimaryOutcome(
      deps,
      {
        execution_id: permit.execution_id,
        outcome: 'effect_indeterminate',
        reason: 'outcome_write_failed_after_adapter_success',
        evidence: { prior_attempt: 'effect_succeeded' },
      },
      receipts,
      outcomeChain
    );
    await recordAction(
      deps,
      evidence.record,
      'circuit_open',
      'outcome_write_failed_after_adapter_success'
    );
    return closed(assessment, 'indeterminate', 'outcome_write_failed_after_adapter_success', {
      ...chainExtras,
      adapterCalled: true,
      primaryOutcome: indeterminate.recorded ?? 'effect_indeterminate',
    });
  }

  await recordAction(deps, evidence.record, 'merged', `adapter_accepted:${adapterResult.reason}`);
  return {
    assessment,
    action: 'merged',
    merged: true,
    adapterCalled: true,
    reason: `adapter_accepted:${adapterResult.reason}`,
    receipts,
    permitEventDigest: permitReceipt.event_digest,
    reservationEventDigest: reservation.event_digest,
    primaryOutcome: 'effect_succeeded',
  };
}

/**
 * Run the qualified-merge gate then, only when eligible, the M-31 v2
 * prepare -> authorize -> reserve chain BEFORE the injected merge adapter, then
 * exactly one primary outcome. Every ineligible path returns without calling
 * the adapter. Post-reservation failure paths never report merged=true.
 */
export async function executeQualifiedMerge(
  evidence: QualifiedMergeEvidence,
  deps: ExecuteQualifiedMergeDeps
): Promise<QualifiedMergeExecution> {
  const receipts: string[] = [];
  const assessment = assessQualifiedMerge(evidence);
  const { record } = evidence;

  if (!assessment.eligible) {
    const action = dispositionAction(assessment.disposition);
    await recordAction(deps, record, action, `${assessment.stage}:${assessment.reason}`);
    return closed(assessment, action, assessment.reason);
  }

  // Missing DI fails closed before any permit/reservation work.
  if (!deps.mergeAdapter) {
    await recordAction(deps, record, 'denied', 'merge_adapter_missing');
    return closed(assessment, 'denied', 'merge_adapter_missing');
  }

  // Strict order: v2 prepare -> v2 authorize -> identity recheck -> judge ->
  // v2 reserve -> adapter -> outcome. The Grok second-opinion judge gate sits
  // between the identity recheck and reservation so the merge decision is gated
  // before any reservation/execution side effect.
  const permitResult = await deps.preparePermit(assessment.proposal_id);
  if (!permitResult.ok) {
    await recordAction(deps, record, 'permit_denied', 'permit_not_issued');
    return closed(assessment, 'permit_denied', 'permit_not_issued');
  }
  const permit = permitResult.permit;
  const permitReceipt = permitResult.receipt;

  const authorization = await deps.authorize(permit);
  if (!isAllowedAuthorization(authorization)) {
    await recordAction(
      deps,
      record,
      'permit_denied',
      `authorization_denied:${authorization.reason}`
    );
    return closed(assessment, 'permit_denied', `authorization_denied:${authorization.reason}`, {
      permitEventDigest: permitReceipt.event_digest,
    });
  }

  const identityFailure = recheckIdentitiesBeforeReserve({
    evidence,
    entry: assessment.entry,
    permit,
    permitReceipt,
    authorization,
  });
  if (identityFailure) {
    await recordAction(deps, record, 'permit_denied', `identity_recheck_failed:${identityFailure}`);
    return closed(assessment, 'permit_denied', `identity_recheck_failed:${identityFailure}`, {
      permitEventDigest: permitReceipt.event_digest,
    });
  }

  // Grok-family recusal (M-42 board amendment 2026-07-16): the Grok judge may
  // not review, verify, approve, or merge Grok-built work. When the
  // independent-review builder is a Grok family identity, skip the judge call
  // entirely and deny before any reservation -- an operator must take over.
  // Complements assessQualifiedMerge step 6's operator_recusal gate.
  if (isGrokFamilyBuilder(evidence.independent_review)) {
    await recordAction(deps, record, 'judge_denied', 'grok_family_builder_recusal');
    return closed(assessment, 'judge_denied', 'grok_family_builder_recusal', {
      permitEventDigest: permitReceipt.event_digest,
    });
  }

  // Grok second-opinion judge gate: fail closed. Any hold disposition (explicit
  // hold, invalid output, timeout, non-zero exit, judge error) OR a thrown judge
  // stops the merge before reserveEffect -- no reservation, no adapter call. Only
  // an explicit approve falls through to the reservation chain unchanged.
  const judgeEvidence = buildGrokJudgeEvidence(evidence);
  let disposition: GrokDispositionReceipt;
  try {
    disposition = deps.judgeSecondOpinion
      ? await deps.judgeSecondOpinion(judgeEvidence)
      : await judgeWithGrok(judgeEvidence);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'judge_threw';
    await recordAction(deps, record, 'judge_denied', `judge_threw:${reason}`);
    return closed(assessment, 'judge_denied', `judge_threw:${reason}`, {
      permitEventDigest: permitReceipt.event_digest,
    });
  }
  if (disposition.disposition !== 'approve') {
    await recordAction(deps, record, 'judge_denied', `judge_hold:${disposition.reason}`);
    return closed(assessment, 'judge_denied', `judge_hold:${disposition.reason}`, {
      permitEventDigest: permitReceipt.event_digest,
    });
  }

  const reservation = await deps.reserveEffect(permit);
  if (!reservation.ok) {
    await recordAction(
      deps,
      record,
      'reservation_failed',
      `effect_not_reserved:${reservation.failure}`
    );
    return closed(assessment, 'reservation_failed', `effect_not_reserved:${reservation.failure}`, {
      permitEventDigest: permitReceipt.event_digest,
    });
  }

  const chainFailure = bindReservationChain(permit, permitReceipt, reservation.value);
  if (chainFailure) {
    // Reservation returned but chain binding failed: fail closed as indeterminate
    // with a primary outcome and never call the adapter.
    receipts.push('effect_reserved');
    const primary = await appendPrimaryOutcome(
      deps,
      {
        execution_id: permit.execution_id,
        outcome: 'effect_indeterminate',
        reason: `reservation_chain_invalid:${chainFailure}`,
        evidence: {
          permit_event_digest: permitReceipt.event_digest,
          reservation_previous: reservation.value.previous_event_digest,
          reservation_event_digest: reservation.value.event_digest,
        },
      },
      receipts,
      { permit, reservation: reservation.value }
    );
    await recordAction(deps, record, 'circuit_open', `reservation_chain_invalid:${chainFailure}`);
    return closed(assessment, 'indeterminate', `reservation_chain_invalid:${chainFailure}`, {
      receipts,
      permitEventDigest: permitReceipt.event_digest,
      reservationEventDigest: reservation.value.event_digest,
      primaryOutcome: primary.recorded ?? 'effect_indeterminate',
    });
  }
  receipts.push('effect_reserved');

  return finalizeAfterReservation({
    deps,
    evidence,
    assessment,
    permit,
    permitReceipt,
    reservation: reservation.value,
    authorization,
    receipts,
  });
}

/**
 * Public merge-ready entry point. Rewired for Slice 7: no merge dependency is
 * reachable without the M-31 v2 permit, the content-addressed policy tuple, the
 * effect reservation, and independent proof. Delegates wholly to
 * {@link executeQualifiedMerge}.
 */
export async function handleMergeReady(
  evidence: QualifiedMergeEvidence,
  deps: ExecuteQualifiedMergeDeps
): Promise<QualifiedMergeExecution> {
  return executeQualifiedMerge(evidence, deps);
}
