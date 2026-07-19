// WO-HARNESS-OVERSEER-STAGING-REFIRE-BRIDGE-01
//
// Negative/idempotency proof for the WO-named staging-refire-bridge facade.
// Exercises the facade entry points (createStagingRefireBridge /
// executeStagingRefire / isStagingRefireTargetAllowed) so the four Section 7
// scenarios are proven THROUGH this WO's named surface, not only through the
// underlying cauldron-refire-bridge modules. The harness mirrors the existing
// cauldron-refire-bridge.test.ts pattern (fake admitRun / getAdmissionByExecutionId
// / openRefireCircuit) rather than building a second fake-provider harness.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, mock, test } from 'bun:test';
import type { M31ActionPermitV2, M31ActionProposalV2 } from '@archon/core/db/m31-target-v2';
import {
  createStagingRefireBridge,
  executeStagingRefire,
  isStagingRefireTargetAllowed,
} from '../staging-refire-bridge';
import type {
  StagingRefireAdmissionDepsV1,
  StagingRefireAdmissionRequestV1,
  StagingRefireAdmissionResultV1,
  StagingRefireExecutionDepsV1,
  StagingRefireTargetV1,
  StagingRefireRegisteredWorkloadV1,
} from '../staging-refire-bridge';
import type { OverseerActionPolicyRegistry } from '../policy-registry';
import type { SandboxExecutionContextV1 } from '../adapters/sandbox-types';

const OWNER = 'bluedevilcollectibles';
const REPOSITORY = 'bdc-harness';
const FULL_NAME = `${OWNER}/${REPOSITORY}`;
const PROVIDER_REPOSITORY_ID = 'R_sandbox_staging_refire';
const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const POLICY_DIGEST = H('policy');
const REGISTRY_DIGEST = H('registry');
const VERIFIER_DIGEST = H('verifier');
const CANDIDATE_DIGEST = H('candidate');
const SYNTHETIC_WO = 'WO-SYNTHETIC-CAULDRON-REFIRE';
const WORKFLOW_NAME = 'overseer-sandbox-refire';

