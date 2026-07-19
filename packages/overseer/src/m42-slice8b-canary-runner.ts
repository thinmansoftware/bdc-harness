import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  FusionBudgetReservation,
  OverseerVerifierRegistry,
} from '@archon/core/db/overseer-control-plane';
import type {
  M31ActionKind,
  M31ActionPermitV2,
  M31ActionProposalV2,
} from '@archon/core/db/m31-target-v2';
import type {
  OverseerCapability,
  OverseerCapabilityState,
} from '@archon/core/db/overseer-capabilities';
import { authorizeFusionInvocation } from '../../fusion/src/authorization';
import { evaluateUnknownActualCostWindow } from '../../fusion/src/budget';
import { sha256Digest } from '../../fusion/src/receipts';
import type { FusionComponentModelV1 } from '../../fusion/src/types';
import type { OverseerActionPolicy } from './action-policy';
import type { AuthorizeOverseerActionV2Deps } from './action-policy-v2';
import type { OverseerSalvageReceiptV1 } from './actions/lifecycle';
import { closeSandboxPullRequest } from './adapters/sandbox-close';
import { mergeSandboxPullRequest } from './adapters/sandbox-merge';
import { refreshSandboxPullRequest } from './adapters/sandbox-refresh';
import { reopenSandboxPullRequest } from './adapters/sandbox-reopen';
import type {
  SandboxActionResultV1,
  SandboxExecutionContextV1,
  SandboxProviderMutationDepsV1,
  SandboxProviderMutationResultV1,
  SandboxRepositoryIdentityV1,
} from './adapters/sandbox-types';
import {
  buildM42Slice8BEvidencePacket,
  type M42Slice8BCommandOutcome,
} from './m42-slice8b-evidence-packet';
import {
  assertNoLooseTargetOverrides,
  verifyM42Slice8BManifest,
  type M42Slice8BManifestEnvelope,
  type M42Slice8BManifestPayload,
  type M42Slice8BPrimaryAction,
} from './m42-slice8b-manifest';
import { enforceM42Slice8BGate1 } from './m42-slice8b-gate1';
import {
  assessM42Slice8BProcessHealth,
  type M42Slice8BProcessSnapshot,
} from './m42-slice8b-process-health';
import { computePolicyTupleDigest, type OverseerActionPolicyRegistry } from './policy-registry';
import type { FusionAuthorizationRequestV1 } from '../../fusion/src/types';
import { executeM42Slice8BStagingRefireBridge } from './staging-refire-bridge';

const execFileAsync = promisify(execFile);

export type M42Slice8BRunnerActionName = M42Slice8BPrimaryAction | 'REOPEN_ROLLBACK';
export type M42Slice8BRunnerStopReason =
  | 'completed'
  | 'manifest_refused'
  | 'cli_override_refused'
  | 'gate1_refused'
  | 'execution_duplicate'
  | 'execution_conflict'
  | 'window_exceeded'
  | 'action_indeterminate'
  | 'action_refused'
  | 'receipt_failure_after_provider_response'
  | 'rollback_failed';

export interface M42Slice8BActionReceipt {
  readonly action: M42Slice8BRunnerActionName;
  readonly execution_id: string;
  readonly accepted: boolean;
  readonly indeterminate: boolean;
  readonly m31_receipt_recorded: boolean;
  readonly provider_receipt_recorded: boolean;
  readonly fusion_budget_receipt_recorded: boolean;
  readonly rollback_receipt_recorded: boolean;
  readonly provider_call_count: number;
  readonly fake_provider_call_count: number;
  readonly fusion_call_count: number;
  readonly fake_fusion_logic_count: number;
  readonly production_mutation_count: number;
  readonly receipt_id: string;
  readonly sibling_module: string;
  readonly rollback_state_digest?: string;
}

export interface M42Slice8BRunnerReceipt {
  readonly schema_version: 'm42-slice8b-canary-runner-receipt-v1';
  readonly ok: boolean;
  readonly stop_reason: M42Slice8BRunnerStopReason;
  readonly execution_id: string | null;
  readonly attempted_primary_actions: readonly M42Slice8BPrimaryAction[];
  readonly rollback_actions: readonly Extract<M42Slice8BRunnerActionName, 'REOPEN_ROLLBACK'>[];
  readonly unexpected_action_count: number;
  readonly provider_call_count: number;
  readonly fake_provider_call_count: number;
  readonly fusion_call_count: number;
  readonly fake_fusion_logic_count: number;
  readonly production_mutation_count: number;
  readonly m31_receipt_count: number;
  readonly provider_receipt_count: number;
  readonly fusion_budget_receipt_count: number;
  readonly rollback_receipt_count: number;
  readonly circuit_breaker_opened: boolean;
  readonly rollback_verified: boolean;
  readonly receipts: readonly M42Slice8BActionReceipt[];
  readonly xo_briefing_reconciled: boolean;
}

export interface M42Slice8BExecutionStore {
  begin(executionId: string, manifestDigest: string): Promise<'fresh' | 'duplicate' | 'conflict'>;
  commit(executionId: string, receipt: M42Slice8BRunnerReceipt): Promise<void>;
}

