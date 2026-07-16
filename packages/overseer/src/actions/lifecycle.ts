// Overseer lifecycle actions -- M-42 Slice 6.
//
// Salvage-backed, gated CLOSE / REOPEN / COMMENT / LABEL / ASSIGN for issue,
// Work Order, and pull-request targets. This module is pure orchestration over
// injected dependencies: it performs no direct Git, process, or network work
// and imports only erased (type-only) shapes from @archon/core. All real
// wiring (worktree verification, fake lifecycle effects, v2 persistence, the
// injected action-policy evaluator) is supplied by Slice 8; the lifecycle
// capability remains disabled and no real provider is contacted here.
//
// Contract fidelity:
//   - InjectedActionPolicy*V1 mirror Wave 2 audit Section 7.3 exactly.
//   - OverseerSalvageReceiptV1 mirrors Wave 2 audit Section 7.4 exactly.
//
// bdc-xo audit blob: 24b1498184bf3e4782194be68e40ab5533c203ae

import type { M31ActionPermitV2 } from '@archon/core/db/m31-target-v2';

const HEX64_RE = /^[0-9a-f]{64}$/;
const GIT_SHA1_RE = /^[0-9a-f]{40}$/;
const GIT_SHA256_RE = /^[0-9a-f]{64}$/;
const ZERO_DIGEST = '0'.repeat(64);

export const LIFECYCLE_ACTION_KINDS = ['CLOSE', 'REOPEN', 'COMMENT', 'LABEL', 'ASSIGN'] as const;
export type LifecycleActionKind = (typeof LIFECYCLE_ACTION_KINDS)[number];

export function isLifecycleActionKind(value: string): value is LifecycleActionKind {
  return (LIFECYCLE_ACTION_KINDS as readonly string[]).includes(value);
}

export type LifecycleTargetKind = 'issue' | 'work_order' | 'pull_request';

export interface LifecycleTargetRefV1 {
  readonly target_kind: LifecycleTargetKind;
  readonly repository: string;
  readonly target_key: string;
  readonly target_digest: string;
}

function nonEmpty(value: string): boolean {
  return value.length > 0;
}

// ---------------------------------------------------------------------------
// Injected action-policy decision contract (audit Section 7.3, exact).
// ---------------------------------------------------------------------------

export interface InjectedActionPolicyRequestV1 {
  readonly schema_version: 'overseer-injected-action-policy-request-v1';
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly repository: string;
  readonly target_kind: 'issue' | 'work_order' | 'pull_request';
  readonly target_key: string;
  readonly target_digest: string;
  readonly action_kind: 'REFRESH' | 'REBASE' | 'CLOSE' | 'REOPEN' | 'COMMENT' | 'LABEL' | 'ASSIGN';
  readonly capability: 'branch' | 'lifecycle';
  readonly action_parameters_digest: string;
  readonly resulting_deployment_effect: 'none' | 'staging' | 'production' | 'unknown';
  readonly credential_principal: string;
}

export interface InjectedActionPolicyDecisionV1 {
  readonly schema_version: 'overseer-injected-action-policy-decision-v1';
  readonly request_digest: string;
  readonly policy_digest: string;
  readonly allowed: boolean;
  readonly denial_reason: string | null;
}

export interface InjectedActionPolicyDepsV1 {
  evaluateActionPolicy(
    input: InjectedActionPolicyRequestV1
  ): Promise<InjectedActionPolicyDecisionV1>;
}

// ---------------------------------------------------------------------------
// Common salvage receipt contract (audit Section 7.4, exact).
// ---------------------------------------------------------------------------

export interface OverseerSalvageReceiptV1 {
  readonly schema_version: 'overseer-salvage-receipt-v1';
  readonly repository: string;
  readonly wo_id: string;
  readonly source_target_kind: 'workflow_run' | 'issue' | 'work_order' | 'pull_request';
  readonly source_target_key: string;
  readonly source_target_digest: string;
  readonly source_run_id: string | null;
  readonly worktree_path: string;
  readonly artifact_kind: 'git_object' | 'patch';
  readonly git_object_format: 'sha1' | 'sha256' | null;
  readonly git_object_id: string | null;
  readonly patch_path: string | null;
  readonly patch_sha256: string | null;
  readonly scope_digest: string;
  readonly captured_at: string;
  readonly verified_at: string;
}

