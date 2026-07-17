import type { OverseerCapability } from '@archon/core/db/overseer-capabilities';
import type { M31ActionPermitV2, M31ActionProposalV2 } from '@archon/core/db/m31-target-v2';
import {
  authorizeOverseerActionV2,
  type ActionPolicyV2DenialReason,
  type AuthorizeOverseerActionV2Deps,
} from '../action-policy-v2';
import {
  findMergePolicyTuple,
  type OverseerActionPolicyEntry,
  type OverseerActionPolicyRegistry,
  type OverseerDeploymentEffect,
} from '../policy-registry';
import type { ReopenRecipeV1 } from '../actions/lifecycle';

export type SandboxExecutionModeV1 = 'none' | 'fake' | 'sandbox';
export type SandboxActionKindV1 = 'REFRESH' | 'CLOSE' | 'REOPEN' | 'MERGE';

export type SandboxTargetClassificationV1 =
  | 'sandbox'
  | 'release'
  | 'deployment'
  | 'governance'
  | 'customer_data'
  | 'billing'
  | 'credential'
  | 'production_effect';

export interface SandboxRepositoryIdentityV1 {
  readonly provider_repository_id: string;
  readonly full_name: string;
  readonly owner: string;
  readonly repository: string;
}

export interface SandboxProviderObservationV1 {
  readonly provider_repository_id: string;
  readonly repository_full_name: string;
  readonly pull_request_number: number;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly candidate_digest: string;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly observed_at: string;
}

export interface SandboxExecutionReplayV1 {
  readonly replay_key: string;
  readonly consume: (replayKey: string) => Promise<boolean>;
}

export type SandboxProviderMutationResultV1 =
  | { readonly ok: true; readonly external_effect_reference: string }
  | { readonly ok: false; readonly indeterminate: true; readonly reason: string };

export interface SandboxProviderMutationInputV1 {
  readonly context: SandboxExecutionContextV1;
  readonly permit: M31ActionPermitV2;
  readonly policy_entry: OverseerActionPolicyEntry;
}

export interface SandboxProviderMutationDepsV1 {
  readonly refreshPullRequest: (
    input: SandboxProviderMutationInputV1
  ) => Promise<SandboxProviderMutationResultV1>;
  readonly closePullRequest: (
    input: SandboxProviderMutationInputV1
  ) => Promise<SandboxProviderMutationResultV1>;
  readonly reopenPullRequest: (
    input: SandboxProviderMutationInputV1
  ) => Promise<SandboxProviderMutationResultV1>;
  readonly mergePullRequest: (
    input: SandboxProviderMutationInputV1
  ) => Promise<SandboxProviderMutationResultV1>;
}

export interface SandboxExecutionContextV1 {
  readonly schema_version: 'overseer-sandbox-execution-context-v1';
  readonly mode: SandboxExecutionModeV1;
  readonly frozen_authorization_carried: boolean;
  readonly repository: SandboxRepositoryIdentityV1;
  readonly action_policy_registry: OverseerActionPolicyRegistry;
  readonly action_policy_registry_digest: string;
  readonly expected_action_policy_registry_digest: string;
  readonly credential_principal: string;
  readonly resulting_deployment_effect: OverseerDeploymentEffect;
  readonly target_classifications: readonly SandboxTargetClassificationV1[];
  readonly pull_request_number: number;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly candidate_digest: string;
  readonly expected_policy_digest: string;
  readonly expected_verifier_registry_digest: string;
  readonly expected_principal: string;
  readonly expected_repository_full_name: string;
  readonly expected_provider_repository_id: string;
  readonly observation: SandboxProviderObservationV1;
  readonly proposal: M31ActionProposalV2;
  readonly authorization_deps: AuthorizeOverseerActionV2Deps;
  readonly actor: string;
  readonly correlation_id: string;
  readonly replay: SandboxExecutionReplayV1;
  readonly provider: SandboxProviderMutationDepsV1;
}

export type SandboxActionResultReasonV1 =
  | 'accepted'
  | 'mode_not_sandbox'
  | 'authorization_not_carried'
  | 'repository_identity_mismatch'
  | 'repository_not_allowlisted'
  | 'protected_target'
  | 'state_binding_mismatch'
  | 'candidate_digest_mismatch'
  | 'policy_digest_mismatch'
  | 'registry_digest_mismatch'
  | 'principal_mismatch'
  | 'authorization_denied'
  | 'authorization_boundary_failed'
  | 'execution_replayed'
  | 'execution_check_failed'
  | 'salvage_failed'
  | 'rollback_recipe_mismatch'
  | 'provider_indeterminate';

