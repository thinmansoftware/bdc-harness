/**
 * M-42 Slice 6 -- lifecycle salvage/reopen actions.
 *
 * Preserves duplicate or superseded work through exact, salvage-backed fake
 * lifecycle actions with an evidence-bound reopen path. This module contains no
 * provider client, Git package, shell-out, or DB call. Salvage checks, policy
 * decisions, live observations, mutation, and M-31 gate/receipt operations are
 * injected seams so Slice 8 can wire real boundaries later while this slice
 * remains disabled and testable.
 */

import { createHash } from 'node:crypto';
import {
  canonicalJsonV2,
  type M31ActionKind,
  type M31ActionPermitV2,
  type M31ActionTargetV2,
  type M31ExecutionReceiptEventV2,
  type M31TargetV2TypedFailure,
} from '@archon/core/db/m31-target-v2';
import type { OverseerCapability } from '@archon/core/db/overseer-capabilities';
import type { LifecycleMutationAdapterV1, LifecycleMutationRequestV1 } from '../adapters/lifecycle';

export type LifecycleActionKindV1 = Extract<
  M31ActionKind,
  'CLOSE' | 'REOPEN' | 'COMMENT' | 'LABEL' | 'ASSIGN'
>;
export type LifecycleTargetKindV1 = Extract<
  M31ActionTargetV2['target_kind'],
  'issue' | 'work_order' | 'pull_request'
>;

/** Common append-only salvage receipt shape (audit Section 7.4). */
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

/**
 * Structural policy dependency defined by audit Section 7.3. The action module
 * consumes its decision and never imports the Slice 7 registry. COMMENT
 * content, LABEL transitions, and ASSIGN actors are bound by the injected
 * action_parameters_digest; this module invents no allowlist.
 */
