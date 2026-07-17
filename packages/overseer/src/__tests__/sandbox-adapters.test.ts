import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { OverseerCapability, OverseerCapabilityState } from '@archon/core/db/overseer-capabilities';
import type { M31ActionKind, M31ActionPermitV2, M31ActionProposalV2 } from '@archon/core/db/m31-target-v2';
import { closeSandboxPullRequest } from '../adapters/sandbox-close';
import { mergeSandboxPullRequest } from '../adapters/sandbox-merge';
import { refreshSandboxPullRequest } from '../adapters/sandbox-refresh';
import { computePolicyTupleDigest, type OverseerActionPolicyRegistry } from '../policy-registry';
import type {
  SandboxExecutionContextV1,
  SandboxExecutionModeV1,
  SandboxProviderMutationDepsV1,
} from '../adapters/sandbox-types';
import type { OverseerActionPolicy } from '../action-policy';
import type { OverseerSalvageReceiptV1 } from '../actions/lifecycle';

const H = (value: string): string => createHash('sha256').update(value).digest('hex');
const OWNER = 'bluedevilcollectibles';
const REPOSITORY = 'bdc-harness';
const FULL_NAME = `${OWNER}/${REPOSITORY}`;
const PROVIDER_REPOSITORY_ID = 'R_sandbox_123';
const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const REGISTRY_DIGEST = H('registry');
const VERIFIER_DIGEST = H('verifier');
const CANDIDATE_DIGEST = H('candidate');

function capabilityFor(actionKind: M31ActionKind): OverseerCapability {
  if (actionKind === 'MERGE') return 'merge';
  if (actionKind === 'REFRESH') return 'branch';
  return 'lifecycle';
}

function registryFor(actionKind: M31ActionKind, repository = REPOSITORY): OverseerActionPolicyRegistry {
  const tuple = {
    owner: OWNER,
    repository,
    base_branch: 'dev',
    resulting_deployment_effect: 'none' as const,
    allowed_action_kinds: [actionKind],
    credential_principal: 'sandbox-principal',
  };
  return {
    schema_version: 'overseer-action-policy-v1',
    entries: [{ ...tuple, policy_digest: computePolicyTupleDigest(tuple) }],
  };
}

function shippedEmptyRegistry(): OverseerActionPolicyRegistry {
  return { schema_version: 'overseer-action-policy-v1', entries: [] };
}

function providerCounter(): {
  readonly deps: SandboxProviderMutationDepsV1;
  readonly calls: () => number;
} {
  let count = 0;
  const ok = async () => {
    count += 1;
    return { ok: true as const, external_effect_reference: `fake-effect-${count}` };
  };
  return {
    deps: {
      refreshPullRequest: ok,
      closePullRequest: ok,
      reopenPullRequest: ok,
      mergePullRequest: ok,
    },
    calls: () => count,
  };
}

function proposalAndPermit(actionKind: M31ActionKind): {
  readonly proposal: M31ActionProposalV2;
  readonly permit: M31ActionPermitV2;
} {
  const target = {
    target_kind: 'pull_request' as const,
    repository: FULL_NAME,
    pr_number: 42,
    provider_node_id: 'PR_node',
    head_sha: HEAD,
    base_branch: 'dev',
    base_sha: BASE,
    state: 'open',
    updated_at: '2026-07-17T12:00:00.000Z',
  };
  const policyDigest = registryFor(actionKind).entries[0]?.policy_digest ?? H('missing');
  const capability = `overseer.m31.${actionKind.toLowerCase()}`;
  const proposal: M31ActionProposalV2 = {
    proposal_id: `proposal-${actionKind}`,
    repository: FULL_NAME,
    target,
    target_key: `${FULL_NAME}#pull_request:42`,
    target_digest: H(`target-${actionKind}`),
    snapshot_id: `snapshot-${actionKind}`,
    evidence_path: `evidence/${actionKind}.json`,
    evidence_git_blob: 'c'.repeat(40),
    action_kind: actionKind,
    action_parameters: {},
    actor: 'xo',
    created_at: '2026-07-17T12:00:00.000Z',
    expires_at: '2026-07-17T12:15:00.000Z',
    execution_id: `execution-${actionKind}`,
    capability,
    policy_digest: policyDigest,
    verifier_registry_digest: VERIFIER_DIGEST,
  };
  const permit: M31ActionPermitV2 = {
    permit_id: `permit-${actionKind}`,
    proposal_id: proposal.proposal_id,
    execution_id: proposal.execution_id,
    repository: FULL_NAME,
    target,
    target_key: proposal.target_key,
    target_digest: proposal.target_digest,
    snapshot_id: proposal.snapshot_id,
    action_kind: actionKind,
    capability,
    issued_at: '2026-07-17T12:00:00.000Z',
    valid_until: '2026-07-17T12:10:00.000Z',
  };
  return { proposal, permit };
}

function policy(capability: OverseerCapability): OverseerActionPolicy {
  return {
    service_enabled: true,
    emergency_stop: false,
    legacy_dry_run: false,
    capability_flags: {
      escalation: false,
      repair: false,
      branch: capability === 'branch',
      lifecycle: capability === 'lifecycle',
      merge: capability === 'merge',
    },
  };
}