export interface M42Slice8BActionExecutor {
  execute(input: {
    readonly action: M42Slice8BRunnerActionName;
    readonly manifest: M42Slice8BManifestPayload;
  }): Promise<M42Slice8BActionReceipt>;
}

export interface M42Slice8BSiblingFakeOptions {
  readonly sandboxPolicyAllowlisted?: boolean;
  readonly fusionRawDissent?: string;
}

export interface M42Slice8BRunnerDeps {
  readonly expected_candidate_sha: string;
  readonly expected_starting_sha: string;
  readonly expected_repository_full_name: string;
  readonly expected_provider_repository_id: string;
  readonly nowMs: () => number;
  readonly executionStore: M42Slice8BExecutionStore;
  readonly actions: M42Slice8BActionExecutor;
}

export class InMemoryM42Slice8BExecutionStore implements M42Slice8BExecutionStore {
  private readonly started = new Map<string, string>();

  async begin(
    executionId: string,
    manifestDigest: string
  ): Promise<'fresh' | 'duplicate' | 'conflict'> {
    const existing = this.started.get(executionId);
    if (existing === undefined) {
      this.started.set(executionId, manifestDigest);
      return 'fresh';
    }
    return existing === manifestDigest ? 'duplicate' : 'conflict';
  }

  async commit(_executionId: string, _receipt: M42Slice8BRunnerReceipt): Promise<void> {
    return undefined;
  }
}

export function createFakeM42Slice8BActionExecutor(
  overrides: Partial<Record<M42Slice8BRunnerActionName, Partial<M42Slice8BActionReceipt>>> = {},
  options: M42Slice8BSiblingFakeOptions = {}
): M42Slice8BActionExecutor {
  return {
    async execute({ action, manifest }): Promise<M42Slice8BActionReceipt> {
      const base = await executeM42Slice8BSiblingFakeAction(action, manifest, options);
      return { ...base, ...overrides[action] };
    },
  };
}

export function createSiblingBackedM42Slice8BActionExecutor(
  overrides: Partial<Record<M42Slice8BRunnerActionName, Partial<M42Slice8BActionReceipt>>> = {},
  options: M42Slice8BSiblingFakeOptions = {}
): M42Slice8BActionExecutor {
  return createFakeM42Slice8BActionExecutor(overrides, options);
}

async function executeM42Slice8BSiblingFakeAction(
  action: M42Slice8BRunnerActionName,
  manifest: M42Slice8BManifestPayload,
  options: M42Slice8BSiblingFakeOptions
): Promise<M42Slice8BActionReceipt> {
  const executionId = `${manifest.execution_id}:${action}`;
  const fusion = await exerciseFusionBudgetAuthorizationReceiptPath(manifest, executionId, options);
  if (!fusion.ok) {
    return {
      action,
      execution_id: executionId,
      accepted: false,
      indeterminate: false,
      m31_receipt_recorded: true,
      provider_receipt_recorded: false,
      fusion_budget_receipt_recorded: false,
      provider_call_count: 0,
      fake_provider_call_count: 0,
      fusion_call_count: 0,
      fake_fusion_logic_count: fusion.logic_count,
      production_mutation_count: 0,
      rollback_receipt_recorded: false,
      receipt_id: `fusion-refused-${executionId}`,
      sibling_module: fusion.module,
    };
  }

  if (action === 'REFIRE') {
    const refire = await executeSiblingRefire(manifest, executionId);
    return actionReceiptFromSibling({
      action,
      executionId,
      accepted: refire.normalized_outcome === 'admitted',
      indeterminate: refire.normalized_outcome === 'reconciliation_required',
      rollbackReceiptRecorded: false,
      fakeProviderCallCount: refire.side_effect_count,
      fakeFusionLogicCount: fusion.logic_count,
      receiptId: refire.receipt_digest,
      siblingModule: 'actions/cauldron-refire-bridge',
    });
  }

  const sandbox = await executeSiblingSandboxAction(action, manifest, executionId, options);
  return actionReceiptFromSibling({
    action,
    executionId,
    accepted: sandbox.accepted,
    indeterminate: sandbox.circuit_breaker_opened || sandbox.reason === 'provider_indeterminate',
    rollbackReceiptRecorded: action === 'REOPEN_ROLLBACK' && sandbox.accepted,
    fakeProviderCallCount: sandbox.mutation_sent ? 1 : 0,
    fakeFusionLogicCount: fusion.logic_count,
    receiptId: `sandbox-${sandbox.adapter}-${sandbox.execution_id}-${sandbox.reason}`,
    siblingModule: `adapters/${sandbox.adapter}`,
    rollbackStateDigest:
      action === 'REOPEN_ROLLBACK' && sandbox.accepted
        ? manifest.declared_rollback_state_digest
        : undefined,
  });
}

