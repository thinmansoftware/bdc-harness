import type { M31ActionPermitV2 } from '@archon/core/db/m31-target-v2';
import type { SandboxExecutionContextV1 } from './sandbox-types';

export interface CauldronRegisteredWorkloadV1 {
  readonly synthetic_wo_id: string;
  readonly workflow_name: string;
}

export interface CauldronAdmissionTargetV1 {
  readonly environment: 'staging' | 'production' | 'unknown';
  readonly archon: 'staging' | 'production' | 'unknown';
  readonly event_store: 'staging' | 'production' | 'unknown';
  readonly worktree: 'staging' | 'production' | 'unknown';
  readonly credential: 'staging' | 'production' | 'unknown';
}

export interface CauldronAdmissionBindingEvidenceV1 {
  readonly execution_id: string;
  readonly proposal_id: string;
  readonly permit_id: string;
  readonly repository: string;
  readonly provider_repository_id: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly candidate_digest: string;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly credential_principal: string;
  readonly original_target_key: string;
  readonly original_target_digest: string;
  readonly original_snapshot_id: string;
  readonly requested_wo_id: string;
  readonly workflow_name: string;
}

export interface CauldronAdmissionRequestV1 {
  readonly workflowName: string;
  readonly conversationId: string;
  readonly message: string;
  readonly inputs: CauldronAdmissionBindingEvidenceV1;
  readonly conductor?: {
    readonly enabled: true;
    readonly woId: string;
    readonly idempotencyKey: string;
    readonly project?: string;
    readonly dryRun?: boolean;
  };
}

export type CauldronAdmissionStatusV1 = 'admitted' | 'timeout' | 'indeterminate' | 'rejected';

export interface CauldronAdmissionResultV1 {
  readonly status: CauldronAdmissionStatusV1;
  readonly runId: string | null;
  readonly providerRequestId: string | null;
  readonly admittedAt: string | null;
  readonly bindingEvidence: CauldronAdmissionBindingEvidenceV1 | null;
  readonly reason: string;
}

export interface CauldronAdmissionDepsV1 {
  admitRun(request: CauldronAdmissionRequestV1): Promise<CauldronAdmissionResultV1>;
  getAdmissionByExecutionId(executionId: string): Promise<CauldronAdmissionResultV1 | null>;
}

export type CauldronRefireBridgeRefusalReasonV1 =
  | 'mode_not_sandbox'
  | 'authorization_not_carried'
  | 'repository_identity_mismatch'
  | 'protected_target'
  | 'state_binding_mismatch'
  | 'candidate_digest_mismatch'
  | 'policy_digest_mismatch'
  | 'registry_digest_mismatch'
  | 'principal_mismatch'
  | 'permit_context_mismatch'
  | 'non_staging_target'
  | 'unregistered_workload';

export type CauldronPreparedAdmissionV1 =
  | { readonly ok: true; readonly request: CauldronAdmissionRequestV1 }
  | { readonly ok: false; readonly reason: CauldronRefireBridgeRefusalReasonV1 };

export interface CauldronPrepareAdmissionInputV1 {
  readonly context: SandboxExecutionContextV1;
  readonly permit: M31ActionPermitV2;
  readonly target: CauldronAdmissionTargetV1;
  readonly registered_workload: CauldronRegisteredWorkloadV1;
  readonly requested_wo_id: string;
  readonly requested_workflow_name: string;
  readonly conversation_id: string;
  readonly message: string;
}

export interface CauldronRefireBridgeAdapter {
  prepareAdmission(input: CauldronPrepareAdmissionInputV1): CauldronPreparedAdmissionV1;
  admitRun(request: CauldronAdmissionRequestV1): Promise<CauldronAdmissionResultV1>;
  getAdmissionByExecutionId(executionId: string): Promise<CauldronAdmissionResultV1 | null>;
}

const PROTECTED_TARGETS = new Set([
  'release',
  'deployment',
  'governance',
  'customer_data',
  'billing',
  'credential',
  'production_effect',
]);

export function createCauldronRefireBridgeAdapter(
  deps: CauldronAdmissionDepsV1
): CauldronRefireBridgeAdapter {
  return {
    prepareAdmission,
    admitRun(request: CauldronAdmissionRequestV1): Promise<CauldronAdmissionResultV1> {
      return deps.admitRun(request);
    },
    getAdmissionByExecutionId(executionId: string): Promise<CauldronAdmissionResultV1 | null> {
      return deps.getAdmissionByExecutionId(executionId);
    },
  };
}

