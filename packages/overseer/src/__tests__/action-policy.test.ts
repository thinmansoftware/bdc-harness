import { describe, expect, mock, test } from 'bun:test';
import type {
  AppendOverseerCapabilityEventInput,
  OverseerCapability,
  OverseerCapabilityState,
} from '@archon/core/db/overseer-capabilities';
import type { M31ActionKind, M31ActionPermit, M31ActionProposal } from '../m31-substrate';
import {
  authorizeOverseerAction,
  evaluateActionPolicy,
  type ActionPolicyDecision,
  type ActionPolicyInput,
  type OverseerActionPolicy,
} from '../action-policy';

const POLICY_DIGEST = 'a'.repeat(64);
const VERIFIER_DIGEST = 'b'.repeat(64);
const NOW = '2026-07-15T12:00:00.000Z';

const enabledFlags: Readonly<Record<OverseerCapability, boolean>> = {
  escalation: true,
  repair: true,
  branch: true,
  lifecycle: true,
  merge: true,
};

function policy(overrides: Partial<OverseerActionPolicy> = {}): OverseerActionPolicy {
  return {
    service_enabled: true,
    emergency_stop: false,
    legacy_dry_run: false,
    capability_flags: enabledFlags,
    ...overrides,
  };
}

function proposal(overrides: Partial<M31ActionProposal> = {}): M31ActionProposal {
  return {
    proposal_id: 'proposal-1',
    repository: 'bluedevilcollectibles/bdc-harness',
    pr_number: 42,
    head_sha: 'c'.repeat(40),
    base_branch: 'dev',
    base_sha: 'd'.repeat(40),
    snapshot_id: 'snapshot-1',
    evidence_path: 'artifacts/proposal.json',
    evidence_git_blob: 'e'.repeat(40),
    action_kind: 'MERGE',
    action_parameters: {},
    actor: 'xo-model',
    created_at: '2026-07-15T11:45:00.000Z',
    expires_at: '2026-07-15T12:05:00.000Z',
    execution_id: 'execution-1',
    capability: 'overseer.m31.merge',
    policy_digest: POLICY_DIGEST,
    verifier_registry_digest: VERIFIER_DIGEST,
    ...overrides,
  };
}

function permit(
  boundProposal: M31ActionProposal,
  overrides: Partial<M31ActionPermit> = {}
): M31ActionPermit {
  return {
    permit_id: 'permit-1',
    proposal_id: boundProposal.proposal_id,
    execution_id: boundProposal.execution_id,
    repository: boundProposal.repository,
    pr_number: boundProposal.pr_number,
    head_sha: boundProposal.head_sha,
    base_branch: boundProposal.base_branch,
    base_sha: boundProposal.base_sha,
    snapshot_id: boundProposal.snapshot_id,
    action_kind: boundProposal.action_kind,
    capability: boundProposal.capability,
    issued_at: '2026-07-15T11:59:00.000Z',
    valid_until: '2026-07-15T12:01:00.000Z',
    ...overrides,
  };
}

function state(
  capability: OverseerCapability,
  overrides: Partial<OverseerCapabilityState> = {}
): OverseerCapabilityState {
  return {
    capability,
    action_enabled: true,
    circuit_state: 'closed',
    circuit_reason: null,
    circuit_opened_at: null,
    policy_digest: POLICY_DIGEST,
    verifier_registry_digest: VERIFIER_DIGEST,
    updated_at: '2026-07-15T11:59:30.000Z',
    updated_by: 'test',
    ...overrides,
  };
}

function evaluation(overrides: Partial<ActionPolicyInput> = {}): ActionPolicyInput {
  const boundProposal = proposal();
  return {
    policy: policy(),
    requested_capability: 'merge',
    capability_state: state('merge'),
    proposal: boundProposal,
    permit: permit(boundProposal),
    current_time: NOW,
    ...overrides,
  };
}

function poison(message: string): never {
  throw new Error(message);
}

function expectDenied(decision: ActionPolicyDecision, reason: string): void {
  expect(decision.allowed).toBe(false);
  if (decision.allowed) throw new Error('expected denial');
  expect(decision.reason).toBe(reason);
}