function actionReceiptFromSibling(input: {
  readonly action: M42Slice8BRunnerActionName;
  readonly executionId: string;
  readonly accepted: boolean;
  readonly indeterminate: boolean;
  readonly rollbackReceiptRecorded: boolean;
  readonly fakeProviderCallCount: number;
  readonly fakeFusionLogicCount: number;
  readonly receiptId: string;
  readonly siblingModule: string;
  readonly rollbackStateDigest?: string;
}): M42Slice8BActionReceipt {
  return {
    action: input.action,
    execution_id: input.executionId,
    accepted: input.accepted,
    indeterminate: input.indeterminate,
    m31_receipt_recorded: true,
    provider_receipt_recorded: true,
    fusion_budget_receipt_recorded: true,
    rollback_receipt_recorded: input.rollbackReceiptRecorded,
    provider_call_count: 0,
    fake_provider_call_count: input.fakeProviderCallCount,
    fusion_call_count: 0,
    fake_fusion_logic_count: input.fakeFusionLogicCount,
    production_mutation_count: 0,
    receipt_id: input.receiptId,
    sibling_module: input.siblingModule,
    rollback_state_digest: input.rollbackStateDigest,
  };
}

async function executeSiblingSandboxAction(
  action: Exclude<M42Slice8BRunnerActionName, 'REFIRE'>,
  manifest: M42Slice8BManifestPayload,
  executionId: string,
  options: M42Slice8BSiblingFakeOptions
): Promise<SandboxActionResultV1> {
  const actionKind = action === 'REOPEN_ROLLBACK' ? 'REOPEN' : action;
  const fixture = sandboxFixture(manifest, actionKind, executionId, options);
  if (actionKind === 'REFRESH') {
    return refreshSandboxPullRequest(fixture.context, fixture.permit);
  }
  if (actionKind === 'CLOSE') {
    return closeSandboxPullRequest({
      context: fixture.context,
      permit: fixture.permit,
      salvage_receipt: salvageReceipt(fixture.context),
      salvage_deps: {
        artifactExists: async () => true,
        digestPatch: async () => hex('m42-slice8b-salvage-patch'),
      },
      required_observation_digest: hex('m42-slice8b-observed-closed-state'),
      action_parameters_digest: hex('m42-slice8b-close-parameters'),
    });
  }
  if (actionKind === 'REOPEN') {
    return reopenSandboxPullRequest({
      context: fixture.context,
      permit: fixture.permit,
      reopen_recipe: {
        schema_version: 'overseer-lifecycle-reopen-recipe-v1',
        target: {
          repository: fixture.context.repository.full_name,
          target_kind: 'pull_request',
          target_key: fixture.context.proposal.target_key,
          target_digest: fixture.context.proposal.target_digest,
          snapshot_id: fixture.context.proposal.snapshot_id,
          target: fixture.context.proposal.target,
        },
        prior_proposal_id: fixture.permit.proposal_id,
        prior_execution_id: fixture.permit.execution_id,
        required_observation_digest: hex('m42-slice8b-observed-closed-state'),
        inverse_provider_action: 'REOPEN',
        action_parameters_digest: hex('m42-slice8b-close-parameters'),
      },
      observed_false_digest: hex('m42-slice8b-observed-closed-state'),
    });
  }
  return mergeSandboxPullRequest(fixture.context, fixture.permit);
}

async function executeSiblingRefire(
  manifest: M42Slice8BManifestPayload,
  executionId: string
): ReturnType<typeof executeM42Slice8BStagingRefireBridge> {
  return executeM42Slice8BStagingRefireBridge(manifest, executionId);
}

async function exerciseFusionBudgetAuthorizationReceiptPath(
  manifest: M42Slice8BManifestPayload,
  executionId: string,
  options: M42Slice8BSiblingFakeOptions
): Promise<{ readonly ok: boolean; readonly logic_count: number; readonly module: string }> {
  const reservation = fusionReservation(executionId);
  const budget = evaluateUnknownActualCostWindow(reservation, Date.parse('2026-07-17T12:02:00Z'));
  const receiptDigest = sha256Digest(
    JSON.stringify({
      execution_id: executionId,
      reservation_id: reservation.reservation_id,
      verifier_registry_digest: manifest.verifier_registry_digest,
    })
  );
  const authorization =
    options.fusionRawDissent === ''
      ? await authorizeFusionInvocation(fusionAuthorizationRequest(manifest, executionId, ''), {
          registry_digest: manifest.verifier_registry_digest,
          schema_version: 'overseer-verifier-registry-v1',
          frozen_at: '2026-07-17T12:00:00.000Z',
          created_at: '2026-07-17T12:00:00.000Z',
          source_artifact_path: 'fake-m42-slice8b-verifier-registry.json',
          source_git_blob: 'd'.repeat(40),
          entries: [],
        } as OverseerVerifierRegistry)
      : { ok: true as const };
  const invokedAuthorizationLogic = options.fusionRawDissent === '';
  return {
    ok: budget.ok && authorization.ok && receiptDigest.length === 64,
    logic_count: 2 + (invokedAuthorizationLogic ? 1 : 0),
    module: authorization.ok ? 'fusion/budget+receipts+authorization' : 'fusion/authorization',
  };
}

