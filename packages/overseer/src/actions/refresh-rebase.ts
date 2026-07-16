/**
 * M-42 Slice 5 -- eligible branch refresh/rebase.
 *
 * Refreshes or rebases an eligible controlled factory branch onto its exact
 * canonical non-production base without hiding conflicts, rewriting an unowned
 * branch, or trusting stale review evidence. This module is pure orchestration:
 * worktree/Git mutation and the content-addressed policy decision are injected,
 * and the M-31 gate/reservation steps are injected function seams (Slice 8 wires
 * the real @archon/core m31-target-v2 functions and a real Git adapter). This
 * source file imports no Git package and shells out to nothing.
 *
 * Hard floors (every one stops, no auto-resolution, no force-push):
 *  - branch gate disabled / incomplete evidence -> report_only
 *  - dirty worktree / unowned branch / base mismatch / ineligible base -> ineligible
 *  - any rebase conflict (mechanical..unknown) -> escalate
 *  - head/base/policy drift after proposal -> live_state_mismatch
 *  - CI or review evidence not bound to the new exact head -> evidence_required
 */

import type {
  M31ActionPermitV2,
  M31ExecutionReceiptEventV2,
  M31TargetV2TypedFailure,
} from '@archon/core/db/m31-target-v2';
import type { OverseerCapability } from '@archon/core/db/overseer-capabilities';
import type {
  BranchMutationAdapterV1,
  BranchMutationDepsV1,
  RebaseConflictProbeV1,
  WorktreeObservationV1,
} from '../adapters/branch-mutation';

export type RefreshRebaseModeV1 = 'REFRESH' | 'REBASE';

/**
 * Structural policy dependency defined by audit Section 7.3. The action module
 * consumes its decision and never imports the Slice 7 registry. Only
 * non-production bases explicitly listed in the content-addressed policy
 * registry are eligible.
 *
 * NOTE (Major Build): the four bdc-xo governance docs (including the Wave 2
 * audit that fixes Section 7.3's exact shape) are not reachable from this build
 * container, so this interface is modeled on the existing frozen
 * ActionPolicyV2Input / evaluateActionPolicyV2 family in action-policy-v2.ts
 * (same injected pure-decision pattern, no I/O). It is defined locally and not
 * imported from any module, so this assumption creates only Slice 8 integration
 * risk, never a compile/test coupling. Flagged in the completion manifest.
 */
export interface ActionPolicyEvaluationInputV1 {
  readonly repository: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly action_kind: RefreshRebaseModeV1;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
}

export type ActionPolicyEvaluationDecisionV1 =
  | { readonly eligible: true; readonly base_eligible: true; readonly effect_allowed: true }
  | { readonly eligible: false; readonly reason: string };

export interface InjectedActionPolicyDepsV1 {
  evaluateActionPolicy(input: ActionPolicyEvaluationInputV1): ActionPolicyEvaluationDecisionV1;
}

/** Every conflict classification is a stop. This WO resolves none of them. */
export type RebaseConflictClassV1 =
  | 'mechanical'
  | 'semantic'
  | 'schema'
  | 'migration'
  | 'security'
  | 'ownership'
  | 'generated'
  | 'release_contract'
  | 'unknown';

const OWNERSHIP_RE = /(^|\/)(CODEOWNERS|OWNERS)$/;
const SECURITY_RE =
  /(^|\/|[-_.])(auth|security|secret|secrets|credential|credentials|password|token)([-_./]|$)|\.(pem|key)$/i;
const MIGRATION_RE = /(^|\/)migrations\/|\.sql$/;
const SCHEMA_RE = /(^|[-_./])schema([-_./]|$)|\.prisma$/i;
const RELEASE_CONTRACT_RE =
  /(^|\/)(CHANGELOG\.md|package\.json)$|(^|\/)docs\/contracts\/|(^|\/)RELEASE/;
const GENERATED_RE =
  /\.generated\.|(^|\/)dist\/|(^|\/)(bun\.lockb|package-lock\.json|yarn\.lock)$|\.min\./;

/**
 * Map a real rebase conflict probe to exactly one taxonomy class. Path-based
 * severe categories win over content-signal categories; unknown is the floor.
 * The caller treats every returned class as an escalate stop.
 */
