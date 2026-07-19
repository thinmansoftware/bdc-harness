import { createHash } from 'node:crypto';
import type {
  M31ActionPermitV2,
  M31ActionProposalV2,
} from '@archon/core/db/m31-target-v2';
import type { OverseerCapabilityState } from '@archon/core/db/overseer-capabilities';
import type { OverseerActionPolicy } from './action-policy';
import type { AuthorizeOverseerActionV2Deps } from './action-policy-v2';
import {
  executeCauldronRefireBridge,
  type CauldronRefireBridgeExecutionDeps,
  type CauldronRefireBridgeReceiptV1,
} from './actions/cauldron-refire-bridge';
import { createCauldronRefireBridgeAdapter } from './adapters/cauldron-refire-bridge';
import type {
  CauldronAdmissionRequestV1,
  CauldronAdmissionResultV1,
  CauldronAdmissionTargetV1,
  CauldronRegisteredWorkloadV1,
} from './adapters/cauldron-refire-bridge';
import type {
  SandboxExecutionContextV1,
  SandboxProviderMutationDepsV1,
  SandboxProviderMutationResultV1,
  SandboxRepositoryIdentityV1,
} from './adapters/sandbox-types';
import type { M42Slice8BManifestPayload } from './m42-slice8b-manifest';

export interface M42Slice8BStagingRefireBridgeOptions {
  readonly admitRun?: (request: CauldronAdmissionRequestV1) => Promise<CauldronAdmissionResultV1>;
  readonly getAdmissionByExecutionId?: (
    executionId: string
  ) => Promise<CauldronAdmissionResultV1 | null>;
  readonly gate?: Partial<CauldronRefireBridgeExecutionDeps['gate']>;
  readonly idempotency?: Partial<CauldronRefireBridgeExecutionDeps['idempotency']>;
  readonly circuit?: Partial<CauldronRefireBridgeExecutionDeps['circuit']>;
  readonly target?: CauldronAdmissionTargetV1;
  readonly registered_workload?: CauldronRegisteredWorkloadV1;
  readonly requested_wo_id?: string;
  readonly requested_workflow_name?: string;
  readonly conversation_id?: string;
  readonly message?: string;
  readonly actor?: string;
  readonly correlation_id?: string;
  readonly now?: () => string;
  readonly sha256hex?: (input: string) => string;
}

export async function executeM42Slice8BStagingRefireBridge(
  manifest: M42Slice8BManifestPayload,
  executionId: string,
  options: M42Slice8BStagingRefireBridgeOptions = {}
): Promise<CauldronRefireBridgeReceiptV1> {
  const fixture = cauldronFixture(manifest, executionId);
  const adapter = createCauldronRefireBridgeAdapter({
    admitRun:
      options.admitRun ??
      (async request => ({
        status: 'admitted',
        runId: 'fake-staging-refire-1',
        providerRequestId: 'fake-staging-refire-1',
        admittedAt: '2026-07-17T12:02:00.000Z',
        bindingEvidence: request.inputs,
        reason: 'accepted',
      })),
    getAdmissionByExecutionId: options.getAdmissionByExecutionId ?? (async () => null),
  });

  return executeCauldronRefireBridge(
    {
      context: fixture.context,
      permit: fixture.permit,
      registered_workload: options.registered_workload ?? registeredWorkload(),
      target: options.target ?? stagingTarget(),
      requested_wo_id: options.requested_wo_id ?? 'WO-SYNTHETIC-M42-SLICE8B-REFIRE',
      requested_workflow_name: options.requested_workflow_name ?? 'overseer-sandbox-refire',
      conversation_id: options.conversation_id ?? 'conversation-m42-slice8b-refire',
      message: options.message ?? 'Fake-mode M-42 Slice 8B staging refire admission',
      actor: options.actor ?? 'xo',
      correlation_id: options.correlation_id ?? `corr-${executionId}`,
    },
    {
      gate: {
        preparePermit: options.gate?.preparePermit ?? (async () => ({ ok: true, reason: 'ok' })),
        authorizeAction:
          options.gate?.authorizeAction ?? (async () => ({ allowed: true, reason: 'allowed' })),
        reserveEffect: options.gate?.reserveEffect ?? (async () => ({ ok: true, reason: 'ok' })),
        appendOutcome: options.gate?.appendOutcome ?? (async () => ({ ok: true })),
      },
      adapter,
      idempotency: {
        begin: options.idempotency?.begin ?? (async () => ({ status: 'fresh' as const })),
        commit: options.idempotency?.commit ?? (async () => undefined),
      },
      circuit: {
        openRefireCircuit: options.circuit?.openRefireCircuit ?? (async () => undefined),
      },
      sha256hex: options.sha256hex ?? hex,
      now: options.now ?? (() => '2026-07-17T12:02:30.000Z'),
    }
  );
}