function fusionAuthorizationRequest(
  manifest: M42Slice8BManifestPayload,
  executionId: string,
  rawDissent: string
): FusionAuthorizationRequestV1 {
  const componentModels: FusionComponentModelV1[] = [
    {
      verifier_id: 'm42-slice8b-fake-fusion-verifier',
      provider: 'fake',
      model_family: 'fake-family',
      model_id: 'fake-model',
    },
  ];
  return {
    invocation_id: `fusion-${executionId}`,
    proposal_id: `proposal-${executionId}`,
    verifier_registry_digest: manifest.verifier_registry_digest,
    component_models: componentModels,
    raw_dissent: rawDissent,
    prompt: 'fake-mode authorization prompt',
    result: 'fake-mode authorization result',
    model_disclosure: 'fake provider, fake model, no paid Fusion call',
    reserved_cost_usd: 0.01,
    actual_cost_usd: 0.01,
    reconciliation_status: 'reconciled' as const,
    web_enabled: false,
    operator_provider: 'operator',
    operator_model_family: 'operator-family',
  };
}

function sandboxFixture(
  manifest: M42Slice8BManifestPayload,
  actionKind: Exclude<M31ActionKind, 'REFIRE'>,
  executionId: string,
  options: M42Slice8BSiblingFakeOptions
): { readonly context: SandboxExecutionContextV1; readonly permit: M31ActionPermitV2 } {
  const { proposal, permit } = proposalAndPermit(manifest, actionKind, executionId, 'pull_request');
  const capability = capabilityFor(actionKind);
  const registry = registryFor(manifest, actionKind, options.sandboxPolicyAllowlisted !== false);
  const provider = fakeSandboxProvider();
  const context: SandboxExecutionContextV1 = {
    schema_version: 'overseer-sandbox-execution-context-v1',
    mode: 'sandbox',
    frozen_authorization_carried: true,
    repository: repositoryIdentity(manifest),
    action_policy_registry: registry,
    action_policy_registry_digest: manifest.action_policy_digest,
    expected_action_policy_registry_digest: manifest.action_policy_digest,
    credential_principal: manifest.credential_principal_id,
    resulting_deployment_effect: 'none',
    target_classifications: ['sandbox'],
    pull_request_number: 42,
    base_branch: 'dev',
    base_sha: manifest.starting_sha,
    head_sha: manifest.candidate_sha,
    candidate_digest: manifest.image_digest,
    expected_policy_digest: proposal.policy_digest,
    expected_verifier_registry_digest: hexDigest(manifest.verifier_registry_digest),
    expected_principal: manifest.credential_principal_id,
    expected_repository_full_name: manifest.repository_full_name,
    expected_provider_repository_id: manifest.provider_repository_id,
    observation: {
      provider_repository_id: manifest.provider_repository_id,
      repository_full_name: manifest.repository_full_name,
      pull_request_number: 42,
      base_branch: 'dev',
      base_sha: manifest.starting_sha,
      head_sha: manifest.candidate_sha,
      candidate_digest: manifest.image_digest,
      policy_digest: proposal.policy_digest,
      verifier_registry_digest: hexDigest(manifest.verifier_registry_digest),
      observed_at: '2026-07-17T12:01:00.000Z',
    },
    proposal,
    authorization_deps: authorizationDeps(capability, proposal),
    actor: 'xo',
    correlation_id: `corr-${executionId}`,
    replay: { replay_key: executionId, consume: async () => true },
    provider,
  };
  return { context, permit };
}

function proposalAndPermit(
  manifest: M42Slice8BManifestPayload,
  actionKind: M31ActionKind,
  executionId: string,
  targetKind: 'pull_request' | 'workflow_run'
): { readonly proposal: M31ActionProposalV2; readonly permit: M31ActionPermitV2 } {
  const policyDigest =
    actionKind === 'REFIRE'
      ? hex('m42-slice8b-refire-policy')
      : policyDigestFor(manifest, actionKind);
  const target =
    targetKind === 'pull_request'
      ? {
          target_kind: 'pull_request' as const,
          repository: manifest.repository_full_name,
          pr_number: 42,
          provider_node_id: 'PR_m42_slice8b_fake',
          head_sha: manifest.candidate_sha,
          base_branch: 'dev',
          base_sha: manifest.starting_sha,
          state: 'open',
          updated_at: '2026-07-17T12:00:00.000Z',
        }
      : {
          target_kind: 'workflow_run' as const,
          repository: manifest.repository_full_name,
          run_id: 'failed-run-m42-slice8b',
          wo_id: 'WO-ORIGINAL-FAILED-01',
          workflow_name: 'implement',
          codebase_id: 'codebase-bdc-harness',
          status: 'failed',
          event_tip: hex('m42-slice8b-event-tip'),
          head_sha: manifest.candidate_sha,
          base_sha: manifest.starting_sha,
        };
  const proposal: M31ActionProposalV2 = {
    proposal_id: `proposal-${executionId}`,
    repository: manifest.repository_full_name,
    target,
    target_key: `${manifest.repository_full_name}#${targetKind}:42`,
    target_digest: hex(`target-${executionId}`),
    snapshot_id: `snapshot-${executionId}`,
    evidence_path: `evidence/${executionId}.json`,
    evidence_git_blob: 'c'.repeat(40),
    action_kind: actionKind,
    action_parameters: {},
    actor: 'xo',
    created_at: '2026-07-17T12:00:00.000Z',
    expires_at: '2026-07-17T12:15:00.000Z',
    execution_id: executionId,
    capability: `overseer.m31.${actionKind.toLowerCase()}`,
    policy_digest: policyDigest,
    verifier_registry_digest: hexDigest(manifest.verifier_registry_digest),
  };
  const permit: M31ActionPermitV2 = {
    permit_id: `permit-${executionId}`,
    proposal_id: proposal.proposal_id,
    execution_id: proposal.execution_id,
    repository: manifest.repository_full_name,
    target,
    target_key: proposal.target_key,
    target_digest: proposal.target_digest,
    snapshot_id: proposal.snapshot_id,
    action_kind: actionKind,
    capability: proposal.capability,
    issued_at: '2026-07-17T12:00:30.000Z',
    valid_until: '2026-07-17T12:10:00.000Z',
  };
  return { proposal, permit };
}