export function classifyRebaseConflict(input: RebaseConflictProbeV1): RebaseConflictClassV1 {
  if (!input.conflicted || input.conflict_paths.length === 0) return 'unknown';
  const paths = input.conflict_paths;
  if (paths.some(path => OWNERSHIP_RE.test(path))) return 'ownership';
  if (paths.some(path => SECURITY_RE.test(path))) return 'security';
  if (paths.some(path => MIGRATION_RE.test(path))) return 'migration';
  if (paths.some(path => SCHEMA_RE.test(path))) return 'schema';
  if (paths.some(path => RELEASE_CONTRACT_RE.test(path))) return 'release_contract';
  if (paths.some(path => GENERATED_RE.test(path))) return 'generated';
  if (input.conflict_signal === 'whitespace') return 'mechanical';
  if (input.conflict_signal === 'logic') return 'semantic';
  return 'unknown';
}

export interface RunAuthorityBindingV1 {
  readonly run_id: string;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly factory_created: boolean;
}

export interface PullRequestSnapshotV1 {
  readonly pr_number: number;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
}

export interface BranchCandidateInputV1 {
  readonly repository: string;
  readonly branch: string;
  readonly worktree_path: string;
  readonly branch_gate_enabled: boolean;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly run_authority: RunAuthorityBindingV1;
  readonly pr_snapshot: PullRequestSnapshotV1 | null;
  readonly worktree: WorktreeObservationV1;
  readonly unique_commits: number;
  readonly rebase_probe: RebaseConflictProbeV1 | null;
}

export interface BranchProposalBindingV1 {
  readonly mode: RefreshRebaseModeV1;
  readonly bound_head_sha: string;
  readonly bound_base_sha: string;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
}

export type BranchAssessmentResultV1 =
  | ({ readonly disposition: 'refresh' } & BranchProposalBindingV1)
  | ({ readonly disposition: 'rebase' } & BranchProposalBindingV1)
  | { readonly disposition: 'report_only'; readonly reason: string }
  | { readonly disposition: 'ineligible'; readonly reason: string }
  | {
      readonly disposition: 'escalate';
      readonly reason: string;
      readonly conflict_class: RebaseConflictClassV1;
    };

export interface AssessBranchRefreshDepsV1 {
  readonly policy: InjectedActionPolicyDepsV1;
}

/**
 * Deterministic eligibility assessment. Pure over its observation inputs: it
 * calls only the injected pure policy evaluator and never touches the Git
 * mutation adapter, so a classified conflict yields zero adapter calls.
 */
export function assessBranchRefreshCandidate(
  input: BranchCandidateInputV1,
  deps: AssessBranchRefreshDepsV1
): BranchAssessmentResultV1 {
  if (!input.branch_gate_enabled) {
    return { disposition: 'report_only', reason: 'branch_gate_disabled' };
  }
  if (!input.pr_snapshot) {
    return { disposition: 'report_only', reason: 'incomplete_pr_evidence' };
  }

  const auth = input.run_authority;
  const pr = input.pr_snapshot;
  const observed = input.worktree;

  // Exact identity binding across run authority, PR snapshot, and worktree.
  if (
    pr.head_sha !== auth.head_sha ||
    observed.head_sha !== auth.head_sha ||
    observed.current_branch !== input.branch
  ) {
    return { disposition: 'report_only', reason: 'evidence_binding_mismatch' };
  }

  // Fail-closed floors before any permit/reservation.
  if (!observed.clean) {
    return { disposition: 'ineligible', reason: 'dirty_worktree' };
  }
  if (!observed.factory_owned || !auth.factory_created) {
    return { disposition: 'ineligible', reason: 'unowned_branch' };
  }
  if (pr.base_branch !== auth.base_branch || pr.base_sha !== auth.base_sha) {
    return { disposition: 'ineligible', reason: 'base_mismatch' };
  }

  const mode: RefreshRebaseModeV1 = input.unique_commits > 0 ? 'REBASE' : 'REFRESH';

  const policyDecision = deps.policy.evaluateActionPolicy({
    repository: input.repository,
    base_branch: auth.base_branch,
    base_sha: auth.base_sha,
    action_kind: mode,
    policy_digest: input.policy_digest,
    verifier_registry_digest: input.verifier_registry_digest,
  });
  if (!policyDecision.eligible) {
    return { disposition: 'ineligible', reason: `policy_ineligible:${policyDecision.reason}` };
  }

  const binding: BranchProposalBindingV1 = {
    mode,
    bound_head_sha: auth.head_sha,
    bound_base_sha: auth.base_sha,
    policy_digest: input.policy_digest,
    verifier_registry_digest: input.verifier_registry_digest,
  };

  if (mode === 'REBASE') {
    if (!input.rebase_probe) {
      return { disposition: 'ineligible', reason: 'rebase_probe_required' };
    }
    if (input.rebase_probe.conflicted) {
      const conflictClass = classifyRebaseConflict(input.rebase_probe);
      return {
        disposition: 'escalate',
        reason: `rebase_conflict:${conflictClass}`,
        conflict_class: conflictClass,
      };
    }
    return { disposition: 'rebase', ...binding };
  }

  return { disposition: 'refresh', ...binding };
}