function cauldronFixture(
  manifest: M42Slice8BManifestPayload,
  executionId: string
): { readonly context: SandboxExecutionContextV1; readonly permit: M31ActionPermitV2 } {
  const { proposal, permit } = proposalAndPermit(manifest, executionId);
  const context: SandboxExecutionContextV1 = {
    schema_version: 'overseer-sandbox-execution-context-v1',
    mode: 'sandbox',
    frozen_authorization_carried: true,
    repository: repositoryIdentity(manifest),
    action_policy_registry: { schema_version: 'overseer-action-policy-v1', entries: [] },
    action_policy_registry_digest: manifest.action_policy_digest,
    expected_action_policy_registry_digest: manifest.action_policy_digest,
    credential_principal: manifest.credential_principal_id,
    resulting_deployment_effect: 'none',
    target_classifications: ['sandbox'],
    pull_request_number: 0,
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
      pull_request_number: 0,
      base_branch: 'dev',
      base_sha: manifest.starting_sha,
      head_sha: manifest.candidate_sha,
      candidate_digest: manifest.image_digest,
      policy_digest: proposal.policy_digest,
      verifier_registry_digest: hexDigest(manifest.verifier_registry_digest),
      observed_at: '2026-07-17T12:01:00.000Z',
    },
    proposal,
    authorization_deps: authorizationDeps(proposal),
    actor: 'xo',
    correlation_id: `corr-${executionId}`,
    replay: { replay_key: executionId, consume: async () => true },
    provider: fakeSandboxProvider(),
  };
  return { context, permit };
}

function proposalAndPermit(
  manifest: M42Slice8BManifestPayload,
  executionId: string
): { readonly proposal: M31ActionProposalV2; readonly permit: M31ActionPermitV2 } {
  const target = {
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
    target_key: `${manifest.repository_full_name}#workflow_run:42`,
    target_digest: hex(`target-${executionId}`),
    snapshot_id: `snapshot-${executionId}`,
    evidence_path: `evidence/${executionId}.json`,
    evidence_git_blob: 'c'.repeat(40),
    action_kind: 'REFIRE',
    action_parameters: {},
    actor: 'xo',
    created_at: '2026-07-17T12:00:00.000Z',
    expires_at: '2026-07-17T12:15:00.000Z',
    execution_id: executionId,
    capability: 'overseer.m31.refire',
    policy_digest: hex('m42-slice8b-refire-policy'),
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
    action_kind: proposal.action_kind,
    capability: proposal.capability,
    issued_at: '2026-07-17T12:00:30.000Z',
    valid_until: '2026-07-17T12:10:00.000Z',
  };
  return { proposal, permit };
}

function authorizationDeps(proposal: M31ActionProposalV2): AuthorizeOverseerActionV2Deps {
  return {
    getPolicy: async (): Promise<OverseerActionPolicy> => ({
      service_enabled: true,
      emergency_stop: false,
      legacy_dry_run: false,
      capability_flags: {
        escalation: false,
        repair: true,
        branch: false,
        lifecycle: false,
        merge: false,
      },
    }),
    getCapabilityState: async (): Promise<OverseerCapabilityState> => ({
      capability: 'repair',
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

function registeredWorkload(): CauldronRegisteredWorkloadV1 {
  return {
    synthetic_wo_id: 'WO-SYNTHETIC-M42-SLICE8B-REFIRE',
    workflow_name: 'overseer-sandbox-refire',
  };
}

function stagingTarget(): CauldronAdmissionTargetV1 {
  return {
    environment: 'staging',
    archon: 'staging',
    event_store: 'staging',
    worktree: 'staging',
    credential: 'staging',
  };
}

function hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hexDigest(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}