function H(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stagingTarget(overrides: Partial<StagingRefireTargetV1> = {}): StagingRefireTargetV1 {
  return {
    environment: 'staging',
    archon: 'staging',
    event_store: 'staging',
    worktree: 'staging',
    credential: 'staging',
    ...overrides,
  };
}

function registeredWorkload(
  overrides: Partial<StagingRefireRegisteredWorkloadV1> = {}
): StagingRefireRegisteredWorkloadV1 {
  return {
    synthetic_wo_id: SYNTHETIC_WO,
    workflow_name: WORKFLOW_NAME,
    ...overrides,
  };
}

function proposalAndPermit(): {
  readonly proposal: M31ActionProposalV2;
  readonly permit: M31ActionPermitV2;
} {
  const target = {
    target_kind: 'workflow_run' as const,
    repository: FULL_NAME,
    run_id: 'failed-run-1',
    wo_id: 'WO-ORIGINAL-FAILED-01',
    workflow_name: 'implement',
    codebase_id: 'codebase-bdc-harness',
    status: 'failed',
    event_tip: H('event-tip'),
    head_sha: HEAD,
    base_sha: BASE,
  };
  const proposal: M31ActionProposalV2 = {
    proposal_id: 'proposal-staging-refire-1',
    repository: FULL_NAME,
    target,
    target_key: `${FULL_NAME}#workflow_run:failed-run-1`,
    target_digest: H('target'),
    snapshot_id: 'snapshot-staging-refire-1',
    evidence_path: 'evidence/staging-refire.json',
    evidence_git_blob: 'c'.repeat(40),
    action_kind: 'REFIRE',
    action_parameters: { synthetic_wo_id: SYNTHETIC_WO, workflow_name: WORKFLOW_NAME },
    actor: 'xo',
    created_at: '2026-07-17T12:00:00.000Z',
    expires_at: '2026-07-17T12:15:00.000Z',
    execution_id: 'execution-staging-refire-1',
    capability: 'overseer.m31.refire',
    policy_digest: POLICY_DIGEST,
    verifier_registry_digest: VERIFIER_DIGEST,
  };
  const permit: M31ActionPermitV2 = {
    permit_id: 'permit-staging-refire-1',
    proposal_id: proposal.proposal_id,
    execution_id: proposal.execution_id,
    repository: FULL_NAME,
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

function context(overrides: Partial<SandboxExecutionContextV1> = {}): {
  readonly context: SandboxExecutionContextV1;
  readonly permit: M31ActionPermitV2;
} {
  const { proposal, permit } = proposalAndPermit();
  const registry: OverseerActionPolicyRegistry = {
    schema_version: 'overseer-action-policy-v1',
    entries: [],
  };
  const base: SandboxExecutionContextV1 = {
    schema_version: 'overseer-sandbox-execution-context-v1',
    mode: 'sandbox',
    frozen_authorization_carried: true,
    repository: {
      provider_repository_id: PROVIDER_REPOSITORY_ID,
      full_name: FULL_NAME,
      owner: OWNER,
      repository: REPOSITORY,
    },
    action_policy_registry: registry,
    action_policy_registry_digest: REGISTRY_DIGEST,
    expected_action_policy_registry_digest: REGISTRY_DIGEST,
    credential_principal: 'sandbox-principal',
    resulting_deployment_effect: 'none',
    target_classifications: ['sandbox'],
    pull_request_number: 0,
    base_branch: 'dev',
    base_sha: BASE,
    head_sha: HEAD,
    candidate_digest: CANDIDATE_DIGEST,
    expected_policy_digest: POLICY_DIGEST,
    expected_verifier_registry_digest: VERIFIER_DIGEST,
    expected_principal: 'sandbox-principal',
    expected_repository_full_name: FULL_NAME,
    expected_provider_repository_id: PROVIDER_REPOSITORY_ID,
    observation: {
      provider_repository_id: PROVIDER_REPOSITORY_ID,
      repository_full_name: FULL_NAME,
      pull_request_number: 0,
      base_branch: 'dev',
      base_sha: BASE,
      head_sha: HEAD,
      candidate_digest: CANDIDATE_DIGEST,
      policy_digest: POLICY_DIGEST,
      verifier_registry_digest: VERIFIER_DIGEST,
      observed_at: '2026-07-17T12:01:00.000Z',
    },
    proposal,
    authorization_deps: {
      getPolicy: async () => ({
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
      getCapabilityState: async () => ({
        capability: 'repair',
        action_enabled: true,
        circuit_state: 'closed',
        circuit_reason: null,
        circuit_opened_at: null,
        policy_digest: POLICY_DIGEST,
        verifier_registry_digest: VERIFIER_DIGEST,
        updated_at: '2026-07-17T12:00:00.000Z',
        updated_by: 'board',
      }),
      getProposal: async () => proposal,
      getCurrentTime: async () => '2026-07-17T12:01:00.000Z',
      recordDecision: async () => undefined,
    },
    actor: 'xo',
    correlation_id: 'corr-staging-refire',
    replay: { replay_key: proposal.execution_id, consume: async () => true },
    provider: {
      refreshPullRequest: async () => ({ ok: true, external_effect_reference: 'unused' }),
      closePullRequest: async () => ({ ok: true, external_effect_reference: 'unused' }),
      reopenPullRequest: async () => ({ ok: true, external_effect_reference: 'unused' }),
      mergePullRequest: async () => ({ ok: true, external_effect_reference: 'unused' }),
    },
  };
  return { context: { ...base, ...overrides }, permit };
}

interface Harness {
  readonly deps: StagingRefireExecutionDepsV1;
  readonly admissionRequests: StagingRefireAdmissionRequestV1[];
  readonly spies: {
    readonly admitRun: ReturnType<typeof mock>;
    readonly getAdmissionByExecutionId: ReturnType<typeof mock>;
    readonly openRefireCircuit: ReturnType<typeof mock>;
  };
}

function makeHarness(admissionResult?: StagingRefireAdmissionResultV1): Harness {
  const admissionRequests: StagingRefireAdmissionRequestV1[] = [];
  const receipts = new Map<string, { digest: string; receipt?: unknown }>();
  const admittedByExecution = new Map<string, StagingRefireAdmissionResultV1>();

  const admitRun = mock(async (request: StagingRefireAdmissionRequestV1) => {
    admissionRequests.push(request);
    const result =
      admissionResult ??
      ({
        status: 'admitted',
        runId: 'staging-run-1',
        providerRequestId: 'staging-run-1',
        admittedAt: '2026-07-17T12:02:00.000Z',
        bindingEvidence: request.inputs,
        reason: 'accepted',
      } satisfies StagingRefireAdmissionResultV1);
    admittedByExecution.set(request.inputs.execution_id, result);
    return result;
  });
  const getAdmissionByExecutionId = mock(async (executionId: string) => {
    return admittedByExecution.get(executionId) ?? null;
  });
  const openRefireCircuit = mock(async () => undefined);
  const gate = {
    preparePermit: mock(async () => ({ ok: true, reason: 'ok' })),
    authorizeAction: mock(async () => ({ allowed: true, reason: 'allowed' })),
    reserveEffect: mock(async () => ({ ok: true, reason: 'ok' })),
    appendOutcome: mock(async () => ({ ok: true })),
  };
  const adapter = createStagingRefireBridge({
    admitRun,
    getAdmissionByExecutionId,
  } satisfies StagingRefireAdmissionDepsV1);
  return {
    deps: {
      gate,
      adapter,
      idempotency: {
        begin: mock(async (executionId: string, digest: string) => {
          const existing = receipts.get(executionId);
          if (!existing) {
            receipts.set(executionId, { digest });
            return { status: 'fresh' as const };
          }
          if (existing.digest !== digest) return { status: 'conflict' as const };
          if (existing.receipt) return { status: 'replay' as const, receipt: existing.receipt };
          return { status: 'fresh' as const };
        }),
        commit: mock(async (executionId: string, receipt: unknown) => {
          const existing = receipts.get(executionId);
          if (existing) receipts.set(executionId, { ...existing, receipt });
        }),
      },
      circuit: { openRefireCircuit },
      sha256hex: H,
      now: () => '2026-07-17T12:02:30.000Z',
    },
    admissionRequests,
    spies: { admitRun, getAdmissionByExecutionId, openRefireCircuit },
  };
}

function executeInput(overrides: Partial<Parameters<typeof executeStagingRefire>[0]> = {}) {
  const fixture = context();
  return {
    context: fixture.context,
    permit: fixture.permit,
    registered_workload: registeredWorkload(),
    target: stagingTarget(),
    requested_wo_id: SYNTHETIC_WO,
    requested_workflow_name: WORKFLOW_NAME,
    conversation_id: 'conversation-staging-refire-1',
    message: 'Refire authorized sandbox workload',
    actor: 'xo',
    correlation_id: 'corr-staging-refire',
    ...overrides,
  };
}

describe('staging-refire-bridge', () => {
  // Section 7 Test 1: single admission per execution_id, idempotent on repeat.
  test('single admission per execution_id succeeds and is idempotent on repeat', async () => {
    const harness = makeHarness();
    const input = executeInput();
    const first = await executeStagingRefire(input, harness.deps);
    const second = await executeStagingRefire(input, harness.deps);

    expect(harness.spies.admitRun).toHaveBeenCalledTimes(1);
    expect(first.normalized_outcome).toBe('admitted');
    expect(first.admitted_run_id).toBe('staging-run-1');
    expect(first.provider_request_id).toBe('staging-run-1');
    expect(first.binding_evidence?.repository).toBe(FULL_NAME);
    expect(first.side_effect_count).toBe(1);
    // Second call returns the identical prior receipt (same provider_request_id),
    // NOT a second run.
    expect(second).toEqual(first);
    expect(second.provider_request_id).toBe(first.provider_request_id);
  });

  // Section 7 Test 2: production targets refused before any admission call.
  test('production targets are refused before any admission call', async () => {
    const harness = makeHarness();
    const result = await executeStagingRefire(
      executeInput({
        target: stagingTarget({
          environment: 'production',
          archon: 'production',
          event_store: 'production',
          worktree: 'production',
          credential: 'production',
        }),
      }),
      harness.deps
    );

    expect(result.normalized_outcome).toBe('rejected');
    expect(result.reason).toBe('non_staging_target');
    expect(result.attempted).toBe(false);
    // Refusal happens BEFORE the (fake) staging Cauldron admission call.
    expect(harness.spies.admitRun).toHaveBeenCalledTimes(0);
  });

  // Section 7 Test 3: timeout/indeterminate requires reconciliation, no blind retry.
  test('timeout admission requires reconciliation and issues no blind second run', async () => {
    const harness = makeHarness({
      status: 'timeout',
      runId: null,
      providerRequestId: 'admission-request-1',
      admittedAt: null,
      bindingEvidence: null,
      reason: 'timed out waiting for admission',
    });
    const input = executeInput();
    const first = await executeStagingRefire(input, harness.deps);
    const second = await executeStagingRefire(input, harness.deps);

    expect(first.normalized_outcome).toBe('reconciliation_required');
    expect(first.reason).toBe('admission_timeout');
    expect(first.circuit_breaker_opened).toBe(true);
    // No automatic retry: exactly one admission attempt, one circuit breaker open.
    expect(harness.spies.admitRun).toHaveBeenCalledTimes(1);
    expect(harness.spies.openRefireCircuit).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  // Section 7 Test 4: named synthetic WO/workflow allowlist enforced.
  test('unregistered synthetic WO or workflow name is rejected before admission', async () => {
    const harness = makeHarness();
    const wrongWo = await executeStagingRefire(
      executeInput({ requested_wo_id: 'WO-NOT-REGISTERED' }),
      harness.deps
    );
    const wrongWorkflow = await executeStagingRefire(
      executeInput({ requested_workflow_name: 'not-registered-workflow' }),
      harness.deps
    );

    expect(wrongWo.reason).toBe('unregistered_workload');
    expect(wrongWo.normalized_outcome).toBe('rejected');
    expect(wrongWorkflow.reason).toBe('unregistered_workload');
    expect(harness.spies.admitRun).toHaveBeenCalledTimes(0);
  });

  // Binding preservation: exact repository/target binding flows through admission.
  test('original WO scope and exact repository binding are preserved through admission', async () => {
    const harness = makeHarness();
    const input = executeInput();
    await executeStagingRefire(input, harness.deps);

    expect(harness.admissionRequests).toHaveLength(1);
    const request = harness.admissionRequests[0];
    expect(request?.workflowName).toBe(WORKFLOW_NAME);
    expect(request?.inputs.repository).toBe(input.context.proposal.repository);
    expect(request?.inputs.requested_wo_id).toBe(SYNTHETIC_WO);
    expect(request?.inputs.original_target_key).toBe(input.context.proposal.target_key);
    expect(request?.inputs.original_target_digest).toBe(input.context.proposal.target_digest);
    expect(request?.inputs.base_sha).toBe(BASE);
    expect(request?.inputs.head_sha).toBe(HEAD);
  });

  // Production-refusal predicate is exposed and fails closed on any non-staging facet.
  test('isStagingRefireTargetAllowed refuses any production facet', () => {
    expect(isStagingRefireTargetAllowed(stagingTarget())).toBe(true);
    expect(isStagingRefireTargetAllowed(stagingTarget({ archon: 'production' }))).toBe(false);
    expect(isStagingRefireTargetAllowed(stagingTarget({ event_store: 'production' }))).toBe(false);
    expect(isStagingRefireTargetAllowed(stagingTarget({ worktree: 'production' }))).toBe(false);
    expect(isStagingRefireTargetAllowed(stagingTarget({ credential: 'production' }))).toBe(false);
    expect(isStagingRefireTargetAllowed(stagingTarget({ environment: 'unknown' }))).toBe(false);
  });

  // Operator fire path unchanged, by construction: the facade never imports the
  // server package or a live operator fire-path module.
  test('facade keeps the operator fire path unchanged by avoiding server imports', () => {
    const facadeSource = readFileSync(
      new URL('../staging-refire-bridge.ts', import.meta.url),
      'utf8'
    );
    expect(facadeSource).not.toContain('packages/server');
    expect(facadeSource).not.toContain('@archon/server');
  });
});