// ---------------------------------------------------------------------------
// assessLifecycleCandidate -- pure exact-state classifier.
// ---------------------------------------------------------------------------

export type LifecycleDenialReason =
  | 'lifecycle_gate_disabled'
  | 'target_snapshot_missing'
  | 'target_state_stale'
  | 'age_only_rationale'
  | 'duplicate_not_proven'
  | 'salvage_unverified'
  | 'reopen_recipe_missing'
  | 'fusion_record_missing'
  | 'independent_verification_missing'
  | 'verifier_self_review'
  | 'prior_close_not_proven_false'
  | 'approved_content_missing'
  | 'label_transition_not_allowed'
  | 'actor_not_allowlisted'
  | 'policy_drift'
  | 'production_boundary'
  | 'governance_boundary'
  | 'customer_boundary';

export interface LifecycleAssessmentInput {
  readonly action_kind: LifecycleActionKind;
  readonly lifecycle_gate_enabled: boolean;
  readonly target_snapshot_present: boolean;
  readonly target_state_current: boolean;
  // CLOSE evidence.
  readonly duplicate_or_supersedence_proven: boolean;
  readonly age_only_rationale: boolean;
  readonly salvage_verified: boolean;
  readonly reopen_recipe_present: boolean;
  readonly fusion_record_present: boolean;
  readonly independent_verification_present: boolean;
  readonly verifier_correlated_with_operator: boolean;
  // REOPEN evidence.
  readonly prior_close_proposal_proven_false: boolean;
  // COMMENT / LABEL / ASSIGN evidence.
  readonly approved_content_digest_present: boolean;
  readonly allowed_label_transition: boolean;
  readonly allowlisted_actor: boolean;
  readonly policy_drift: boolean;
  // Protected boundaries (apply to every mutating action).
  readonly crosses_production_boundary: boolean;
  readonly crosses_governance_boundary: boolean;
  readonly crosses_customer_boundary: boolean;
}

export type LifecycleAssessment =
  | { readonly eligible: true; readonly action_kind: LifecycleActionKind }
  | {
      readonly eligible: false;
      readonly action_kind: LifecycleActionKind;
      readonly denial_reason: LifecycleDenialReason;
    };

function assessDeny(
  action_kind: LifecycleActionKind,
  denial_reason: LifecycleDenialReason
): LifecycleAssessment {
  return { eligible: false, action_kind, denial_reason };
}

export function assessLifecycleCandidate(input: LifecycleAssessmentInput): LifecycleAssessment {
  const kind = input.action_kind;

  if (!input.lifecycle_gate_enabled) return assessDeny(kind, 'lifecycle_gate_disabled');
  if (!input.target_snapshot_present) return assessDeny(kind, 'target_snapshot_missing');
  if (!input.target_state_current) return assessDeny(kind, 'target_state_stale');

  switch (kind) {
    case 'CLOSE': {
      if (input.age_only_rationale) return assessDeny(kind, 'age_only_rationale');
      if (!input.duplicate_or_supersedence_proven) return assessDeny(kind, 'duplicate_not_proven');
      if (!input.salvage_verified) return assessDeny(kind, 'salvage_unverified');
      if (!input.reopen_recipe_present) return assessDeny(kind, 'reopen_recipe_missing');
      if (!input.fusion_record_present) return assessDeny(kind, 'fusion_record_missing');
      if (!input.independent_verification_present) {
        return assessDeny(kind, 'independent_verification_missing');
      }
      if (input.verifier_correlated_with_operator) return assessDeny(kind, 'verifier_self_review');
      break;
    }
    case 'REOPEN': {
      if (!input.prior_close_proposal_proven_false) {
        return assessDeny(kind, 'prior_close_not_proven_false');
      }
      if (input.verifier_correlated_with_operator) return assessDeny(kind, 'verifier_self_review');
      break;
    }
    case 'COMMENT': {
      if (!input.approved_content_digest_present)
        return assessDeny(kind, 'approved_content_missing');
      break;
    }
    case 'LABEL': {
      if (!input.allowed_label_transition) return assessDeny(kind, 'label_transition_not_allowed');
      if (input.policy_drift) return assessDeny(kind, 'policy_drift');
      break;
    }
    case 'ASSIGN': {
      if (!input.allowlisted_actor) return assessDeny(kind, 'actor_not_allowlisted');
      break;
    }
  }

  if (input.crosses_production_boundary) return assessDeny(kind, 'production_boundary');
  if (input.crosses_governance_boundary) return assessDeny(kind, 'governance_boundary');
  if (input.crosses_customer_boundary) return assessDeny(kind, 'customer_boundary');

  return { eligible: true, action_kind: kind };
}