/** Post-rewrite CI evidence, bound to a specific head. */
export interface PostRewriteCiEvidenceV1 {
  readonly head_sha: string;
  readonly green: boolean;
}

/** Post-rewrite independent review receipt, bound to a specific head. */
export interface PostRewriteReviewEvidenceV1 {
  readonly reviewed_head_sha: string;
  readonly verdict: string;
  readonly independent: boolean;
}

export interface PostRewriteEvidenceInputV1 {
  readonly new_head_sha: string;
  readonly ci: PostRewriteCiEvidenceV1 | null;
  readonly review: PostRewriteReviewEvidenceV1 | null;
}

export type PostRewriteEvidenceRejectionV1 =
  | 'ci_missing'
  | 'ci_stale_head'
  | 'ci_not_green'
  | 'review_missing'
  | 'review_stale_head'
  | 'review_not_independent'
  | 'review_not_approved';

export type PostRewriteEvidenceResultV1 =
  | { readonly satisfied: true }
  | { readonly satisfied: false; readonly reason: PostRewriteEvidenceRejectionV1 };

/**
 * Reject any CI or review evidence that is not bound to the new exact head. No
 * old approval, check, mergeability, or review survives a head rewrite.
 */
export function requirePostRewriteEvidence(
  input: PostRewriteEvidenceInputV1
): PostRewriteEvidenceResultV1 {
  if (!input.ci) return { satisfied: false, reason: 'ci_missing' };
  if (input.ci.head_sha !== input.new_head_sha) {
    return { satisfied: false, reason: 'ci_stale_head' };
  }
  if (!input.ci.green) return { satisfied: false, reason: 'ci_not_green' };

  if (!input.review) return { satisfied: false, reason: 'review_missing' };
  if (input.review.reviewed_head_sha !== input.new_head_sha) {
    return { satisfied: false, reason: 'review_stale_head' };
  }
  if (!input.review.independent) {
    return { satisfied: false, reason: 'review_not_independent' };
  }
  if (input.review.verdict !== 'APPROVE') {
    return { satisfied: false, reason: 'review_not_approved' };
  }
  return { satisfied: true };
}

export type ReceiptResultV1 =
  | { readonly ok: true; readonly receipt: M31ExecutionReceiptEventV2 }
  | { readonly ok: false; readonly failure: M31TargetV2TypedFailure };

export interface PreparePermitRequestV1 {
  readonly proposal_id: string;
}

export type PreparePermitResultV1 =
  | {
      readonly ok: true;
      readonly permit: M31ActionPermitV2;
      readonly receipt: M31ExecutionReceiptEventV2;
    }
  | { readonly ok: false; readonly denied: string };

export interface AuthorizeBranchRequestV1 {
  readonly requested_capability: OverseerCapability;
  readonly permit: M31ActionPermitV2;
  readonly actor: string;
  readonly correlation_id: string;
}

export type AuthorizeBranchResultV1 =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface ReserveEffectRequestV1 {
  readonly permit: M31ActionPermitV2;
  readonly adapter_name: string;
  readonly provider_operation: string;
  readonly reason: string;
  readonly evidence: unknown;
}

export interface RecordOutcomeRequestV1 {
  readonly execution_id: string;
  readonly outcome: 'effect_succeeded' | 'effect_failed' | 'effect_indeterminate';
  readonly reason: string;
  readonly evidence: unknown;
  readonly external_effect_reference?: string | null;
}

/**
 * Injected M-31 gate/reservation seams. Slice 8 wires these to the frozen
 * @archon/core/db/m31-target-v2 functions (prepareM31ActionPermitV2,
 * authorizeOverseerActionV2, reserveM31ExecutionEffectV2,
 * appendM31ExecutionOutcomeV2). Injected here so this action stays pure and
 * DB-free and its exact gate/receipt order is testable with fakes.
 */