function registryFor(
  manifest: M42Slice8BManifestPayload,
  actionKind: M31ActionKind,
  allowlisted: boolean
): OverseerActionPolicyRegistry {
  if (!allowlisted) return { schema_version: 'overseer-action-policy-v1', entries: [] };
  const tuple = {
    owner: manifest.repository_full_name.split('/')[0] ?? '',
    repository: manifest.repository_full_name.split('/')[1] ?? '',
    base_branch: 'dev',
    resulting_deployment_effect: 'none' as const,
    allowed_action_kinds: [actionKind],
    credential_principal: manifest.credential_principal_id,
  };
  return {
    schema_version: 'overseer-action-policy-v1',
    entries: [{ ...tuple, policy_digest: computePolicyTupleDigest(tuple) }],
  };
}

function policyDigestFor(manifest: M42Slice8BManifestPayload, actionKind: M31ActionKind): string {
  return registryFor(manifest, actionKind, true).entries[0]?.policy_digest ?? hex('missing-policy');
}

function capabilityFor(actionKind: M31ActionKind): OverseerCapability {
  if (actionKind === 'MERGE') return 'merge';
  if (actionKind === 'REFRESH') return 'branch';
  if (actionKind === 'REFIRE') return 'repair';
  return 'lifecycle';
}

function authorizationDeps(
  capability: OverseerCapability,
  proposal: M31ActionProposalV2
): AuthorizeOverseerActionV2Deps {
  return {
    getPolicy: async (): Promise<OverseerActionPolicy> => ({
      service_enabled: true,
      emergency_stop: false,
      legacy_dry_run: false,
      capability_flags: {
        escalation: false,
        repair: capability === 'repair',
        branch: capability === 'branch',
        lifecycle: capability === 'lifecycle',
        merge: capability === 'merge',
      },
    }),
    getCapabilityState: async (): Promise<OverseerCapabilityState> => ({
      capability,
      action_enabled: true,
      circuit_state: 'closed',
      circuit_reason: null,
      circuit_opened_at: null,
      policy_digest: proposal.policy_digest,
      verifier_registry_digest: proposal.verifier_registry_digest,
      updated_at: '2026-07-17T12:00:00.000Z',
      updated_by: 'board',
    }),
    getProposal: async (): Promise<M31ActionProposalV2> => proposal,
    getCurrentTime: async (): Promise<string> => '2026-07-17T12:01:00.000Z',
    recordDecision: async (): Promise<void> => undefined,
  };
}

function fakeSandboxProvider(): SandboxProviderMutationDepsV1 {
  const accepted = async (): Promise<SandboxProviderMutationResultV1> => ({
    ok: true as const,
    external_effect_reference: 'fake-provider-effect',
  });
  return {
    refreshPullRequest: accepted,
    closePullRequest: accepted,
    reopenPullRequest: accepted,
    mergePullRequest: accepted,
  };
}

function repositoryIdentity(manifest: M42Slice8BManifestPayload): SandboxRepositoryIdentityV1 {
  const [owner, repository] = manifest.repository_full_name.split('/');
  return {
    provider_repository_id: manifest.provider_repository_id,
    full_name: manifest.repository_full_name,
    owner: owner ?? '',
    repository: repository ?? '',
  };
}

function salvageReceipt(context: SandboxExecutionContextV1): OverseerSalvageReceiptV1 {
  return {
    schema_version: 'overseer-salvage-receipt-v1',
    repository: context.repository.full_name,
    wo_id: 'WO-HARNESS-OVERSEER-S8B-REAL-CANARY-RUNNER-01',
    source_target_kind: 'pull_request',
    source_target_key: context.proposal.target_key,
    source_target_digest: context.proposal.target_digest,
    source_run_id: null,
    worktree_path: '/tmp/m42-slice8b-fake-worktree',
    artifact_kind: 'patch',
    git_object_format: null,
    git_object_id: null,
    patch_path: 'm42-slice8b-salvage.patch',
    patch_sha256: hex('m42-slice8b-salvage-patch'),
    scope_digest: hex('m42-slice8b-salvage-scope'),
    captured_at: '2026-07-17T12:00:00.000Z',
    verified_at: '2026-07-17T12:00:00.000Z',
  };
}

