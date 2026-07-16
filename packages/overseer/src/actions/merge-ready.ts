/**
 * Qualified non-production merge (M-42 Slice 7).
 *
 * The merge-ready action never reaches the fake GitHub merge adapter unless an
 * exact, independently verified, policy-allowed tuple clears every ordered gate.
 * Assessment is a pure ordered predicate over exact evidence; execution runs the
 * M-31 v2 permit -> authorize -> reserve chain BEFORE the adapter and only then
 * appends the succeeded/reconciled receipts. Every excluded or indeterminate
 * target fails closed before any provider mutation.
 *
 * Slice 7 ships an empty live registry and leaves the merge capability disabled;
 * this module is exercised only through injected deterministic dependencies and
 * synthetic fixtures. Runtime wiring (service/watch) is owned exclusively by
 * Slice 8 and is intentionally not touched here.
 */
import { isPrGreen, isPrMergeReady } from '../judge-pr';
import type { OverseerActionsDeps, WatchedRunRecord } from '../types.ts';
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
import type { AuthorizeOverseerActionInput } from '../action-policy';
import type { FakeGitHubMutationRequest, FakeGitHubReceipt } from '../adapters/fake-github';

/** Internal repositories the Overseer may ever merge, independent of policy. */
const INTERNAL_REPO_ALLOWLIST = new Set(['bdc-harness', 'bdc-xo']);

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
  readonly manifest: { readonly valid: boolean } | null;
  readonly proposal_id: string | null;
  readonly proposal_present: boolean;
  readonly fusion: FusionEvidence | null;
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

const SUCCESS_CONCLUSIONS = new Set(['success', 'passed', 'neutral_ok']);

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

  // 7. Valid manifest v2 and a current M-31 proposal.
  if (!evidence.manifest?.valid) {
    return deny('manifest', 'manifest_invalid');
  }
  if (!evidence.proposal_present || !evidence.proposal_id) {
    return deny('proposal', 'proposal_missing');
  }

  // 8. Mandatory Fusion record with disclosed components, raw dissent, and cost,
  //    and an uncorrelated verifier with no hidden model substitution.
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

  // 9. Final compare-and-act: exact live state must still match the proposal.
  if (!evidence.final_state_consistent) {
    return deny('final_compare', 'exact_state_drift');
  }

  return { eligible: true, entry, proposal_id: evidence.proposal_id };
}

export type ReserveEffectResult =
  | { readonly ok: true; readonly value: M31ExecutionReceiptEventV2 }
  | { readonly ok: false; readonly failure: string };

export type OutcomeResult =
  | { readonly ok: true; readonly value: M31ExecutionReceiptEventV2 }
  | { readonly ok: false; readonly failure: string };

export interface RecordExecutionOutcomeInput {
  readonly execution_id: string;
  readonly outcome: 'effect_succeeded';
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

export interface ExecuteQualifiedMergeDeps extends OverseerActionsDeps {
  readonly preparePermit: (proposalId: string) => Promise<PrepareM31ActionPermitV2Result>;
  readonly authorize: (permit: M31ActionPermitV2) => Promise<ActionPolicyV2AuthorizationResult>;
  readonly reserveEffect: (permit: M31ActionPermitV2) => Promise<ReserveEffectResult>;
  readonly attemptFakeMerge: (
    request: FakeGitHubMutationRequest,
    authorization: AuthorizeOverseerActionInput
  ) => Promise<FakeGitHubReceipt>;
  /**
   * The V1-shaped authorization the frozen fake adapter requires. Sourced by the
   * injector (runtime/tests), never fabricated from the v1 merge-steward table by
   * this slice.
   */
  readonly fakeMergeAuthorization: AuthorizeOverseerActionInput;
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
    | 'reservation_failed';
  readonly merged: boolean;
  readonly adapterCalled: boolean;
  readonly reason: string;
  readonly receipts: readonly string[];
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

/**
 * Run the qualified-merge gate then, only when eligible, the M-31 v2
 * prepare -> authorize -> reserve chain BEFORE the fake merge adapter, then the
 * succeeded + reconciled receipts. Every ineligible or indeterminate path
 * returns without calling the adapter.
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
    return {
      assessment,
      action,
      merged: false,
      adapterCalled: false,
      reason: assessment.reason,
      receipts,
    };
  }

  // Final live compare-and-act happens inside the v2 permit/reserve chain: any
  // drift there stops before the adapter is ever reached.
  const permitResult = await deps.preparePermit(assessment.proposal_id);
  if (!permitResult.ok) {
    await recordAction(deps, record, 'permit_denied', 'permit_not_issued');
    return {
      assessment,
      action: 'permit_denied',
      merged: false,
      adapterCalled: false,
      reason: 'permit_not_issued',
      receipts,
    };
  }
  const permit = permitResult.permit;

  const authorization = await deps.authorize(permit);
  if (!authorization.allowed) {
    await recordAction(
      deps,
      record,
      'permit_denied',
      `authorization_denied:${authorization.reason}`
    );
    return {
      assessment,
      action: 'permit_denied',
      merged: false,
      adapterCalled: false,
      reason: `authorization_denied:${authorization.reason}`,
      receipts,
    };
  }

  const reservation = await deps.reserveEffect(permit);
  if (!reservation.ok) {
    await recordAction(
      deps,
      record,
      'reservation_failed',
      `effect_not_reserved:${reservation.failure}`
    );
    return {
      assessment,
      action: 'reservation_failed',
      merged: false,
      adapterCalled: false,
      reason: `effect_not_reserved:${reservation.failure}`,
      receipts,
    };
  }
  receipts.push('effect_reserved');

  const request: FakeGitHubMutationRequest = {
    permit_id: permit.permit_id,
    repository: `${evidence.owner}/${evidence.repository}`,
    pr_number: evidence.pr_number,
    head_sha: evidence.head_sha,
    base_branch: evidence.base_branch,
    base_sha: evidence.base_sha,
    snapshot_id: permit.snapshot_id,
    proposal_id: permit.proposal_id,
    execution_id: permit.execution_id,
    action_kind: permit.action_kind,
  };
  const receipt = await deps.attemptFakeMerge(request, deps.fakeMergeAuthorization);
  if (!receipt.accepted) {
    await recordAction(deps, record, 'merge_failed', `fake_merge_rejected:${receipt.reason}`);
    return {
      assessment,
      action: 'merge_failed',
      merged: false,
      adapterCalled: true,
      reason: `fake_merge_rejected:${receipt.reason}`,
      receipts,
    };
  }

  const outcome = await deps.recordOutcome({
    execution_id: permit.execution_id,
    outcome: 'effect_succeeded',
    reason: 'fake_merge_accepted',
    evidence: { adapter: receipt.adapter, permit_id: permit.permit_id },
  });
  if (outcome.ok) receipts.push('effect_succeeded');

  await deps.reconcile({
    execution_id: permit.execution_id,
    outcome: outcome.ok ? 'effect_reconciled_succeeded' : 'effect_reconciled_failed',
    reason: outcome.ok ? 'fake_merge_reconciled' : 'outcome_append_failed',
    evidence: { entry_digest: assessment.entry.policy_digest },
  });

  await recordAction(deps, record, 'merged', 'fake_merge_accepted');
  return {
    assessment,
    action: 'merged',
    merged: true,
    adapterCalled: true,
    reason: 'fake_merge_accepted',
    receipts,
  };
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