export function prepareAdmission(
  input: CauldronPrepareAdmissionInputV1
): CauldronPreparedAdmissionV1 {
  const context = input.context;
  if (context.mode !== 'sandbox') return { ok: false, reason: 'mode_not_sandbox' };
  if (!context.frozen_authorization_carried) {
    return { ok: false, reason: 'authorization_not_carried' };
  }
  if (!repositoryIdentityMatches(context)) {
    return { ok: false, reason: 'repository_identity_mismatch' };
  }
  if (
    context.target_classifications.some(classification => PROTECTED_TARGETS.has(classification))
  ) {
    return { ok: false, reason: 'protected_target' };
  }
  if (context.action_policy_registry_digest !== context.expected_action_policy_registry_digest) {
    return { ok: false, reason: 'registry_digest_mismatch' };
  }
  if (context.credential_principal !== context.expected_principal) {
    return { ok: false, reason: 'principal_mismatch' };
  }
  if (!liveStateMatches(context)) return { ok: false, reason: 'state_binding_mismatch' };
  if (context.observation.candidate_digest !== context.candidate_digest) {
    return { ok: false, reason: 'candidate_digest_mismatch' };
  }
  if (context.observation.policy_digest !== context.expected_policy_digest) {
    return { ok: false, reason: 'policy_digest_mismatch' };
  }
  if (!permitMatchesContext(context, input.permit)) {
    return { ok: false, reason: 'permit_context_mismatch' };
  }
  if (!isExplicitStagingTarget(input.target)) return { ok: false, reason: 'non_staging_target' };
  if (
    input.requested_wo_id !== input.registered_workload.synthetic_wo_id ||
    input.requested_workflow_name !== input.registered_workload.workflow_name
  ) {
    return { ok: false, reason: 'unregistered_workload' };
  }

  return {
    ok: true,
    request: {
      workflowName: input.requested_workflow_name,
      conversationId: input.conversation_id,
      message: input.message,
      inputs: bindingEvidence(input),
      conductor: {
        enabled: true,
        woId: input.requested_wo_id,
        idempotencyKey: context.proposal.execution_id,
      },
    },
  };
}

export function isExplicitStagingTarget(target: CauldronAdmissionTargetV1): boolean {
  return (
    target.environment === 'staging' &&
    target.archon === 'staging' &&
    target.event_store === 'staging' &&
    target.worktree === 'staging' &&
    target.credential === 'staging'
  );
}

function bindingEvidence(
  input: CauldronPrepareAdmissionInputV1
): CauldronAdmissionBindingEvidenceV1 {
  const context = input.context;
  return {
    execution_id: context.proposal.execution_id,
    proposal_id: context.proposal.proposal_id,
    permit_id: input.permit.permit_id,
    repository: context.repository.full_name,
    provider_repository_id: context.repository.provider_repository_id,
    base_sha: context.base_sha,
    head_sha: context.head_sha,
    candidate_digest: context.candidate_digest,
    policy_digest: context.expected_policy_digest,
    verifier_registry_digest: context.expected_verifier_registry_digest,
    credential_principal: context.credential_principal,
    original_target_key: context.proposal.target_key,
    original_target_digest: context.proposal.target_digest,
    original_snapshot_id: context.proposal.snapshot_id,
    requested_wo_id: input.requested_wo_id,
    workflow_name: input.requested_workflow_name,
  };
}

function repositoryIdentityMatches(context: SandboxExecutionContextV1): boolean {
  return (
    context.repository.full_name === context.expected_repository_full_name &&
    context.observation.repository_full_name === context.repository.full_name &&
    context.repository.provider_repository_id === context.expected_provider_repository_id &&
    context.observation.provider_repository_id === context.repository.provider_repository_id &&
    context.repository.full_name ===
      `${context.repository.owner}/${context.repository.repository}` &&
    context.proposal.repository === context.repository.full_name
  );
}

function liveStateMatches(context: SandboxExecutionContextV1): boolean {
  return (
    context.observation.pull_request_number === context.pull_request_number &&
    context.observation.base_branch === context.base_branch &&
    context.observation.base_sha === context.base_sha &&
    context.observation.head_sha === context.head_sha &&
    context.observation.verifier_registry_digest === context.expected_verifier_registry_digest
  );
}

function permitMatchesContext(
  context: SandboxExecutionContextV1,
  permit: M31ActionPermitV2
): boolean {
  return (
    permit.proposal_id === context.proposal.proposal_id &&
    permit.execution_id === context.proposal.execution_id &&
    permit.repository === context.repository.full_name &&
    permit.action_kind === context.proposal.action_kind &&
    permit.capability === context.proposal.capability &&
    permit.target_key === context.proposal.target_key &&
    permit.target_digest === context.proposal.target_digest &&
    permit.snapshot_id === context.proposal.snapshot_id
  );
}