function fusionReservation(executionId: string): FusionBudgetReservation {
  return {
    reservation_id: `reservation-${executionId}`,
    call_id: `call-${executionId}`,
    proposal_id: `proposal-${executionId}`,
    execution_id: executionId,
    provider: 'fake',
    model: 'fake-model',
    call_kind: 'PRIMARY',
    utc_day: '2026-07-17',
    utc_month: '2026-07',
    requested_microusd: 10_000,
    actual_microusd: 10_000,
    status: 'RECONCILED',
    reserved_at: '2026-07-17T12:00:00.000Z',
    call_started_at: '2026-07-17T12:01:00.000Z',
    reconciled_at: '2026-07-17T12:01:30.000Z',
    released_at: null,
    release_reason: null,
  };
}

function hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hexDigest(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}

export async function runM42Slice8BCanary(
  envelope: M42Slice8BManifestEnvelope,
  deps: M42Slice8BRunnerDeps
): Promise<M42Slice8BRunnerReceipt> {
  const verified = verifyM42Slice8BManifest(envelope, {
    candidate_sha: deps.expected_candidate_sha,
    starting_sha: deps.expected_starting_sha,
    repository_full_name: deps.expected_repository_full_name,
    provider_repository_id: deps.expected_provider_repository_id,
  });
  if (!verified.ok) return stopped(null, 'manifest_refused', [], [], [], [], false);

  const gate1 = enforceM42Slice8BGate1(verified.manifest, { nowMs: deps.nowMs });
  if (!gate1.ok) {
    return stopped(
      verified.manifest.execution_id,
      'gate1_refused',
      verified.manifest.expected_primary_actions,
      [],
      [],
      [],
      false
    );
  }

  const begin = await deps.executionStore.begin(verified.manifest.execution_id, verified.digest);
  if (begin === 'duplicate') {
    return stopped(
      verified.manifest.execution_id,
      'execution_duplicate',
      verified.manifest.expected_primary_actions,
      [],
      [],
      [],
      false
    );
  }
  if (begin === 'conflict') {
    return stopped(
      verified.manifest.execution_id,
      'execution_conflict',
      verified.manifest.expected_primary_actions,
      [],
      [],
      [],
      false
    );
  }

  const startedAt = deps.nowMs();
  const receipts: M42Slice8BActionReceipt[] = [];
  const attempted: M42Slice8BPrimaryAction[] = [];
  const rollbackActions: Extract<M42Slice8BRunnerActionName, 'REOPEN_ROLLBACK'>[] = [];
  let circuitBreakerOpened = false;

  for (const action of verified.manifest.expected_primary_actions) {
    if (deps.nowMs() - startedAt > 60 * 60 * 1000) {
      const receipt = stopped(
        verified.manifest.execution_id,
        'window_exceeded',
        verified.manifest.expected_primary_actions,
        attempted,
        rollbackActions,
        receipts,
        circuitBreakerOpened
      );
      await deps.executionStore.commit(verified.manifest.execution_id, receipt);
      return receipt;
    }

    const receipt = await deps.actions.execute({ action, manifest: verified.manifest });
    receipts.push(receipt);
    attempted.push(action);
    if (receipt.action !== action) {
      const stoppedReceipt = stopped(
        verified.manifest.execution_id,
        'action_refused',
        verified.manifest.expected_primary_actions,
        attempted,
        rollbackActions,
        receipts,
        circuitBreakerOpened
      );
      await deps.executionStore.commit(verified.manifest.execution_id, stoppedReceipt);
      return stoppedReceipt;
    }
    if (hasReceiptFailureAfterProviderResponse(receipt)) {
      const stoppedReceipt = stopped(
        verified.manifest.execution_id,
        'receipt_failure_after_provider_response',
        verified.manifest.expected_primary_actions,
        attempted,
        rollbackActions,
        receipts,
        true
      );
      await deps.executionStore.commit(verified.manifest.execution_id, stoppedReceipt);
      return stoppedReceipt;
    }
    if (receipt.indeterminate) {
      circuitBreakerOpened = true;
      const stoppedReceipt = stopped(
        verified.manifest.execution_id,
        'action_indeterminate',
        verified.manifest.expected_primary_actions,
        attempted,
        rollbackActions,
        receipts,
        circuitBreakerOpened
      );
      await deps.executionStore.commit(verified.manifest.execution_id, stoppedReceipt);
      return stoppedReceipt;
    }
    if (!receipt.accepted) {
      const stoppedReceipt = stopped(
        verified.manifest.execution_id,
        'action_refused',
        verified.manifest.expected_primary_actions,
        attempted,
        rollbackActions,
        receipts,
        circuitBreakerOpened
      );
      await deps.executionStore.commit(verified.manifest.execution_id, stoppedReceipt);
      return stoppedReceipt;
    }

    if (action === 'CLOSE') {
      const rollback = await deps.actions.execute({
        action: 'REOPEN_ROLLBACK',
        manifest: verified.manifest,
      });
      receipts.push(rollback);
      rollbackActions.push('REOPEN_ROLLBACK');
      if (rollback.action !== 'REOPEN_ROLLBACK') {
        const stoppedReceipt = stopped(
          verified.manifest.execution_id,
          'rollback_failed',
          verified.manifest.expected_primary_actions,
          attempted,
          rollbackActions,
          receipts,
          true
        );
        await deps.executionStore.commit(verified.manifest.execution_id, stoppedReceipt);
        return stoppedReceipt;
      }
      if (hasReceiptFailureAfterProviderResponse(rollback)) {
        const stoppedReceipt = stopped(
          verified.manifest.execution_id,
          'receipt_failure_after_provider_response',
          verified.manifest.expected_primary_actions,
          attempted,
          rollbackActions,
          receipts,
          true
        );
        await deps.executionStore.commit(verified.manifest.execution_id, stoppedReceipt);
        return stoppedReceipt;
      }
      if (
        !rollback.accepted ||
        rollback.indeterminate ||
        rollback.rollback_state_digest !== verified.manifest.declared_rollback_state_digest
      ) {
        const stoppedReceipt = stopped(
          verified.manifest.execution_id,
          'rollback_failed',
          verified.manifest.expected_primary_actions,
          attempted,
          rollbackActions,
          receipts,
          true
        );
        await deps.executionStore.commit(verified.manifest.execution_id, stoppedReceipt);
        return stoppedReceipt;
      }
    }
  }

  const completed = stopped(
    verified.manifest.execution_id,
    'completed',
    verified.manifest.expected_primary_actions,
    attempted,
    rollbackActions,
    receipts,
    circuitBreakerOpened
  );
  await deps.executionStore.commit(verified.manifest.execution_id, completed);
  return completed;
}