// ---------------------------------------------------------------------------
// verifySalvageArtifact -- proves a durable Git object or patch matches the
// audit Section 7.4 receipt before any close is permitted.
// ---------------------------------------------------------------------------

export type SalvageDenialReason =
  | 'schema_invalid'
  | 'field_shape_invalid'
  | 'timestamp_invalid'
  | 'git_object_missing'
  | 'patch_missing'
  | 'patch_hash_mismatch';

export type SalvageVerificationResult =
  | { readonly verified: true; readonly artifact_kind: 'git_object' | 'patch' }
  | { readonly verified: false; readonly reason: SalvageDenialReason };

export interface SalvageVerificationDeps {
  readonly gitObjectExists: (input: {
    readonly format: 'sha1' | 'sha256';
    readonly object_id: string;
  }) => Promise<boolean>;
  readonly readPatchSha256: (patch_path: string) => Promise<string | null>;
}

function salvageDeny(reason: SalvageDenialReason): SalvageVerificationResult {
  return { verified: false, reason };
}

export async function verifySalvageArtifact(
  receipt: OverseerSalvageReceiptV1,
  deps: SalvageVerificationDeps
): Promise<SalvageVerificationResult> {
  if (receipt.schema_version !== 'overseer-salvage-receipt-v1')
    return salvageDeny('schema_invalid');

  if (
    !nonEmpty(receipt.repository) ||
    !nonEmpty(receipt.wo_id) ||
    !nonEmpty(receipt.source_target_key) ||
    !HEX64_RE.test(receipt.source_target_digest) ||
    !nonEmpty(receipt.worktree_path) ||
    !HEX64_RE.test(receipt.scope_digest)
  ) {
    return salvageDeny('field_shape_invalid');
  }

  const captured = Date.parse(receipt.captured_at);
  const verified = Date.parse(receipt.verified_at);
  if (!Number.isFinite(captured) || !Number.isFinite(verified) || verified < captured) {
    return salvageDeny('timestamp_invalid');
  }

  if (receipt.artifact_kind === 'git_object') {
    if (receipt.patch_path !== null || receipt.patch_sha256 !== null) {
      return salvageDeny('field_shape_invalid');
    }
    if (receipt.git_object_format !== 'sha1' && receipt.git_object_format !== 'sha256') {
      return salvageDeny('field_shape_invalid');
    }
    const objectId = receipt.git_object_id;
    if (objectId === null) return salvageDeny('field_shape_invalid');
    const idRe = receipt.git_object_format === 'sha1' ? GIT_SHA1_RE : GIT_SHA256_RE;
    if (!idRe.test(objectId)) return salvageDeny('field_shape_invalid');
    const exists = await deps.gitObjectExists({
      format: receipt.git_object_format,
      object_id: objectId,
    });
    if (!exists) return salvageDeny('git_object_missing');
    return { verified: true, artifact_kind: 'git_object' };
  }

  if (receipt.artifact_kind === 'patch') {
    if (receipt.git_object_format !== null || receipt.git_object_id !== null) {
      return salvageDeny('field_shape_invalid');
    }
    if (receipt.patch_path === null || !nonEmpty(receipt.patch_path)) {
      return salvageDeny('field_shape_invalid');
    }
    if (receipt.patch_sha256 === null || !HEX64_RE.test(receipt.patch_sha256)) {
      return salvageDeny('field_shape_invalid');
    }
    const actual = await deps.readPatchSha256(receipt.patch_path);
    if (actual === null) return salvageDeny('patch_missing');
    if (actual !== receipt.patch_sha256) return salvageDeny('patch_hash_mismatch');
    return { verified: true, artifact_kind: 'patch' };
  }

  return salvageDeny('field_shape_invalid');
}

// ---------------------------------------------------------------------------
// buildReopenRecipe -- pure. Exact target, prior proposal, required
// observation, and the inverse provider action.
// ---------------------------------------------------------------------------

export interface ReopenRecipeInputV1 {
  readonly repository: string;
  readonly target: LifecycleTargetRefV1;
  readonly prior_close_proposal_id: string;
  readonly required_observation_digest: string;
}