export interface RefreshRebaseGateDepsV1 {
  preparePermit(input: PreparePermitRequestV1): Promise<PreparePermitResultV1>;
  authorizeBranchAction(input: AuthorizeBranchRequestV1): Promise<AuthorizeBranchResultV1>;
  reserveEffect(input: ReserveEffectRequestV1): Promise<ReceiptResultV1>;
  recordOutcome(input: RecordOutcomeRequestV1): Promise<ReceiptResultV1>;
}

export interface ExecuteRefreshRebaseInputV1 {
  readonly candidate: Omit<BranchCandidateInputV1, 'worktree' | 'unique_commits' | 'rebase_probe'>;
  readonly proposal_id: string;
  readonly actor: string;
  readonly correlation_id: string;
}

export interface ExecuteRefreshRebaseDepsV1 {
  readonly policy: InjectedActionPolicyDepsV1;
  /** Read-only observation primitives (never mutate the branch). */
  readonly observer: BranchMutationDepsV1;
  /** The mutating adapter -- only reached after permit+authorize+reserve. */
  readonly adapter: BranchMutationAdapterV1;
  readonly gate: RefreshRebaseGateDepsV1;
  /** Fetches CI + review evidence bound to the post-rewrite head. */
  fetchPostRewriteEvidence(input: {
    readonly new_head_sha: string;
    readonly execution_id: string;
  }): Promise<{
    readonly ci: PostRewriteCiEvidenceV1 | null;
    readonly review: PostRewriteReviewEvidenceV1 | null;
  }>;
}

export type ExecuteRefreshRebaseOutcomeV1 =
  | 'report_only'
  | 'ineligible'
  | 'escalate'
  | 'denied'
  | 'reserve_failed'
  | 'live_state_mismatch'
  | 'conflict'
  | 'evidence_required'
  | 'outcome_record_failed'
  | 'succeeded';

export interface ExecuteRefreshRebaseResultV1 {
  readonly outcome: ExecuteRefreshRebaseOutcomeV1;
  readonly assessment: BranchAssessmentResultV1;
  readonly reason: string | null;
  readonly mode: RefreshRebaseModeV1 | null;
  readonly old_head_sha: string | null;
  readonly new_head_sha: string | null;
  readonly new_tree_sha: string | null;
  readonly conflict_class: RebaseConflictClassV1 | null;
  readonly receipt_types: readonly M31ExecutionReceiptEventV2['event_type'][];
  readonly receipts: readonly M31ExecutionReceiptEventV2[];
}

const BRANCH_CAPABILITY: OverseerCapability = 'branch';

function result(
  partial: Omit<ExecuteRefreshRebaseResultV1, 'receipt_types'>
): ExecuteRefreshRebaseResultV1 {
  return { ...partial, receipt_types: partial.receipts.map(receipt => receipt.event_type) };
}

/**
 * Gated action flow:
 *   observe -> assess -> prepare permit -> authorize('branch') -> reserve
 *   -> compare-and-act (live head/base/policy) -> mutate -> classify any
 *   conflict (stop) -> require post-rewrite CI + independent review -> outcome.
 *
 * The mutating adapter is only ever reached on the eligible, conflict-free,
 * live-state-consistent path after a reservation exists. Every other path stops
 * with zero adapter calls and no force-push.
 */