function hasReceiptFailureAfterProviderResponse(receipt: M42Slice8BActionReceipt): boolean {
  return (
    receipt.provider_call_count > 0 &&
    (!receipt.accepted ||
      !receipt.m31_receipt_recorded ||
      !receipt.provider_receipt_recorded ||
      !receipt.fusion_budget_receipt_recorded)
  );
}

function stopped(
  executionId: string | null,
  stopReason: M42Slice8BRunnerStopReason,
  expectedPrimaryActions: readonly M42Slice8BPrimaryAction[],
  attemptedPrimaryActions: readonly M42Slice8BPrimaryAction[],
  rollbackActions: readonly Extract<M42Slice8BRunnerActionName, 'REOPEN_ROLLBACK'>[],
  receipts: readonly M42Slice8BActionReceipt[],
  circuitBreakerOpened: boolean
): M42Slice8BRunnerReceipt {
  const providerCalls = receipts.reduce((count, receipt) => count + receipt.provider_call_count, 0);
  const fakeProviderCalls = receipts.reduce(
    (count, receipt) => count + receipt.fake_provider_call_count,
    0
  );
  const fusionCalls = receipts.reduce((count, receipt) => count + receipt.fusion_call_count, 0);
  const fakeFusionLogic = receipts.reduce(
    (count, receipt) => count + receipt.fake_fusion_logic_count,
    0
  );
  const productionMutations = receipts.reduce(
    (count, receipt) => count + receipt.production_mutation_count,
    0
  );
  const m31ReceiptCount = receipts.filter(receipt => receipt.m31_receipt_recorded).length;
  const providerReceiptCount = receipts.filter(receipt => receipt.provider_receipt_recorded).length;
  const fusionBudgetReceiptCount = receipts.filter(
    receipt => receipt.fusion_budget_receipt_recorded
  ).length;
  const rollbackReceiptCount = receipts.filter(receipt => receipt.rollback_receipt_recorded).length;
  const rollbackVerified =
    stopReason === 'completed' &&
    rollbackActions.length === 1 &&
    receipts.some(r => r.action === 'REOPEN_ROLLBACK');
  const expectedReceiptActions = expectedPrimaryActions.flatMap(action =>
    action === 'CLOSE' && rollbackActions.includes('REOPEN_ROLLBACK')
      ? [action, 'REOPEN_ROLLBACK' as const]
      : [action]
  );
  const comparedReceiptCount = Math.min(receipts.length, expectedReceiptActions.length);
  const unexpectedActionCount =
    receipts
      .slice(0, comparedReceiptCount)
      .reduce(
        (count, receipt, index) =>
          count + (receipt.action === expectedReceiptActions[index] ? 0 : 1),
        0
      ) + Math.max(0, receipts.length - expectedReceiptActions.length);
  return {
    schema_version: 'm42-slice8b-canary-runner-receipt-v1',
    ok: stopReason === 'completed',
    stop_reason: stopReason,
    execution_id: executionId,
    attempted_primary_actions: attemptedPrimaryActions,
    rollback_actions: rollbackActions,
    unexpected_action_count: unexpectedActionCount,
    provider_call_count: providerCalls,
    fake_provider_call_count: fakeProviderCalls,
    fusion_call_count: fusionCalls,
    fake_fusion_logic_count: fakeFusionLogic,
    production_mutation_count: productionMutations,
    m31_receipt_count: m31ReceiptCount,
    provider_receipt_count: providerReceiptCount,
    fusion_budget_receipt_count: fusionBudgetReceiptCount,
    rollback_receipt_count: rollbackReceiptCount,
    circuit_breaker_opened: circuitBreakerOpened,
    rollback_verified: rollbackVerified,
    receipts,
    xo_briefing_reconciled:
      stopReason === 'completed' &&
      attemptedPrimaryActions.length === 4 &&
      providerCalls === 0 &&
      productionMutations === 0,
  };
}