function state(capability: OverseerCapability, policyDigest: string): OverseerCapabilityState {
  return {
    capability,
    action_enabled: true,
    circuit_state: 'closed',
    circuit_reason: null,
    circuit_opened_at: null,
    policy_digest: policyDigest,
    verifier_registry_digest: VERIFIER_DIGEST,
    updated_at: '2026-07-17T12:00:00.000Z',
    updated_by: 'board',
  };
}

function context(
  actionKind: M31ActionKind,
  overrides: Partial<SandboxExecutionContextV1> = {}
): {
  readonly context: SandboxExecutionContextV1;
  readonly permit: M31ActionPermitV2;
  readonly calls: () => number;
} {
  const { proposal, permit } = proposalAndPermit(actionKind);
  const capability = capabilityFor(actionKind);
  const registry = registryFor(actionKind);
  const provider = providerCounter();
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
    pull_request_number: 42,
    base_branch: 'dev',
    base_sha: BASE,
    head_sha: HEAD,
    candidate_digest: CANDIDATE_DIGEST,
    expected_policy_digest: proposal.policy_digest,
    expected_verifier_registry_digest: VERIFIER_DIGEST,
    expected_principal: 'sandbox-principal',
    expected_repository_full_name: FULL_NAME,
    expected_provider_repository_id: PROVIDER_REPOSITORY_ID,
    observation: {
      provider_repository_id: PROVIDER_REPOSITORY_ID,
      repository_full_name: FULL_NAME,
      pull_request_number: 42,
      base_branch: 'dev',
      base_sha: BASE,
      head_sha: HEAD,
      candidate_digest: CANDIDATE_DIGEST,
      policy_digest: proposal.policy_digest,
      verifier_registry_digest: VERIFIER_DIGEST,
      observed_at: '2026-07-17T12:00:00.000Z',
    },
    proposal,
    authorization_deps: {
      getPolicy: async () => policy(capability),
      getCapabilityState: async () => state(capability, proposal.policy_digest),
      getProposal: async () => proposal,
      getCurrentTime: async () => '2026-07-17T12:01:00.000Z',
      recordDecision: async () => undefined,
    },
    actor: 'xo',
    correlation_id: 'corr',
    replay: {
      replay_key: permit.execution_id,
      consume: async () => true,
    },
    provider: provider.deps,
  };
  return { context: { ...base, ...overrides }, permit, calls: provider.calls };
}

function salvageReceipt(): OverseerSalvageReceiptV1 {
  return {
    schema_version: 'overseer-salvage-receipt-v1',
    repository: FULL_NAME,
    wo_id: 'WO-1',
    source_target_kind: 'pull_request',
    source_target_key: `${FULL_NAME}#pull_request:42`,
    source_target_digest: H('target-CLOSE'),
    source_run_id: null,
    worktree_path: '/tmp/worktree',
    artifact_kind: 'patch',
    git_object_format: null,
    git_object_id: null,
    patch_path: 'salvage.patch',
    patch_sha256: H('patch'),
    scope_digest: H('scope'),
    captured_at: '2026-07-17T12:00:00.000Z',
    verified_at: '2026-07-17T12:00:00.000Z',
  };
}