export async function executeRefreshRebase(
  input: ExecuteRefreshRebaseInputV1,
  deps: ExecuteRefreshRebaseDepsV1
): Promise<ExecuteRefreshRebaseResultV1> {
  const candidate = input.candidate;

  const worktree = await deps.observer.observeWorktree({
    worktree_path: candidate.worktree_path,
    branch: candidate.branch,
  });
  const uniqueCommits = await deps.observer.countUniqueCommits({
    worktree_path: candidate.worktree_path,
    base_sha: candidate.run_authority.base_sha,
    head_sha: candidate.run_authority.head_sha,
  });
  const rebaseProbe =
    uniqueCommits > 0
      ? await deps.observer.probeRebase({
          worktree_path: candidate.worktree_path,
          base_sha: candidate.run_authority.base_sha,
        })
      : null;

  const assessment = assessBranchRefreshCandidate(
    { ...candidate, worktree, unique_commits: uniqueCommits, rebase_probe: rebaseProbe },
    { policy: deps.policy }
  );

  const emptyReceipts: readonly M31ExecutionReceiptEventV2[] = [];

  if (
    assessment.disposition === 'report_only' ||
    assessment.disposition === 'ineligible' ||
    assessment.disposition === 'escalate'
  ) {
    return result({
      outcome: assessment.disposition,
      assessment,
      reason: assessment.reason,
      mode: null,
      old_head_sha: null,
      new_head_sha: null,
      new_tree_sha: null,
      conflict_class: assessment.disposition === 'escalate' ? assessment.conflict_class : null,
      receipts: emptyReceipts,
    });
  }

  const mode = assessment.mode;
  const receipts: M31ExecutionReceiptEventV2[] = [];

  const permitResult = await deps.gate.preparePermit({ proposal_id: input.proposal_id });
  if (!permitResult.ok) {
    return result({
      outcome: 'denied',
      assessment,
      reason: permitResult.denied,
      mode,
      old_head_sha: assessment.bound_head_sha,
      new_head_sha: null,
      new_tree_sha: null,
      conflict_class: null,
      receipts,
    });
  }
  receipts.push(permitResult.receipt);
  const permit = permitResult.permit;

  const authorization = await deps.gate.authorizeBranchAction({
    requested_capability: BRANCH_CAPABILITY,
    permit,
    actor: input.actor,
    correlation_id: input.correlation_id,
  });
  if (!authorization.allowed) {
    return result({
      outcome: 'denied',
      assessment,
      reason: authorization.reason,
      mode,
      old_head_sha: assessment.bound_head_sha,
      new_head_sha: null,
      new_tree_sha: null,
      conflict_class: null,
      receipts,
    });
  }

  const reservation = await deps.gate.reserveEffect({
    permit,
    adapter_name: 'fake-branch-mutation',
    provider_operation: mode,
    reason: `branch_${mode.toLowerCase()}`,
    evidence: {
      bound_head_sha: assessment.bound_head_sha,
      bound_base_sha: assessment.bound_base_sha,
      policy_digest: assessment.policy_digest,
      verifier_registry_digest: assessment.verifier_registry_digest,
    },
  });
  if (!reservation.ok) {
    return result({
      outcome: 'reserve_failed',
      assessment,
      reason: reservation.failure,
      mode,
      old_head_sha: assessment.bound_head_sha,
      new_head_sha: null,
      new_tree_sha: null,
      conflict_class: null,
      receipts,
    });
  }
  receipts.push(reservation.receipt);

  // After a reservation exists, every terminal stop MUST append its v2 outcome
  // receipt and MUST detect a failure to write it. This records the outcome,
  // pushes the receipt on success, and surfaces a write failure to the caller.
  const recordTerminalOutcome = async (
    request: RecordOutcomeRequestV1
  ): Promise<ReceiptResultV1> => {
    const receiptResult = await deps.gate.recordOutcome(request);
    if (receiptResult.ok) {
      receipts.push(receiptResult.receipt);
    }
    return receiptResult;
  };

  // Final compare-and-act: reject any head/base/policy drift since assessment.
  const live = await deps.observer.observeWorktree({
    worktree_path: candidate.worktree_path,
    branch: candidate.branch,
  });
  const livePolicy = deps.policy.evaluateActionPolicy({
    repository: candidate.repository,
    base_branch: candidate.run_authority.base_branch,
    base_sha: candidate.run_authority.base_sha,
    action_kind: mode,
    policy_digest: candidate.policy_digest,
    verifier_registry_digest: candidate.verifier_registry_digest,
  });
  if (
    live.head_sha !== assessment.bound_head_sha ||
    live.current_branch !== candidate.branch ||
    !live.clean ||
    !live.factory_owned ||
    !livePolicy.eligible ||
    candidate.policy_digest !== assessment.policy_digest ||
    candidate.verifier_registry_digest !== assessment.verifier_registry_digest
  ) {
    const outcomeReceipt = await recordTerminalOutcome({
      execution_id: permit.execution_id,
      outcome: 'effect_failed',
      reason: 'live_state_mismatch',
      evidence: {
        observed_head_sha: live.head_sha,
        observed_branch: live.current_branch,
        bound_head_sha: assessment.bound_head_sha,
        bound_branch: candidate.branch,
      },
    });
    if (!outcomeReceipt.ok) {
      return result({
        outcome: 'outcome_record_failed',
        assessment,
        reason: `live_state_mismatch;outcome_record_failed:${outcomeReceipt.failure}`,
        mode,
        old_head_sha: assessment.bound_head_sha,
        new_head_sha: null,
        new_tree_sha: null,
        conflict_class: null,
        receipts,
      });
    }
    return result({
      outcome: 'live_state_mismatch',
      assessment,
      reason: 'live_state_mismatch',
      mode,
      old_head_sha: assessment.bound_head_sha,
      new_head_sha: null,
      new_tree_sha: null,
      conflict_class: null,
      receipts,
    });
  }

  const mutation = await deps.adapter.perform({
    worktree_path: candidate.worktree_path,
    branch: candidate.branch,
    base_sha: assessment.bound_base_sha,
    old_head_sha: assessment.bound_head_sha,
    mode,
    permit_id: permit.permit_id,
    execution_id: permit.execution_id,
  });

  if (mutation.status === 'conflict') {
    const conflictClass = classifyRebaseConflict(mutation.conflict);
    const outcomeReceipt = await recordTerminalOutcome({
      execution_id: permit.execution_id,
      outcome: 'effect_failed',
      reason: `rebase_conflict:${conflictClass}`,
      evidence: { conflict: mutation.conflict },
    });
    if (!outcomeReceipt.ok) {
      return result({
        outcome: 'outcome_record_failed',
        assessment,
        reason: `rebase_conflict:${conflictClass};outcome_record_failed:${outcomeReceipt.failure}`,
        mode,
        old_head_sha: assessment.bound_head_sha,
        new_head_sha: null,
        new_tree_sha: null,
        conflict_class: conflictClass,
        receipts,
      });
    }
    return result({
      outcome: 'conflict',
      assessment,
      reason: `rebase_conflict:${conflictClass}`,
      mode,
      old_head_sha: assessment.bound_head_sha,
      new_head_sha: null,
      new_tree_sha: null,
      conflict_class: conflictClass,
      receipts,
    });
  }

  const newHeadSha = mutation.new_head_sha;
  const evidence = await deps.fetchPostRewriteEvidence({
    new_head_sha: newHeadSha,
    execution_id: permit.execution_id,
  });
  const evidenceResult = requirePostRewriteEvidence({
    new_head_sha: newHeadSha,
    ci: evidence.ci,
    review: evidence.review,
  });
  if (!evidenceResult.satisfied) {
    const outcomeReceipt = await recordTerminalOutcome({
      execution_id: permit.execution_id,
      outcome: 'effect_indeterminate',
      reason: `post_rewrite_evidence:${evidenceResult.reason}`,
      evidence: { new_head_sha: newHeadSha },
    });
    if (!outcomeReceipt.ok) {
      return result({
        outcome: 'outcome_record_failed',
        assessment,
        reason: `post_rewrite_evidence:${evidenceResult.reason};outcome_record_failed:${outcomeReceipt.failure}`,
        mode,
        old_head_sha: assessment.bound_head_sha,
        new_head_sha: newHeadSha,
        new_tree_sha: mutation.new_tree_sha,
        conflict_class: null,
        receipts,
      });
    }
    return result({
      outcome: 'evidence_required',
      assessment,
      reason: `post_rewrite_evidence:${evidenceResult.reason}`,
      mode,
      old_head_sha: assessment.bound_head_sha,
      new_head_sha: newHeadSha,
      new_tree_sha: mutation.new_tree_sha,
      conflict_class: null,
      receipts,
    });
  }

  const outcomeReceipt = await deps.gate.recordOutcome({
    execution_id: permit.execution_id,
    outcome: 'effect_succeeded',
    reason: `branch_${mode.toLowerCase()}`,
    evidence: {
      old_head_sha: assessment.bound_head_sha,
      new_head_sha: newHeadSha,
      new_tree_sha: mutation.new_tree_sha,
    },
    external_effect_reference: newHeadSha,
  });
  if (!outcomeReceipt.ok) {
    return result({
      outcome: 'outcome_record_failed',
      assessment,
      reason: outcomeReceipt.failure,
      mode,
      old_head_sha: assessment.bound_head_sha,
      new_head_sha: newHeadSha,
      new_tree_sha: mutation.new_tree_sha,
      conflict_class: null,
      receipts,
    });
  }
  receipts.push(outcomeReceipt.receipt);

  return result({
    outcome: 'succeeded',
    assessment,
    reason: null,
    mode,
    old_head_sha: assessment.bound_head_sha,
    new_head_sha: newHeadSha,
    new_tree_sha: mutation.new_tree_sha,
    conflict_class: null,
    receipts,
  });
}