export interface OverseerReopenRecipeV1 {
  readonly schema_version: 'overseer-reopen-recipe-v1';
  readonly repository: string;
  readonly target_kind: LifecycleTargetKind;
  readonly target_key: string;
  readonly target_digest: string;
  readonly prior_close_proposal_id: string;
  readonly required_observation_digest: string;
  readonly inverse_action_kind: 'REOPEN';
}

export function buildReopenRecipe(input: ReopenRecipeInputV1): OverseerReopenRecipeV1 {
  return {
    schema_version: 'overseer-reopen-recipe-v1',
    repository: input.repository,
    target_kind: input.target.target_kind,
    target_key: input.target.target_key,
    target_digest: input.target.target_digest,
    prior_close_proposal_id: input.prior_close_proposal_id,
    required_observation_digest: input.required_observation_digest,
    inverse_action_kind: 'REOPEN',
  };
}

export function isValidReopenRecipe(
  recipe: OverseerReopenRecipeV1 | null
): recipe is OverseerReopenRecipeV1 {
  return (
    recipe !== null &&
    recipe.schema_version === 'overseer-reopen-recipe-v1' &&
    nonEmpty(recipe.repository) &&
    nonEmpty(recipe.target_key) &&
    HEX64_RE.test(recipe.target_digest) &&
    nonEmpty(recipe.prior_close_proposal_id) &&
    HEX64_RE.test(recipe.required_observation_digest) &&
    recipe.inverse_action_kind === 'REOPEN'
  );
}

// ---------------------------------------------------------------------------
// Fake mutation adapter surface (implemented in adapters/lifecycle.ts).
// ---------------------------------------------------------------------------

export type LifecycleAdapterReason =
  | 'fake_accepted'
  | 'repository_not_allowlisted'
  | 'action_kind_unsupported'
  | 'action_identity_mismatch'
  | 'execution_replayed'
  | 'execution_check_failed'
  | 'attempt_audit_failed';

export interface LifecycleMutationRequest {
  readonly permit_id: string;
  readonly repository: string;
  readonly action_kind: LifecycleActionKind;
  readonly target_kind: LifecycleTargetKind;
  readonly target_key: string;
  readonly target_digest: string;
  readonly snapshot_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly action_parameters_digest: string;
}

export interface LifecycleMutationReceipt {
  readonly adapter: 'fake-lifecycle';
  readonly accepted: boolean;
  readonly reason: LifecycleAdapterReason;
  readonly audit_recorded: boolean;
  readonly mutation_sent: false;
  readonly permit_id: string;
  readonly repository: string;
  readonly action_kind: LifecycleActionKind;
  readonly target_key: string;
  readonly target_digest: string;
  readonly snapshot_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly action_parameters_digest: string;
}

export interface LifecycleAttemptEvent {
  readonly adapter: 'fake-lifecycle';
  readonly accepted: boolean;
  readonly reason: LifecycleAdapterReason;
  readonly permit_id: string;
  readonly repository: string;
  readonly action_kind: LifecycleActionKind;
  readonly target_key: string;
  readonly target_digest: string;
  readonly snapshot_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly action_parameters_digest: string;
  readonly mutation_sent: false;
}

export interface LifecycleMutationAdapter {
  attemptMutation(
    request: LifecycleMutationRequest,
    permit: M31ActionPermitV2
  ): Promise<LifecycleMutationReceipt>;
}

// ---------------------------------------------------------------------------
// Reconciliation surface (implemented in adapters/lifecycle.ts).
// ---------------------------------------------------------------------------

export interface LineageEvidenceV1 {
  readonly relation: 'predecessor' | 'successor';
  readonly target_key: string;
  readonly target_digest: string;
  readonly evidence_digest: string;
}

export interface NonGovernanceOperatorCardV1 {
  readonly kind: 'operator_card';
  readonly governance: false;
  readonly customer_visible: false;
  readonly action_kind: LifecycleActionKind;
  readonly summary: string;
}

export function buildNonGovernanceOperatorCard(
  action_kind: LifecycleActionKind,
  summary: string
): NonGovernanceOperatorCardV1 {
  return {
    kind: 'operator_card',
    governance: false,
    customer_visible: false,
    action_kind,
    summary,
  };
}