export interface InjectedActionPolicyRequestV1 {
  readonly schema_version: 'overseer-injected-action-policy-request-v1';
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly repository: string;
  readonly target_kind: LifecycleTargetKindV1;
  readonly target_key: string;
  readonly target_digest: string;
  readonly action_kind: LifecycleActionKindV1;
  readonly capability: 'lifecycle';
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

export interface LifecycleTargetBindingV1 {
  readonly repository: string;
  readonly target_kind: LifecycleTargetKindV1;
  readonly target_key: string;
  readonly target_digest: string;
  readonly snapshot_id: string;
  readonly target: M31ActionTargetV2;
}

export interface LifecycleVerifierEvidenceV1 {
  readonly verifier_identity: string;
  readonly verifier_provider: string;
  readonly verifier_model_family: string;
  readonly operator_identity: string;
  readonly operator_provider: string;
  readonly operator_model_family: string;
  readonly verdict: 'APPROVE' | 'REJECT';
  readonly reviewed_target_digest: string;
  readonly reviewed_action_kind: LifecycleActionKindV1;
  readonly raw_dissent_recorded: boolean;
}

export interface LifecycleFusionEvidenceV1 {
  readonly required: boolean;
  readonly present: boolean;
  readonly receipt_digest: string | null;
}

export interface LifecycleLineageEvidenceV1 {
  readonly kind: 'duplicate' | 'superseded';
  readonly predecessor_target_key: string;
  readonly successor_target_key: string;
  readonly predecessor_digest: string;
  readonly successor_digest: string;
  readonly exact_match: boolean;
  readonly uncertain: boolean;
}

export interface LifecycleReopenEvidenceV1 {
  readonly close_proposal_id: string;
  readonly close_execution_id: string;
  readonly false_observation_digest: string;
  readonly proven_false: boolean;
  readonly protected_boundary_clear: boolean;
}

export type LifecycleProtectedBoundaryV1 = 'production' | 'governance' | 'customer';

export interface LifecycleCandidateInputV1 {
  readonly lifecycle_gate_enabled: boolean;
  readonly evidence_complete: boolean;
  readonly target: LifecycleTargetBindingV1;
  readonly action_kind: LifecycleActionKindV1 | 'READ_ONLY';
  readonly action_parameters_digest: string | null;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly salvage_receipt: OverseerSalvageReceiptV1 | null;
  readonly lineage: LifecycleLineageEvidenceV1 | null;
  readonly reopen_evidence: LifecycleReopenEvidenceV1 | null;
  readonly verifier: LifecycleVerifierEvidenceV1 | null;
  readonly fusion: LifecycleFusionEvidenceV1 | null;
  readonly protected_boundaries: readonly LifecycleProtectedBoundaryV1[];
  readonly customer_contact: boolean;
  readonly governance_filing: boolean;
  readonly resulting_deployment_effect: InjectedActionPolicyRequestV1['resulting_deployment_effect'];
  readonly credential_principal: string;
}

export type LifecycleAssessmentResultV1 =
  | {
      readonly disposition: 'read_only';
      readonly reason: string;
      readonly no_mutation: true;
    }
  | {
      readonly disposition: 'denied';
      readonly reason: string;
      readonly no_mutation: true;
    }
  | {
      readonly disposition: 'eligible';
      readonly action_kind: LifecycleActionKindV1;
      readonly target: LifecycleTargetBindingV1;
      readonly action_parameters_digest: string;
      readonly policy_digest: string;
      readonly verifier_registry_digest: string;
      readonly resulting_deployment_effect: InjectedActionPolicyRequestV1['resulting_deployment_effect'];
      readonly credential_principal: string;
      readonly lineage: LifecycleLineageEvidenceV1 | null;
      readonly salvage_receipt: OverseerSalvageReceiptV1 | null;
      readonly reopen_recipe: ReopenRecipeV1 | null;
      readonly no_mutation: false;
    };

function isLifecycleAction(
  action: LifecycleCandidateInputV1['action_kind']
): action is LifecycleActionKindV1 {
  return action !== 'READ_ONLY';
}

function verifierIndependent(input: LifecycleCandidateInputV1): boolean {
  const verifier = input.verifier;
  if (!verifier) return false;
  return (
    verifier.verdict === 'APPROVE' &&
    verifier.raw_dissent_recorded &&
    verifier.reviewed_target_digest === input.target.target_digest &&
    verifier.reviewed_action_kind === input.action_kind &&
    verifier.verifier_identity !== verifier.operator_identity &&
    verifier.verifier_provider !== verifier.operator_provider &&
    verifier.verifier_model_family !== verifier.operator_model_family
  );
}

function fusionSatisfied(input: LifecycleCandidateInputV1): boolean {
  const fusion = input.fusion;
  return !!fusion?.required && fusion.present && !!fusion.receipt_digest;
}

function exactLineage(input: LifecycleCandidateInputV1): boolean {
  const lineage = input.lineage;
  return !!lineage && lineage.exact_match && !lineage.uncertain;
}

function protectedBoundaryClear(input: LifecycleCandidateInputV1): boolean {
  return (
    input.protected_boundaries.length === 0 && !input.customer_contact && !input.governance_filing
  );
}

/**
 * Pure lifecycle eligibility reduction. It reaches no gate, policy evaluator,
 * or adapter. Policy evaluation is deferred until a real permit supplies the
 * proposal and execution identities required by Section 7.3.
 */
export function assessLifecycleCandidate(
  input: LifecycleCandidateInputV1
): LifecycleAssessmentResultV1 {
  if (!input.lifecycle_gate_enabled || input.action_kind === 'READ_ONLY') {
    return { disposition: 'read_only', reason: 'lifecycle_gate_disabled', no_mutation: true };
  }
  if (!input.evidence_complete) {
    return { disposition: 'read_only', reason: 'incomplete_evidence', no_mutation: true };
  }
  if (!isLifecycleAction(input.action_kind)) {
    return { disposition: 'read_only', reason: 'read_only', no_mutation: true };
  }
  if (!input.action_parameters_digest) {
    return { disposition: 'denied', reason: 'missing_action_parameters_digest', no_mutation: true };
  }
  if (!HEX_64.test(input.action_parameters_digest) || !HEX_64.test(input.target.target_digest)) {
    return { disposition: 'denied', reason: 'invalid_action_digest', no_mutation: true };
  }
  if (
    !HEX_64.test(input.policy_digest) ||
    /^0{64}$/.test(input.policy_digest) ||
    !HEX_64.test(input.verifier_registry_digest)
  ) {
    return { disposition: 'denied', reason: 'invalid_policy_digest', no_mutation: true };
  }
  if (
    input.resulting_deployment_effect !== 'none' &&
    input.resulting_deployment_effect !== 'staging'
  ) {
    return { disposition: 'denied', reason: 'protected_deployment_effect', no_mutation: true };
  }
  if (!input.credential_principal.trim()) {
    return { disposition: 'denied', reason: 'missing_credential_principal', no_mutation: true };
  }
  if (!verifierIndependent(input)) {
    return { disposition: 'denied', reason: 'verifier_floor_failed', no_mutation: true };
  }
  if (!protectedBoundaryClear(input)) {
    return { disposition: 'denied', reason: 'protected_boundary', no_mutation: true };
  }

  if (input.action_kind === 'CLOSE') {
    if (!exactLineage(input)) {
      return { disposition: 'denied', reason: 'exact_lineage_required', no_mutation: true };
    }
    if (!input.salvage_receipt) {
      return { disposition: 'denied', reason: 'salvage_required', no_mutation: true };
    }
    if (!fusionSatisfied(input)) {
      return { disposition: 'denied', reason: 'fusion_required', no_mutation: true };
    }
  }

  if (input.action_kind === 'REOPEN') {
    if (!input.reopen_evidence?.proven_false || !input.reopen_evidence.protected_boundary_clear) {
      return { disposition: 'denied', reason: 'reopen_evidence_required', no_mutation: true };
    }
    if (!fusionSatisfied(input)) {
      return { disposition: 'denied', reason: 'fusion_required', no_mutation: true };
    }
  }

  return {
    disposition: 'eligible',
    action_kind: input.action_kind,
    target: input.target,
    action_parameters_digest: input.action_parameters_digest,
    policy_digest: input.policy_digest,
    verifier_registry_digest: input.verifier_registry_digest,
    resulting_deployment_effect: input.resulting_deployment_effect,
    credential_principal: input.credential_principal,
    lineage: input.lineage,
    salvage_receipt: input.salvage_receipt,
    reopen_recipe: null,
    no_mutation: false,
  };
}

export interface SalvageArtifactDepsV1 {
  artifactExists(input: {
    readonly worktree_path: string;
    readonly artifact_kind: OverseerSalvageReceiptV1['artifact_kind'];
    readonly git_object_id: string | null;
    readonly patch_path: string | null;
  }): Promise<boolean>;
  digestPatch(input: {
    readonly worktree_path: string;
    readonly patch_path: string;
  }): Promise<string | null>;
}

export type SalvageVerificationResultV1 =
  | { readonly ok: true; readonly receipt: OverseerSalvageReceiptV1 }
  | { readonly ok: false; readonly reason: string };

const HEX_40_OR_64 = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export async function verifySalvageArtifact(
  receipt: OverseerSalvageReceiptV1 | null,
  deps: SalvageArtifactDepsV1
): Promise<SalvageVerificationResultV1> {
  if (!receipt) return { ok: false, reason: 'salvage_missing' };
  if (receipt.schema_version !== 'overseer-salvage-receipt-v1') {
    return { ok: false, reason: 'salvage_schema_mismatch' };
  }
  if (receipt.artifact_kind === 'git_object') {
    if (!receipt.git_object_id || !HEX_40_OR_64.test(receipt.git_object_id)) {
      return { ok: false, reason: 'git_object_invalid' };
    }
    const exists = await deps.artifactExists({
      worktree_path: receipt.worktree_path,
      artifact_kind: receipt.artifact_kind,
      git_object_id: receipt.git_object_id,
      patch_path: null,
    });
    return exists ? { ok: true, receipt } : { ok: false, reason: 'git_object_missing' };
  }
  if (!receipt.patch_path || !receipt.patch_sha256 || !HEX_64.test(receipt.patch_sha256)) {
    return { ok: false, reason: 'patch_receipt_invalid' };
  }
  const exists = await deps.artifactExists({
    worktree_path: receipt.worktree_path,
    artifact_kind: receipt.artifact_kind,
    git_object_id: null,
    patch_path: receipt.patch_path,
  });
  if (!exists) return { ok: false, reason: 'patch_missing' };
  const digest = await deps.digestPatch({
    worktree_path: receipt.worktree_path,
    patch_path: receipt.patch_path,
  });
  if (digest !== receipt.patch_sha256) return { ok: false, reason: 'patch_digest_mismatch' };
  return { ok: true, receipt };
}

export interface BuildReopenRecipeInputV1 {
  readonly target: LifecycleTargetBindingV1;
  readonly close_proposal_id: string;
  readonly close_execution_id: string;
  readonly required_observation_digest: string;
  readonly action_parameters_digest: string;
}

export interface ReopenRecipeV1 {
  readonly schema_version: 'overseer-lifecycle-reopen-recipe-v1';
  readonly target: LifecycleTargetBindingV1;
  readonly prior_proposal_id: string;
  readonly prior_execution_id: string;
  readonly required_observation_digest: string;
  readonly inverse_provider_action: 'REOPEN';
  readonly action_parameters_digest: string;
}

export function buildReopenRecipe(input: BuildReopenRecipeInputV1): ReopenRecipeV1 {
  return {
    schema_version: 'overseer-lifecycle-reopen-recipe-v1',
    target: input.target,
    prior_proposal_id: input.close_proposal_id,
    prior_execution_id: input.close_execution_id,
    required_observation_digest: input.required_observation_digest,
    inverse_provider_action: 'REOPEN',
    action_parameters_digest: input.action_parameters_digest,
  };
}

export type ReceiptResultV1 =
  | { readonly ok: true; readonly receipt: M31ExecutionReceiptEventV2 }
  | { readonly ok: false; readonly failure: M31TargetV2TypedFailure };

export type PreparePermitResultV1 =
  | {
      readonly ok: true;
      readonly permit: M31ActionPermitV2;
      readonly receipt: M31ExecutionReceiptEventV2;
    }
  | { readonly ok: false; readonly denied: string };

export interface AuthorizeLifecycleRequestV1 {
  readonly requested_capability: OverseerCapability;
  readonly permit: M31ActionPermitV2;
  readonly actor: string;
  readonly correlation_id: string;
}

export type AuthorizeLifecycleResultV1 =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface LifecycleGateDepsV1 {
  preparePermit(input: { readonly proposal_id: string }): Promise<PreparePermitResultV1>;
  authorizeLifecycleAction(input: AuthorizeLifecycleRequestV1): Promise<AuthorizeLifecycleResultV1>;
  reserveEffect(input: {
    readonly permit: M31ActionPermitV2;
    readonly adapter_name: string;
    readonly provider_operation: LifecycleActionKindV1;
    readonly reason: string;
    readonly evidence: unknown;
  }): Promise<ReceiptResultV1>;
  recordOutcome(input: {
    readonly execution_id: string;
    readonly outcome: 'effect_succeeded' | 'effect_failed' | 'effect_indeterminate';
    readonly reason: string;
    readonly evidence: unknown;
    readonly external_effect_reference?: string | null;
  }): Promise<ReceiptResultV1>;
}

export interface LifecycleLiveObservationV1 {
  readonly target_digest: string;
  readonly state: string;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
}

export interface ExecuteLifecycleActionInputV1 {
  readonly candidate: LifecycleCandidateInputV1;
  readonly proposal_id: string;
  readonly actor: string;
  readonly correlation_id: string;
}

export interface ExecuteLifecycleActionDepsV1 {
  readonly policy: InjectedActionPolicyDepsV1;
  readonly salvage: SalvageArtifactDepsV1;
  readonly observeLiveTarget: (
    target: LifecycleTargetBindingV1
  ) => Promise<LifecycleLiveObservationV1>;
  readonly gate: LifecycleGateDepsV1;
  readonly adapter: LifecycleMutationAdapterV1;
}

export type ExecuteLifecycleOutcomeV1 =
  | 'read_only'
  | 'denied'
  | 'reserve_failed'
  | 'live_state_mismatch'
  | 'adapter_denied'
  | 'indeterminate'
  | 'outcome_record_failed'
  | 'succeeded';

export interface ExecuteLifecycleActionResultV1 {
  readonly outcome: ExecuteLifecycleOutcomeV1;
  readonly assessment: LifecycleAssessmentResultV1;
  readonly reason: string | null;
  readonly action_kind: LifecycleActionKindV1 | null;
  readonly receipt_types: readonly M31ExecutionReceiptEventV2['event_type'][];
  readonly receipts: readonly M31ExecutionReceiptEventV2[];
  readonly external_effect_reference: string | null;
}

const LIFECYCLE_CAPABILITY = 'lifecycle' as const satisfies OverseerCapability;
const NONZERO_HEX_64 = /^(?!0{64}$)[0-9a-f]{64}$/;

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJsonV2(value)).digest('hex');
}