export interface SandboxActionResultV1 {
  readonly schema_version: 'overseer-sandbox-action-result-v1';
  readonly adapter: 'sandbox-refresh' | 'sandbox-close' | 'sandbox-reopen' | 'sandbox-merge';
  readonly action_kind: SandboxActionKindV1;
  readonly accepted: boolean;
  readonly reason: SandboxActionResultReasonV1;
  readonly authorization_reason: ActionPolicyV2DenialReason | null;
  readonly authorization_audit_recorded: boolean;
  readonly permit_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly repository: string;
  readonly provider_repository_id: string;
  readonly pr_number: number;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly candidate_digest: string;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly action_policy_registry_digest: string;
  readonly credential_principal: string;
  readonly policy_entry_digest: string | null;
  readonly mutation_sent: boolean;
  readonly external_effect_reference: string | null;
  readonly reopen_recipe: ReopenRecipeV1 | null;
  readonly circuit_breaker_opened: boolean;
}

export interface SandboxPreparedMutationV1 {
  readonly policyEntry: OverseerActionPolicyEntry;
}

export interface SandboxAdapterOptionsV1 {
  readonly adapter: SandboxActionResultV1['adapter'];
  readonly actionKind: SandboxActionKindV1;
  readonly capability: OverseerCapability;
}

const PROTECTED_TARGETS: ReadonlySet<SandboxTargetClassificationV1> = new Set([
  'release',
  'deployment',
  'governance',
  'customer_data',
  'billing',
  'credential',
  'production_effect',
]);

function baseResult(
  context: SandboxExecutionContextV1,
  permit: M31ActionPermitV2,
  options: SandboxAdapterOptionsV1,
  reason: SandboxActionResultReasonV1,
  overrides: Partial<SandboxActionResultV1> = {}
): SandboxActionResultV1 {
  return {
    schema_version: 'overseer-sandbox-action-result-v1',
    adapter: options.adapter,
    action_kind: options.actionKind,
    accepted: reason === 'accepted',
    reason,
    authorization_reason: null,
    authorization_audit_recorded: false,
    permit_id: permit.permit_id,
    proposal_id: permit.proposal_id,
    execution_id: permit.execution_id,
    repository: context.repository.full_name,
    provider_repository_id: context.repository.provider_repository_id,
    pr_number: context.pull_request_number,
    base_branch: context.base_branch,
    base_sha: context.base_sha,
    head_sha: context.head_sha,
    candidate_digest: context.candidate_digest,
    policy_digest: context.expected_policy_digest,
    verifier_registry_digest: context.expected_verifier_registry_digest,
    action_policy_registry_digest: context.action_policy_registry_digest,
    credential_principal: context.credential_principal,
    policy_entry_digest: null,
    mutation_sent: false,
    external_effect_reference: null,
    reopen_recipe: null,
    circuit_breaker_opened: false,
    ...overrides,
  };
}

function repositoryIdentityMatches(context: SandboxExecutionContextV1): boolean {
  return (
    context.repository.full_name === context.expected_repository_full_name &&
    context.observation.repository_full_name === context.repository.full_name &&
    context.repository.provider_repository_id === context.expected_provider_repository_id &&
    context.observation.provider_repository_id === context.repository.provider_repository_id &&
    context.repository.full_name === `${context.repository.owner}/${context.repository.repository}`
  );
}

function liveStateMatches(context: SandboxExecutionContextV1): boolean {
  return (
    context.observation.pull_request_number === context.pull_request_number &&
    context.observation.base_branch === context.base_branch &&
    context.observation.base_sha === context.base_sha &&
    context.observation.head_sha === context.head_sha &&
    context.observation.policy_digest === context.expected_policy_digest &&
    context.observation.verifier_registry_digest === context.expected_verifier_registry_digest
  );
}

function permitMatchesContext(
  context: SandboxExecutionContextV1,
  permit: M31ActionPermitV2,
  options: SandboxAdapterOptionsV1
): boolean {
  return (
    permit.proposal_id === context.proposal.proposal_id &&
    permit.execution_id === context.proposal.execution_id &&
    permit.repository === context.repository.full_name &&
    permit.action_kind === options.actionKind &&
    permit.capability === `overseer.m31.${options.actionKind.toLowerCase()}` &&
    permit.target_key === context.proposal.target_key &&
    permit.target_digest === context.proposal.target_digest &&
    permit.snapshot_id === context.proposal.snapshot_id
  );
}