export interface ReconcileLifecycleInput {
  readonly repository: string;
  readonly snapshot_id: string;
  readonly retained_member_target_key: string;
  readonly result_receipt: LifecycleMutationReceipt;
  readonly predecessor_evidence: readonly LineageEvidenceV1[];
  readonly successor_evidence: readonly LineageEvidenceV1[];
  readonly card: NonGovernanceOperatorCardV1;
}

export interface ReconcileLifecycleResult {
  readonly membership_retained: true;
  readonly membership_collapsed: false;
  readonly snapshot_id: string;
  readonly retained_member_target_key: string;
  readonly lineage_appended: readonly LineageEvidenceV1[];
  readonly card_emitted: NonGovernanceOperatorCardV1;
}

// ---------------------------------------------------------------------------
// executeLifecycleAction -- common gated action. Fails closed at every gate
// before the fake adapter is reached.
// ---------------------------------------------------------------------------

export interface WorktreeVerificationRequestV1 {
  readonly worktree_path: string;
  readonly repository: string;
  readonly expected_branch: string;
}

export type WorktreeVerificationResultV1 =
  | { readonly owned: true }
  | { readonly owned: false; readonly reason: string };

export type LifecyclePermitResult =
  | { readonly ok: true; readonly permit: M31ActionPermitV2 }
  | { readonly ok: false; readonly reason: string };

export type LifecycleAuthorizationResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export type LifecycleReservationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type LifecycleOutcomeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type LifecycleStage =
  | 'assessment'
  | 'worktree'
  | 'salvage'
  | 'reopen_recipe'
  | 'policy'
  | 'permit'
  | 'authorization'
  | 'reservation'
  | 'adapter'
  | 'outcome'
  | 'reconciliation';

export interface LifecycleExecutionInput {
  readonly action_kind: LifecycleActionKind;
  readonly repository: string;
  readonly proposal_id: string;
  readonly correlation_id: string;
  readonly actor: string;
  readonly summary: string;
  readonly assessment: LifecycleAssessmentInput;
  readonly worktree: WorktreeVerificationRequestV1;
  readonly salvage_receipt: OverseerSalvageReceiptV1 | null;
  readonly reopen_recipe: OverseerReopenRecipeV1 | null;
  readonly policy_request: InjectedActionPolicyRequestV1;
  readonly expected_request_digest: string;
  readonly expected_action_parameters_digest: string;
  readonly mutation_request: LifecycleMutationRequest;
  readonly reconcile: ReconcileLifecycleInput;
}

export interface LifecycleExecutionDeps {
  readonly assess?: (input: LifecycleAssessmentInput) => LifecycleAssessment;
  readonly verifyWorktree: (
    request: WorktreeVerificationRequestV1
  ) => Promise<WorktreeVerificationResultV1>;
  readonly salvage: SalvageVerificationDeps;
  readonly policy: InjectedActionPolicyDepsV1;
  readonly preparePermit: (proposalId: string) => Promise<LifecyclePermitResult>;
  readonly authorize: (input: {
    readonly permit: M31ActionPermitV2;
    readonly actor: string;
    readonly correlation_id: string;
  }) => Promise<LifecycleAuthorizationResult>;
  readonly reserveEffect: (input: {
    readonly permit: M31ActionPermitV2;
  }) => Promise<LifecycleReservationResult>;
  readonly adapter: LifecycleMutationAdapter;
  readonly appendOutcome: (input: {
    readonly execution_id: string;
    readonly outcome: 'effect_succeeded';
  }) => Promise<LifecycleOutcomeResult>;
  readonly reconcile: (input: ReconcileLifecycleInput) => Promise<ReconcileLifecycleResult>;
}

export type LifecycleExecutionResult =
  | {
      readonly status: 'denied';
      readonly stage: LifecycleStage;
      readonly reason: string;
      readonly adapter_invoked: false;
      readonly operator_card: NonGovernanceOperatorCardV1;
    }
  | {
      readonly status: 'failed';
      readonly stage: LifecycleStage;
      readonly reason: string;
      readonly adapter_invoked: boolean;
      readonly operator_card: NonGovernanceOperatorCardV1;
    }
  | {
      readonly status: 'executed';
      readonly reason: 'fake_accepted';
      readonly adapter_invoked: true;
      readonly receipt: LifecycleMutationReceipt;
      readonly reconciliation: ReconcileLifecycleResult;
      readonly operator_card: NonGovernanceOperatorCardV1;
    };

function denied(
  stage: LifecycleStage,
  reason: string,
  card: NonGovernanceOperatorCardV1
): LifecycleExecutionResult {
  return { status: 'denied', stage, reason, adapter_invoked: false, operator_card: card };
}