function expectedPermitCapability(actionKind: LifecycleActionKindV1): string {
  return `overseer.m31.${actionKind.toLowerCase()}`;
}

function permitBindingFailure(
  input: ExecuteLifecycleActionInputV1,
  assessment: Extract<LifecycleAssessmentResultV1, { readonly disposition: 'eligible' }>,
  permit: M31ActionPermitV2,
  permitReceipt: M31ExecutionReceiptEventV2
): string | null {
  if (permit.proposal_id !== input.proposal_id) return 'permit_proposal_mismatch';
  if (!permit.execution_id) return 'permit_execution_missing';
  if (permit.action_kind !== assessment.action_kind) return 'permit_action_mismatch';
  if (permit.capability !== expectedPermitCapability(assessment.action_kind)) {
    return 'permit_capability_mismatch';
  }
  if (permit.repository !== assessment.target.repository) return 'permit_repository_mismatch';
  if (
    permit.target.target_kind !== assessment.target.target_kind ||
    canonicalJsonV2(permit.target) !== canonicalJsonV2(assessment.target.target)
  ) {
    return 'permit_target_mismatch';
  }
  if (permit.target_key !== assessment.target.target_key) return 'permit_target_key_mismatch';
  if (permit.target_digest !== assessment.target.target_digest)
    return 'permit_target_digest_mismatch';
  if (permit.snapshot_id !== assessment.target.snapshot_id) return 'permit_snapshot_mismatch';
  if (
    permitReceipt.receipt_event_id !== permit.permit_id ||
    permitReceipt.event_type !== 'permit_issued' ||
    permitReceipt.event_sequence !== 1 ||
    permitReceipt.previous_event_digest !== null ||
    permitReceipt.proposal_id !== permit.proposal_id ||
    permitReceipt.execution_id !== permit.execution_id ||
    permitReceipt.target_kind !== permit.target.target_kind ||
    permitReceipt.target_key !== permit.target_key ||
    permitReceipt.target_digest !== permit.target_digest ||
    !receiptDigestValid(permitReceipt)
  ) {
    return 'permit_receipt_mismatch';
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function policyDecisionFailure(
  value: unknown,
  expectedRequestDigest: string,
  expectedPolicyDigest: string
): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  if (
    !isRecord(value) ||
    value.schema_version !== 'overseer-injected-action-policy-decision-v1' ||
    typeof value.request_digest !== 'string' ||
    value.request_digest !== expectedRequestDigest ||
    !HEX_64.test(value.request_digest) ||
    typeof value.policy_digest !== 'string' ||
    !NONZERO_HEX_64.test(value.policy_digest) ||
    value.policy_digest !== expectedPolicyDigest ||
    typeof value.allowed !== 'boolean'
  ) {
    return { allowed: false, reason: 'policy_decision_invalid' };
  }
  if (value.allowed) {
    return value.denial_reason === null
      ? { allowed: true }
      : { allowed: false, reason: 'policy_decision_invalid' };
  }
  return typeof value.denial_reason === 'string' && value.denial_reason.trim()
    ? { allowed: false, reason: `policy_denied:${value.denial_reason}` }
    : { allowed: false, reason: 'policy_decision_invalid' };
}

function receiptBindingValid(
  receipt: unknown,
  permit: M31ActionPermitV2,
  eventType: M31ExecutionReceiptEventV2['event_type'],
  eventSequence: number,
  previousEventDigest: string
): boolean {
  return (
    isRecord(receipt) &&
    receipt.event_type === eventType &&
    receipt.event_sequence === eventSequence &&
    receipt.previous_event_digest === previousEventDigest &&
    receipt.proposal_id === permit.proposal_id &&
    receipt.execution_id === permit.execution_id &&
    receipt.target_kind === permit.target.target_kind &&
    receipt.target_key === permit.target_key &&
    receipt.target_digest === permit.target_digest &&
    receiptDigestValid(receipt)
  );
}

function receiptDigestValid(receipt: unknown): boolean {
  if (!isRecord(receipt) || typeof receipt.event_digest !== 'string') return false;
  const { event_digest: eventDigest, ...event } = receipt;
  return HEX_64.test(eventDigest) && sha256Canonical(event) === eventDigest;
}

function unboundTerminalReceiptValid(
  receipt: unknown,
  permit: M31ActionPermitV2
): receipt is M31ExecutionReceiptEventV2 {
  return (
    receiptBindingValid(
      receipt,
      permit,
      'effect_indeterminate',
      3,
      isRecord(receipt) && typeof receipt.previous_event_digest === 'string'
        ? receipt.previous_event_digest
        : ''
    ) &&
    isRecord(receipt) &&
    typeof receipt.previous_event_digest === 'string' &&
    HEX_64.test(receipt.previous_event_digest)
  );
}

function mutationReceiptValid(
  mutation: unknown,
  request: LifecycleMutationRequestV1
): mutation is LifecycleMutationRequestV1 & {
  readonly adapter: 'fake-lifecycle';
  readonly accepted: boolean;
  readonly reason: string;
  readonly mutation_sent: false;
  readonly external_effect_reference: string | null;
} {
  if (!isRecord(mutation)) return false;
  for (const key of Object.keys(request) as (keyof LifecycleMutationRequestV1)[]) {
    if (mutation[key] !== request[key]) return false;
  }
  if (
    mutation.adapter !== 'fake-lifecycle' ||
    typeof mutation.accepted !== 'boolean' ||
    typeof mutation.reason !== 'string' ||
    mutation.mutation_sent !== false
  ) {
    return false;
  }
  if (mutation.accepted) {
    return (
      mutation.reason === 'fake_accepted' &&
      typeof mutation.external_effect_reference === 'string' &&
      mutation.external_effect_reference.length > 0
    );
  }
  return mutation.reason !== 'fake_accepted' && mutation.external_effect_reference === null;
}

function executionResult(
  partial: Omit<ExecuteLifecycleActionResultV1, 'receipt_types'>
): ExecuteLifecycleActionResultV1 {
  return { ...partial, receipt_types: partial.receipts.map(receipt => receipt.event_type) };
}

export async function executeLifecycleAction(
  input: ExecuteLifecycleActionInputV1,
  deps: ExecuteLifecycleActionDepsV1
): Promise<ExecuteLifecycleActionResultV1> {
  const assessment = assessLifecycleCandidate(input.candidate);
  const emptyReceipts: readonly M31ExecutionReceiptEventV2[] = [];
  if (assessment.disposition !== 'eligible') {
    return executionResult({
      outcome: assessment.disposition === 'read_only' ? 'read_only' : 'denied',
      assessment,
      reason: assessment.reason,
      action_kind: null,
      receipts: emptyReceipts,
      external_effect_reference: null,
    });
  }

  const salvageResult =
    assessment.action_kind === 'CLOSE'
      ? await verifySalvageArtifact(assessment.salvage_receipt, deps.salvage)
      : { ok: true as const, receipt: assessment.salvage_receipt };
  if (!salvageResult.ok) {
    return executionResult({
      outcome: 'denied',
      assessment,
      reason: salvageResult.reason,
      action_kind: assessment.action_kind,
      receipts: emptyReceipts,
      external_effect_reference: null,
    });
  }

  const receipts: M31ExecutionReceiptEventV2[] = [];
  const permitResult = await deps.gate.preparePermit({ proposal_id: input.proposal_id });
  if (!permitResult.ok) {
    return executionResult({
      outcome: 'denied',
      assessment,
      reason: permitResult.denied,
      action_kind: assessment.action_kind,
      receipts,
      external_effect_reference: null,
    });
  }
  receipts.push(permitResult.receipt);
  const permit = permitResult.permit;
  const permitFailure = permitBindingFailure(input, assessment, permit, permitResult.receipt);
  if (permitFailure) {
    return executionResult({
      outcome: 'denied',
      assessment,
      reason: permitFailure,
      action_kind: assessment.action_kind,
      receipts: [],
      external_effect_reference: null,
    });
  }

  const policyRequest: InjectedActionPolicyRequestV1 = {
    schema_version: 'overseer-injected-action-policy-request-v1',
    proposal_id: permit.proposal_id,
    execution_id: permit.execution_id,
    repository: permit.repository,
    target_kind: assessment.target.target_kind,
    target_key: permit.target_key,
    target_digest: permit.target_digest,
    action_kind: assessment.action_kind,
    capability: LIFECYCLE_CAPABILITY,
    action_parameters_digest: assessment.action_parameters_digest,
    resulting_deployment_effect: assessment.resulting_deployment_effect,
    credential_principal: assessment.credential_principal,
  };
  const requestDigest = sha256Canonical(policyRequest);
  let policyDecision: unknown;
  try {
    policyDecision = await deps.policy.evaluateActionPolicy(policyRequest);
  } catch {
    return executionResult({
      outcome: 'denied',
      assessment,
      reason: 'policy_decision_unavailable',
      action_kind: assessment.action_kind,
      receipts,
      external_effect_reference: null,
    });
  }
  const policyResult = policyDecisionFailure(
    policyDecision,
    requestDigest,
    assessment.policy_digest
  );
  if (!policyResult.allowed) {
    return executionResult({
      outcome: 'denied',
      assessment,
      reason: policyResult.reason,
      action_kind: assessment.action_kind,
      receipts,
      external_effect_reference: null,
    });
  }
  const reopenRecipe =
    assessment.action_kind === 'CLOSE'
      ? buildReopenRecipe({
          target: assessment.target,
          close_proposal_id: permit.proposal_id,
          close_execution_id: permit.execution_id,
          required_observation_digest: assessment.target.target_digest,
          action_parameters_digest: assessment.action_parameters_digest,
        })
      : assessment.reopen_recipe;

  const authorization = await deps.gate.authorizeLifecycleAction({
    requested_capability: LIFECYCLE_CAPABILITY,
    permit,
    actor: input.actor,
    correlation_id: input.correlation_id,
  });
  if (!authorization.allowed) {
    return executionResult({
      outcome: 'denied',
      assessment,
      reason: authorization.reason,
      action_kind: assessment.action_kind,
      receipts,
      external_effect_reference: null,
    });
  }

  const recordReservationUncertainty = async (
    reason: string,
    evidence: unknown
  ): Promise<ExecuteLifecycleActionResultV1> => {
    let recorded: unknown;
    try {
      recorded = await deps.gate.recordOutcome({
        execution_id: permit.execution_id,
        outcome: 'effect_indeterminate',
        reason,
        evidence,
      });
    } catch {
      recorded = null;
    }
    if (
      !isRecord(recorded) ||
      recorded.ok !== true ||
      !unboundTerminalReceiptValid(recorded.receipt, permit)
    ) {
      return executionResult({
        outcome: 'outcome_record_failed',
        assessment,
        reason: `${reason};outcome_record_failed`,
        action_kind: assessment.action_kind,
        receipts,
        external_effect_reference: null,
      });
    }
    receipts.push(recorded.receipt);
    return executionResult({
      outcome: 'indeterminate',
      assessment,
      reason,
      action_kind: assessment.action_kind,
      receipts,
      external_effect_reference: null,
    });
  };

  let reservation: unknown;
  try {
    reservation = await deps.gate.reserveEffect({
      permit,
      adapter_name: 'fake-lifecycle',
      provider_operation: assessment.action_kind,
      reason: `lifecycle_${assessment.action_kind.toLowerCase()}`,
      evidence: {
        target_key: assessment.target.target_key,
        target_digest: assessment.target.target_digest,
        action_parameters_digest: assessment.action_parameters_digest,
        salvage_receipt: assessment.salvage_receipt,
        lineage: assessment.lineage,
        reopen_recipe: reopenRecipe,
      },
    });
  } catch {
    return recordReservationUncertainty('reservation_exception', {
      proposal_id: permit.proposal_id,
      execution_id: permit.execution_id,
    });
  }
  if (!isRecord(reservation) || typeof reservation.ok !== 'boolean') {
    return recordReservationUncertainty('reservation_response_invalid', reservation);
  }
  if (!reservation.ok) {
    return executionResult({
      outcome: 'reserve_failed',
      assessment,
      reason: typeof reservation.failure === 'string' ? reservation.failure : 'reserve_failed',
      action_kind: assessment.action_kind,
      receipts,
      external_effect_reference: null,
    });
  }
  if (!isRecord(reservation.receipt)) {
    return recordReservationUncertainty('reservation_receipt_missing', reservation);
  }
  const reservationReceipt = reservation.receipt as unknown as M31ExecutionReceiptEventV2;
  receipts.push(reservationReceipt);

  const recordTerminalOutcome = async (
    request: Parameters<LifecycleGateDepsV1['recordOutcome']>[0]
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> => {
    let receiptResult: unknown;
    try {
      receiptResult = await deps.gate.recordOutcome(request);
    } catch {
      return { ok: false, reason: 'outcome_record_exception' };
    }
    if (!isRecord(receiptResult) || typeof receiptResult.ok !== 'boolean') {
      return { ok: false, reason: 'outcome_record_invalid' };
    }
    if (!receiptResult.ok) {
      const failure = typeof receiptResult.failure === 'string' ? receiptResult.failure : 'unknown';
      return {
        ok: false,
        reason: `outcome_record_failed:${failure}`,
      };
    }
    if (
      !receiptBindingValid(
        receiptResult.receipt,
        permit,
        request.outcome,
        3,
        reservationReceipt.event_digest
      )
    ) {
      return { ok: false, reason: 'outcome_receipt_invalid' };
    }
    receipts.push(receiptResult.receipt as M31ExecutionReceiptEventV2);
    return { ok: true };
  };

  const finishTerminal = async (
    terminalOutcome: 'effect_failed' | 'effect_indeterminate',
    resultOutcome: ExecuteLifecycleOutcomeV1,
    reason: string,
    evidence: unknown
  ): Promise<ExecuteLifecycleActionResultV1> => {
    const recorded = await recordTerminalOutcome({
      execution_id: permit.execution_id,
      outcome: terminalOutcome,
      reason,
      evidence,
    });
    if (!recorded.ok) {
      return executionResult({
        outcome: 'outcome_record_failed',
        assessment,
        reason: `${reason};${recorded.reason}`,
        action_kind: assessment.action_kind,
        receipts,
        external_effect_reference: null,
      });
    }
    return executionResult({
      outcome: resultOutcome,
      assessment,
      reason,
      action_kind: assessment.action_kind,
      receipts,
      external_effect_reference: null,
    });
  };

  if (
    !receiptBindingValid(
      reservationReceipt,
      permit,
      'effect_reserved',
      2,
      permitResult.receipt.event_digest
    ) ||
    reservationReceipt.adapter_name !== 'fake-lifecycle' ||
    reservationReceipt.provider_operation !== assessment.action_kind
  ) {
    return finishTerminal(
      'effect_indeterminate',
      'indeterminate',
      'reservation_receipt_invalid',
      reservationReceipt
    );
  }

  let live: LifecycleLiveObservationV1;
  try {
    live = await deps.observeLiveTarget(assessment.target);
  } catch {
    return finishTerminal('effect_indeterminate', 'indeterminate', 'live_observation_exception', {
      target_key: assessment.target.target_key,
    });
  }
  if (
    live.target_digest !== assessment.target.target_digest ||
    live.policy_digest !== assessment.policy_digest ||
    live.verifier_registry_digest !== assessment.verifier_registry_digest
  ) {
    return finishTerminal('effect_indeterminate', 'live_state_mismatch', 'live_state_mismatch', {
      observed_target_digest: live.target_digest,
      bound_target_digest: assessment.target.target_digest,
    });
  }

  const mutationRequest: LifecycleMutationRequestV1 = {
    permit_id: permit.permit_id,
    execution_id: permit.execution_id,
    repository: assessment.target.repository,
    target_kind: assessment.target.target_kind,
    target_key: assessment.target.target_key,
    target_digest: assessment.target.target_digest,
    action_kind: assessment.action_kind,
    action_parameters_digest: assessment.action_parameters_digest,
  };
  let mutation: Awaited<ReturnType<LifecycleMutationAdapterV1['perform']>>;
  try {
    mutation = await deps.adapter.perform(mutationRequest);
  } catch {
    return finishTerminal(
      'effect_indeterminate',
      'indeterminate',
      'adapter_exception',
      mutationRequest
    );
  }
  if (!mutationReceiptValid(mutation, mutationRequest)) {
    return finishTerminal(
      'effect_indeterminate',
      'indeterminate',
      'adapter_receipt_invalid',
      mutation
    );
  }
  if (!mutation.accepted) {
    return finishTerminal('effect_failed', 'adapter_denied', mutation.reason, mutation);
  }

  const outcomeReceipt = await recordTerminalOutcome({
    execution_id: permit.execution_id,
    outcome: 'effect_succeeded',
    reason: `lifecycle_${assessment.action_kind.toLowerCase()}`,
    evidence: mutation,
    external_effect_reference: mutation.external_effect_reference,
  });
  if (!outcomeReceipt.ok) {
    return executionResult({
      outcome: 'outcome_record_failed',
      assessment,
      reason: outcomeReceipt.reason,
      action_kind: assessment.action_kind,
      receipts,
      external_effect_reference: null,
    });
  }

  return executionResult({
    outcome: 'succeeded',
    assessment,
    reason: null,
    action_kind: assessment.action_kind,
    receipts,
    external_effect_reference: mutation.external_effect_reference,
  });
}