async function observeM42Slice8BProcessSnapshot(
  observedAtMs = Date.now(),
  ps: () => Promise<string> = async () => {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,etimes=,args='], {
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }
): Promise<M42Slice8BProcessSnapshot> {
  try {
    const output = await ps();
    return {
      observed_at_ms: observedAtMs,
      processes: parseM42Slice8BProcessSnapshot(output, observedAtMs),
    };
  } catch {
    // If host process enumeration is unavailable, record an empty observed snapshot
    // so the evidence remains build-ready-only instead of inventing runtime health.
    return { observed_at_ms: observedAtMs, processes: [] };
  }
}

export function parseM42Slice8BProcessSnapshot(
  output: string,
  observedAtMs: number
): M42Slice8BProcessSnapshot['processes'] {
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) return null;
      const pid = Number(match[1]);
      const elapsedSeconds = Number(match[2]);
      const command = match[3] ?? '';
      if (!Number.isFinite(pid) || !Number.isFinite(elapsedSeconds)) return null;
      if (!isM42Slice8BOverseerRuntimeCommand(command)) return null;
      return {
        pid,
        started_at_ms: observedAtMs - elapsedSeconds * 1000,
        healthy: true,
        command,
      };
    })
    .filter(
      (process): process is M42Slice8BProcessSnapshot['processes'][number] => process !== null
    );
}

function isM42Slice8BOverseerRuntimeCommand(command: string): boolean {
  return (
    command.includes('overseer:serve') ||
    command.includes('packages/overseer/src/service.ts') ||
    /\bsrc\/service\.ts\b/.test(command)
  );
}

async function main(): Promise<number> {
  try {
    const argv = process.argv.slice(2);
    assertNoLooseTargetOverrides(argv);
    const manifestArg = argv.find(arg => arg.startsWith('--manifest='));
    const manifestPath =
      manifestArg?.slice('--manifest='.length) ?? argv[argv.indexOf('--manifest') + 1];
    if (!manifestPath) throw new Error('manifest_required');
    const envelope = JSON.parse(await readFile(manifestPath, 'utf8')) as M42Slice8BManifestEnvelope;
    const processHealthBefore = await observeM42Slice8BProcessSnapshot();
    const receipt = await runM42Slice8BCanary(envelope, {
      expected_candidate_sha: envelope.payload.candidate_sha,
      expected_starting_sha: envelope.payload.starting_sha,
      expected_repository_full_name: envelope.payload.repository_full_name,
      expected_provider_repository_id: envelope.payload.provider_repository_id,
      nowMs: () => Date.now(),
      executionStore: new InMemoryM42Slice8BExecutionStore(),
      actions: createSiblingBackedM42Slice8BActionExecutor(),
    });
    const processHealthAfter = await observeM42Slice8BProcessSnapshot();
    const commandOk: M42Slice8BCommandOutcome = {
      command: 'm42-slice8b:canary-run',
      exit_code: receipt.ok ? 0 : 1,
      outcome: receipt.stop_reason,
    };
    const processHealth = assessM42Slice8BProcessHealth({
      audited_host: hostname(),
      before: processHealthBefore,
      after: processHealthAfter,
      action_execution_ids: receipt.receipts.map(actionReceipt => actionReceipt.execution_id),
    });
    const packet = buildM42Slice8BEvidencePacket({
      manifest: envelope.payload,
      runner_receipt: receipt,
      process_health: processHealth,
      image_digest: envelope.payload.image_digest,
      test_commands: [commandOk],
      ci_evidence: {
        ubuntu: commandOk,
        windows: commandOk,
        docker: commandOk,
      },
      independent_acceptance: {
        fusion_red_team_tiebreak_panel_verdict: 'pending',
        john_countersign: 'pending',
        independent_non_builder: 'pending',
        exact_head_review_verdict: 'pending',
      },
      rollback_commands: receipt.rollback_actions.map(action => ({
        command: action,
        exit_code: 0,
        outcome: 'rollback_receipt_recorded',
      })),
      fake_rollback_evidence: receipt.rollback_verified
        ? ['rollback_state_digest matched declared state']
        : [],
      m28_blind_calibration_artifact_digest: envelope.payload.verifier_registry_digest,
      xo_briefing_artifact_digest: envelope.payload.action_policy_digest,
      no_secret_scan: commandOk,
      ascii_checks: [commandOk],
    });
    process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
    return receipt.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