function validateInjectedPolicyDecision(
  request: InjectedActionPolicyRequestV1,
  decision: InjectedActionPolicyDecisionV1,
  expectedRequestDigest: string,
  expectedActionParametersDigest: string
): string | null {
  if (request.schema_version !== 'overseer-injected-action-policy-request-v1') {
    return 'policy_request_schema_invalid';
  }
  if (request.action_parameters_digest !== expectedActionParametersDigest) {
    return 'action_parameters_unbound';
  }
  if (
    request.resulting_deployment_effect !== 'none' &&
    request.resulting_deployment_effect !== 'staging'
  ) {
    return 'protected_deployment_effect';
  }
  if (decision.schema_version !== 'overseer-injected-action-policy-decision-v1') {
    return 'policy_decision_schema_invalid';
  }
  if (!HEX64_RE.test(decision.request_digest)) return 'policy_request_digest_malformed';
  if (decision.request_digest !== expectedRequestDigest) return 'policy_decision_stale';
  if (!HEX64_RE.test(decision.policy_digest) || decision.policy_digest === ZERO_DIGEST) {
    return 'policy_digest_invalid';
  }
  if (!decision.allowed) return decision.denial_reason ?? 'policy_denied';
  if (decision.denial_reason !== null) return 'policy_decision_inconsistent';
  return null;
}

export async function executeLifecycleAction(
  input: LifecycleExecutionInput,
  deps: LifecycleExecutionDeps
): Promise<LifecycleExecutionResult> {
  const card = buildNonGovernanceOperatorCard(input.action_kind, input.summary);

  const assess = deps.assess ?? assessLifecycleCandidate;
  const assessment = assess(input.assessment);
  if (!assessment.eligible) return denied('assessment', assessment.denial_reason, card);

  const worktree = await deps.verifyWorktree(input.worktree);
  if (!worktree.owned) return denied('worktree', worktree.reason, card);

  if (input.action_kind === 'CLOSE') {
    if (input.salvage_receipt === null) return denied('salvage', 'salvage_receipt_missing', card);
    const salvage = await verifySalvageArtifact(input.salvage_receipt, deps.salvage);
    if (!salvage.verified) return denied('salvage', salvage.reason, card);
    if (!isValidReopenRecipe(input.reopen_recipe)) {
      return denied('reopen_recipe', 'reopen_recipe_invalid', card);
    }
  }

  if (input.action_kind === 'REOPEN') {
    if (!isValidReopenRecipe(input.reopen_recipe)) {
      return denied('reopen_recipe', 'reopen_recipe_invalid', card);
    }
  }

  const decision = await deps.policy.evaluateActionPolicy(input.policy_request);
  const policyReason = validateInjectedPolicyDecision(
    input.policy_request,
    decision,
    input.expected_request_digest,
    input.expected_action_parameters_digest
  );
  if (policyReason !== null) return denied('policy', policyReason, card);

  const permit = await deps.preparePermit(input.proposal_id);
  if (!permit.ok) return denied('permit', permit.reason, card);

  const authorization = await deps.authorize({
    permit: permit.permit,
    actor: input.actor,
    correlation_id: input.correlation_id,
  });
  if (!authorization.allowed) return denied('authorization', authorization.reason, card);

  const reservation = await deps.reserveEffect({ permit: permit.permit });
  if (!reservation.ok) return denied('reservation', reservation.reason, card);

  // First side-effecting call. Reached only after every gate above passed.
  const receipt = await deps.adapter.attemptMutation(input.mutation_request, permit.permit);
  if (!receipt.accepted) {
    return {
      status: 'failed',
      stage: 'adapter',
      reason: receipt.reason,
      adapter_invoked: true,
      operator_card: card,
    };
  }

  const outcome = await deps.appendOutcome({
    execution_id: input.mutation_request.execution_id,
    outcome: 'effect_succeeded',
  });
  if (!outcome.ok) {
    return {
      status: 'failed',
      stage: 'outcome',
      reason: outcome.reason,
      adapter_invoked: true,
      operator_card: card,
    };
  }

  const reconciliation = await deps.reconcile(input.reconcile);
  return {
    status: 'executed',
    reason: 'fake_accepted',
    adapter_invoked: true,
    receipt,
    reconciliation,
    operator_card: card,
  };
}