describe('evaluateActionPolicy', () => {
  test('short-circuits gates in the exact fail-closed order', () => {
    const serviceOff = evaluation({
      policy: {
        service_enabled: false,
        get emergency_stop(): boolean {
          return poison('emergency gate must be unreachable');
        },
        legacy_dry_run: false,
        capability_flags: enabledFlags,
      },
    });
    Object.defineProperty(serviceOff, 'capability_state', {
      get: () => poison('state must be unreachable'),
    });
    expectDenied(evaluateActionPolicy(serviceOff), 'service_disabled');

    const emergency = evaluation({
      policy: {
        service_enabled: true,
        emergency_stop: true,
        get legacy_dry_run(): boolean {
          return poison('dry-run gate must be unreachable');
        },
        capability_flags: enabledFlags,
      },
    });
    expectDenied(evaluateActionPolicy(emergency), 'emergency_stop');

    const dryRun = evaluation({
      policy: policy({ legacy_dry_run: true }),
    });
    Object.defineProperty(dryRun.policy, 'capability_flags', {
      get: () => poison('capability flag must be unreachable'),
    });
    expectDenied(evaluateActionPolicy(dryRun), 'legacy_dry_run');

    const flagOff = evaluation({
      policy: policy({ capability_flags: { ...enabledFlags, merge: false } }),
    });
    Object.defineProperty(flagOff, 'capability_state', {
      get: () => poison('state must be unreachable'),
    });
    expectDenied(evaluateActionPolicy(flagOff), 'capability_flag_disabled');

    const stateMissing = evaluation({ capability_state: null });
    Object.defineProperty(stateMissing, 'proposal', {
      get: () => poison('proposal must be unreachable'),
    });
    expectDenied(evaluateActionPolicy(stateMissing), 'capability_state_missing');

    const disabledState = state('merge', { action_enabled: false });
    Object.defineProperty(disabledState, 'circuit_state', {
      get: () => poison('circuit must be unreachable'),
    });
    const persistentOff = evaluation({ capability_state: disabledState });
    Object.defineProperty(persistentOff, 'proposal', {
      get: () => poison('proposal must be unreachable'),
    });
    expectDenied(evaluateActionPolicy(persistentOff), 'capability_state_disabled');

    const circuitOpen = evaluation({
      capability_state: state('merge', { circuit_state: 'open' }),
    });
    Object.defineProperty(circuitOpen, 'proposal', {
      get: () => poison('identity must be unreachable'),
    });
    expectDenied(evaluateActionPolicy(circuitOpen), 'circuit_open');

    const identityMismatch = evaluation();
    const mismatched = proposal({ proposal_id: 'different-proposal' });
    identityMismatch.proposal = mismatched;
    Object.defineProperty(
      identityMismatch.capability_state as OverseerCapabilityState,
      'policy_digest',
      {
        get: () => poison('digest comparison must be unreachable'),
      }
    );
    expectDenied(evaluateActionPolicy(identityMismatch), 'proposal_id_mismatch');
  });

  test.each([
    ['escalation', 'MERGE'],
    ['repair', 'REPAIR'],
    ['branch', 'REBASE'],
    ['lifecycle', 'COMMENT'],
    ['merge', 'MERGE'],
  ] as const)('keeps the %s circuit independent', (capability, actionKind) => {
    const boundProposal = proposal({
      action_kind: actionKind,
      capability: `overseer.m31.${actionKind.toLowerCase()}`,
    });
    const decision = evaluateActionPolicy({
      policy: policy(),
      requested_capability: capability,
      capability_state: state(capability, { circuit_state: 'open' }),
      proposal: boundProposal,
      permit: permit(boundProposal),
      current_time: NOW,
    });
    expectDenied(decision, 'circuit_open');
  });

  test.each(['escalation', 'repair', 'branch', 'lifecycle', 'merge'] as const)(
    'checks the %s coarse flag before persistent state',
    capability => {
      const input = evaluation({
        requested_capability: capability,
        policy: policy({ capability_flags: { ...enabledFlags, [capability]: false } }),
      });
      Object.defineProperty(input, 'capability_state', {
        get: () => poison('persistent state must be unreachable'),
      });
      expectDenied(evaluateActionPolicy(input), 'capability_flag_disabled');
    }
  );

  test('never authorizes escalation with enabled, closed policy state', () => {
    const boundProposal = proposal();
    const decision = evaluateActionPolicy({
      policy: policy(),
      requested_capability: 'escalation',
      capability_state: state('escalation'),
      proposal: boundProposal,
      permit: permit(boundProposal),
      current_time: NOW,
    });
    expectDenied(decision, 'coarse_capability_mismatch');
  });

  test.each([
    ['proposal_id', 'different', 'proposal_id_mismatch'],
    ['execution_id', 'different', 'execution_id_mismatch'],
    ['repository', 'other/repo', 'repository_mismatch'],
    ['pr_number', 99, 'pr_number_mismatch'],
    ['head_sha', 'f'.repeat(40), 'head_sha_mismatch'],
    ['base_branch', 'main', 'base_branch_mismatch'],
    ['base_sha', 'f'.repeat(40), 'base_sha_mismatch'],
    ['snapshot_id', 'snapshot-2', 'snapshot_id_mismatch'],
    ['action_kind', 'REPAIR', 'action_kind_mismatch'],
    ['capability', 'overseer.m31.repair', 'proposal_capability_mismatch'],
  ] as const)('denies permit/proposal %s mismatch', (field, value, reason) => {
    const boundProposal = proposal();
    const decision = evaluateActionPolicy(
      evaluation({ proposal: boundProposal, permit: permit(boundProposal, { [field]: value }) })
    );
    expectDenied(decision, reason);
  });

  test('denies missing, expired, malformed, unsupported, and digest-mismatched identity', () => {
    expectDenied(evaluateActionPolicy(evaluation({ proposal: null })), 'proposal_missing');

    const boundProposal = proposal();
    expectDenied(
      evaluateActionPolicy(
        evaluation({
          proposal: boundProposal,
          permit: permit(boundProposal, { valid_until: '2026-07-15T11:59:59.999Z' }),
        })
      ),
      'permit_expired'
    );

    expectDenied(
      evaluateActionPolicy(evaluation({ proposal: proposal({ policy_digest: 'BAD' }) })),
      'policy_digest_malformed'
    );
    expectDenied(
      evaluateActionPolicy(evaluation({ proposal: proposal({ verifier_registry_digest: 'BAD' }) })),
      'verifier_registry_digest_malformed'
    );

    const unsupported = proposal({
      action_kind: 'DEPLOY',
      capability: 'overseer.m31.deploy',
    });
    expectDenied(
      evaluateActionPolicy(evaluation({ proposal: unsupported, permit: permit(unsupported) })),
      'unsupported_action_kind'
    );

    expectDenied(
      evaluateActionPolicy(
        evaluation({ capability_state: state('merge', { policy_digest: 'f'.repeat(64) }) })
      ),
      'policy_digest_mismatch'
    );
    expectDenied(
      evaluateActionPolicy(
        evaluation({
          capability_state: state('merge', { verifier_registry_digest: 'f'.repeat(64) }),
        })
      ),
      'verifier_registry_mismatch'
    );
  });

  test.each([
    ['MERGE', 'merge'],
    ['REPAIR', 'repair'],
    ['REFIRE', 'repair'],
    ['REFRESH', 'branch'],
    ['REBASE', 'branch'],
    ['PUSH', 'branch'],
    ['RETARGET', 'branch'],
    ['CLOSE', 'lifecycle'],
    ['REOPEN', 'lifecycle'],
    ['COMMENT', 'lifecycle'],
    ['LABEL', 'lifecycle'],
    ['ASSIGN', 'lifecycle'],
    ['REVIEW', 'lifecycle'],
  ] as const)('maps %s to the %s coarse gate', (actionKind, capability) => {
    const boundProposal = proposal({
      action_kind: actionKind,
      capability: `overseer.m31.${actionKind.toLowerCase()}`,
    });
    const decision = evaluateActionPolicy({
      policy: policy(),
      requested_capability: capability,
      capability_state: state(capability),
      proposal: boundProposal,
      permit: permit(boundProposal),
      current_time: NOW,
    });
    expect(decision.allowed).toBe(true);
  });

  test('allows one exact fresh merge identity', () => {
    const decision = evaluateActionPolicy(evaluation());
    expect(decision).toEqual({
      allowed: true,
      reason: 'allowed',
      capability: 'merge',
      repository: 'bluedevilcollectibles/bdc-harness',
      pr_number: 42,
      head_sha: 'c'.repeat(40),
      base_branch: 'dev',
      base_sha: 'd'.repeat(40),
      snapshot_id: 'snapshot-1',
      proposal_id: 'proposal-1',
      execution_id: 'execution-1',
      action_kind: 'MERGE',
      valid_until: '2026-07-15T12:01:00.000Z',
      policy_digest: POLICY_DIGEST,
      verifier_registry_digest: VERIFIER_DIGEST,
    });
  });
});