/**
 * The frozen bdc-xo design was not reachable from this build container. This
 * contract is modeled on the local frozen M-31 v2/action-policy-registry family,
 * matching the established disclosure style in refresh-rebase.ts.
 */
export async function prepareSandboxMutation(
  context: SandboxExecutionContextV1,
  permit: M31ActionPermitV2,
  options: SandboxAdapterOptionsV1
): Promise<
  | { readonly ok: true; readonly prepared: SandboxPreparedMutationV1; readonly result: SandboxActionResultV1 }
  | { readonly ok: false; readonly result: SandboxActionResultV1 }
> {
  if (context.mode !== 'sandbox') {
    return { ok: false, result: baseResult(context, permit, options, 'mode_not_sandbox') };
  }
  if (!context.frozen_authorization_carried) {
    return { ok: false, result: baseResult(context, permit, options, 'authorization_not_carried') };
  }
  if (!repositoryIdentityMatches(context)) {
    return { ok: false, result: baseResult(context, permit, options, 'repository_identity_mismatch') };
  }
  if (context.target_classifications.some(classification => PROTECTED_TARGETS.has(classification))) {
    return { ok: false, result: baseResult(context, permit, options, 'protected_target') };
  }
  if (context.action_policy_registry_digest !== context.expected_action_policy_registry_digest) {
    return { ok: false, result: baseResult(context, permit, options, 'registry_digest_mismatch') };
  }
  if (context.credential_principal !== context.expected_principal) {
    return { ok: false, result: baseResult(context, permit, options, 'principal_mismatch') };
  }
  if (!liveStateMatches(context)) {
    return { ok: false, result: baseResult(context, permit, options, 'state_binding_mismatch') };
  }
  if (context.observation.candidate_digest !== context.candidate_digest) {
    return { ok: false, result: baseResult(context, permit, options, 'candidate_digest_mismatch') };
  }
  if (!permitMatchesContext(context, permit, options)) {
    return { ok: false, result: baseResult(context, permit, options, 'state_binding_mismatch') };
  }

  const policyEntry = findMergePolicyTuple({
    registry: context.action_policy_registry,
    owner: context.repository.owner,
    repository: context.repository.repository,
    base_branch: context.base_branch,
    resulting_deployment_effect: context.resulting_deployment_effect,
    action_kind: options.actionKind,
    credential_principal: context.credential_principal,
  });
  if (!policyEntry) {
    return { ok: false, result: baseResult(context, permit, options, 'repository_not_allowlisted') };
  }
  if (policyEntry.policy_digest !== context.expected_policy_digest) {
    return { ok: false, result: baseResult(context, permit, options, 'policy_digest_mismatch') };
  }

  let authorization;
  try {
    authorization = await authorizeOverseerActionV2(
      {
        requested_capability: options.capability,
        permit,
        actor: context.actor,
        correlation_id: context.correlation_id,
      },
      context.authorization_deps
    );
  } catch {
    return { ok: false, result: baseResult(context, permit, options, 'authorization_boundary_failed') };
  }
  if (!authorization.allowed) {
    return {
      ok: false,
      result: baseResult(context, permit, options, 'authorization_denied', {
        authorization_reason: authorization.reason,
        authorization_audit_recorded: authorization.audit_recorded,
      }),
    };
  }

  let consumed = false;
  try {
    consumed = await context.replay.consume(context.replay.replay_key);
  } catch {
    return {
      ok: false,
      result: baseResult(context, permit, options, 'execution_check_failed', {
        authorization_audit_recorded: authorization.audit_recorded,
      }),
    };
  }
  if (!consumed) {
    return {
      ok: false,
      result: baseResult(context, permit, options, 'execution_replayed', {
        authorization_audit_recorded: authorization.audit_recorded,
      }),
    };
  }

  return {
    ok: true,
    prepared: { policyEntry },
    result: baseResult(context, permit, options, 'accepted', {
      authorization_audit_recorded: authorization.audit_recorded,
      policy_entry_digest: policyEntry.policy_digest,
    }),
  };
}

export function providerIndeterminateResult(
  result: SandboxActionResultV1
): SandboxActionResultV1 {
  return {
    ...result,
    accepted: false,
    reason: 'provider_indeterminate',
    mutation_sent: false,
    external_effect_reference: null,
    circuit_breaker_opened: true,
  };
}

export function providerAcceptedResult(
  result: SandboxActionResultV1,
  externalEffectReference: string
): SandboxActionResultV1 {
  return {
    ...result,
    accepted: true,
    reason: 'accepted',
    mutation_sent: true,
    external_effect_reference: externalEffectReference,
  };
}