describe('sandbox GitHub mutation adapters', () => {
  test('token present + mode none => zero provider calls', async () => {
    const old = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'present-but-not-authority';
    try {
      const fixture = context('REFRESH', { mode: 'none' as SandboxExecutionModeV1 });
      const result = await refreshSandboxPullRequest(fixture.context, fixture.permit);
      expect(result.reason).toBe('mode_not_sandbox');
      expect(fixture.calls()).toBe(0);
    } finally {
      process.env.GITHUB_TOKEN = old;
    }
  });

  test('token present + mode fake => zero provider calls', async () => {
    const old = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'present-but-not-authority';
    try {
      const fixture = context('MERGE', { mode: 'fake' as SandboxExecutionModeV1 });
      const result = await mergeSandboxPullRequest(fixture.context, fixture.permit);
      expect(result.reason).toBe('mode_not_sandbox');
      expect(fixture.calls()).toBe(0);
    } finally {
      process.env.GH_TOKEN = old;
    }
  });

  test('mode sandbox without carried frozen authorization => zero calls', async () => {
    const fixture = context('MERGE', { frozen_authorization_carried: false });
    const result = await mergeSandboxPullRequest(fixture.context, fixture.permit);
    expect(result.reason).toBe('authorization_not_carried');
    expect(fixture.calls()).toBe(0);
  });

  test('wrong repository full name OR wrong immutable ID => zero calls', async () => {
    const wrongName = context('REFRESH', { expected_repository_full_name: 'other/repo' });
    expect((await refreshSandboxPullRequest(wrongName.context, wrongName.permit)).reason).toBe(
      'repository_identity_mismatch'
    );
    expect(wrongName.calls()).toBe(0);

    const wrongId = context('REFRESH', { expected_provider_repository_id: 'R_wrong' });
    expect((await refreshSandboxPullRequest(wrongId.context, wrongId.permit)).reason).toBe(
      'repository_identity_mismatch'
    );
    expect(wrongId.calls()).toBe(0);
  });

  test('broader credential reach does not expand the policy allowlist', async () => {
    const fixture = context('MERGE', {
      action_policy_registry: shippedEmptyRegistry(),
      credential_principal: 'sandbox-principal-with-broad-access',
      expected_principal: 'sandbox-principal-with-broad-access',
    });
    const result = await mergeSandboxPullRequest(fixture.context, fixture.permit);
    expect(result.reason).toBe('repository_not_allowlisted');
    expect(fixture.calls()).toBe(0);
  });

  test('wrong base/head/candidate/policy digest/registry digest/principal => zero calls', async () => {
    const cases: Partial<SandboxExecutionContextV1>[] = [
      { base_sha: H('wrong-base').slice(0, 40) },
      { head_sha: H('wrong-head').slice(0, 40) },
      { candidate_digest: H('wrong-candidate') },
      { expected_policy_digest: H('wrong-policy') },
      { expected_action_policy_registry_digest: H('wrong-registry') },
      { expected_principal: 'other-principal' },
    ];
    for (const overrides of cases) {
      const fixture = context('MERGE', overrides);
      const result = await mergeSandboxPullRequest(fixture.context, fixture.permit);
      expect(result.accepted).toBe(false);
      expect(fixture.calls()).toBe(0);
    }
  });

  test('stale, replayed, expired, duplicate, or conflicting execution => zero additional calls', async () => {
    const stale = context('MERGE', {
      observation: { ...context('MERGE').context.observation, base_sha: H('stale').slice(0, 40) },
    });
    expect((await mergeSandboxPullRequest(stale.context, stale.permit)).accepted).toBe(false);
    expect(stale.calls()).toBe(0);

    const replayed = context('MERGE', {
      replay: { replay_key: 'r', consume: async () => false },
    });
    expect((await mergeSandboxPullRequest(replayed.context, replayed.permit)).reason).toBe(
      'execution_replayed'
    );
    expect(replayed.calls()).toBe(0);

    const expired = context('MERGE', {
      authorization_deps: {
        ...context('MERGE').context.authorization_deps,
        getCurrentTime: async () => '2026-07-17T12:30:00.000Z',
      },
    });
    expect((await mergeSandboxPullRequest(expired.context, expired.permit)).reason).toBe(
      'authorization_denied'
    );
    expect(expired.calls()).toBe(0);

    let consumed = false;
    const duplicate = context('MERGE', {
      replay: {
        replay_key: 'duplicate',
        consume: async () => {
          if (consumed) return false;
          consumed = true;
          return true;
        },
      },
    });
    expect((await mergeSandboxPullRequest(duplicate.context, duplicate.permit)).accepted).toBe(true);
    expect(duplicate.calls()).toBe(1);
    expect((await mergeSandboxPullRequest(duplicate.context, duplicate.permit)).reason).toBe(
      'execution_replayed'
    );
    expect(duplicate.calls()).toBe(1);

    const conflicting = context('MERGE');
    const conflictPermit = { ...conflicting.permit, action_kind: 'REFRESH' as const };
    expect((await mergeSandboxPullRequest(conflicting.context, conflictPermit)).accepted).toBe(false);
    expect(conflicting.calls()).toBe(0);
  });

  test('production-effect classification blocks before provider dispatch', async () => {
    const fixture = context('MERGE', {
      target_classifications: ['sandbox', 'production_effect'],
    });
    const result = await mergeSandboxPullRequest(fixture.context, fixture.permit);
    expect(result.reason).toBe('protected_target');
    expect(fixture.calls()).toBe(0);
  });

  test('close preserves salvage evidence and emits a deterministic reopen recipe', async () => {
    const fixture = context('CLOSE');
    const result = await closeSandboxPullRequest({
      context: fixture.context,
      permit: fixture.permit,
      salvage_receipt: salvageReceipt(),
      salvage_deps: {
        artifactExists: async () => true,
        digestPatch: async () => H('patch'),
      },
      required_observation_digest: H('false-observation'),
      action_parameters_digest: H('close-parameters'),
    });
    expect(result.accepted).toBe(true);
    expect(result.mutation_sent).toBe(true);
    expect(result.reopen_recipe).toEqual({
      schema_version: 'overseer-lifecycle-reopen-recipe-v1',
      target: {
        repository: FULL_NAME,
        target_kind: 'pull_request',
        target_key: fixture.context.proposal.target_key,
        target_digest: fixture.context.proposal.target_digest,
        snapshot_id: fixture.context.proposal.snapshot_id,
        target: fixture.context.proposal.target,
      },
      prior_proposal_id: fixture.permit.proposal_id,
      prior_execution_id: fixture.permit.execution_id,
      required_observation_digest: H('false-observation'),
      inverse_provider_action: 'REOPEN',
      action_parameters_digest: H('close-parameters'),
    });
    expect(fixture.calls()).toBe(1);
  });
});