describe('authorizeOverseerAction', () => {
  test('early denial appends one event without reading state, proposal, or clock', async () => {
    const boundProposal = proposal();
    const appendEvent = mock(async (_input: AppendOverseerCapabilityEventInput) => undefined);
    const getCapabilityState = mock(async () => poison('state must be unreachable'));
    const getProposal = mock(async () => poison('proposal must be unreachable'));
    const getCurrentTime = mock(async () => poison('clock must be unreachable'));

    const result = await authorizeOverseerAction(
      {
        policy: policy({ service_enabled: false }),
        requested_capability: 'merge',
        permit: permit(boundProposal),
        actor: 'test-actor',
        correlation_id: 'corr-1',
      },
      {
        getCapabilityState,
        getProposal,
        getCurrentTimeForTest: getCurrentTime,
        appendEvent,
      }
    );

    expectDenied(result, 'service_disabled');
    expect(getCapabilityState).not.toHaveBeenCalled();
    expect(getProposal).not.toHaveBeenCalled();
    expect(getCurrentTime).not.toHaveBeenCalled();
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'gate_denied',
        reason: 'service_disabled',
        capability: 'merge',
        policy_digest: '0'.repeat(64),
        verifier_registry_digest: '0'.repeat(64),
      })
    );
  });

  test('reads state then exact proposal and clock, appending one allowed merge event', async () => {
    const boundProposal = proposal();
    const callOrder: string[] = [];
    const appendEvent = mock(async (input: AppendOverseerCapabilityEventInput) => {
      callOrder.push('append');
      return input;
    });
    const result = await authorizeOverseerAction(
      {
        policy: policy(),
        requested_capability: 'merge',
        permit: permit(boundProposal),
        actor: 'test-actor',
        correlation_id: 'corr-2',
      },
      {
        getCapabilityState: mock(async () => {
          callOrder.push('state');
          return state('merge');
        }),
        getProposal: mock(async () => {
          callOrder.push('proposal');
          return boundProposal;
        }),
        getCurrentTimeForTest: mock(async () => {
          callOrder.push('clock');
          return NOW;
        }),
        appendEvent,
      }
    );

    expect(result.allowed).toBe(true);
    expect(callOrder).toEqual(['state', 'proposal', 'clock', 'append']);
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'gate_allowed',
        reason: 'allowed',
        proposal_id: 'proposal-1',
        execution_id: 'execution-1',
        policy_digest: POLICY_DIGEST,
        verifier_registry_digest: VERIFIER_DIGEST,
      })
    );
  });

  test('a denied capability state never reads the proposal or clock', async () => {
    const boundProposal = proposal();
    const appendEvent = mock(async (_input: AppendOverseerCapabilityEventInput) => undefined);
    const getProposal = mock(async () => poison('proposal must be unreachable'));
    const getCurrentTime = mock(async () => poison('clock must be unreachable'));
    const result = await authorizeOverseerAction(
      {
        policy: policy(),
        requested_capability: 'merge',
        permit: permit(boundProposal),
        actor: 'test-actor',
        correlation_id: 'corr-3',
      },
      {
        getCapabilityState: mock(async () => state('merge', { circuit_state: 'open' })),
        getProposal,
        getCurrentTimeForTest: getCurrentTime,
        appendEvent,
      }
    );

    expectDenied(result, 'circuit_open');
    expect(getProposal).not.toHaveBeenCalled();
    expect(getCurrentTime).not.toHaveBeenCalled();
    expect(appendEvent).toHaveBeenCalledTimes(1);
  });
});
