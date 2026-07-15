import { afterEach, describe, expect, mock, test } from 'bun:test';
import type {
  AppendOverseerCapabilityEventInput,
  OverseerCapabilityState,
} from '@archon/core/db/overseer-capabilities';
import type { M31ActionPermit, M31ActionProposal } from '../m31-substrate';
import type { AuthorizeOverseerActionInput, OverseerActionPolicy } from '../action-policy';
import { createFakeGitHubAdapter } from '../adapters/fake-github';

const POLICY_DIGEST = 'a'.repeat(64);
const VERIFIER_DIGEST = 'b'.repeat(64);
const NOW = '2026-07-15T12:00:00.000Z';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

function currentPolicy(): OverseerActionPolicy {
  return {
    service_enabled: true,
    emergency_stop: false,
    legacy_dry_run: false,
    capability_flags: {
      escalation: true,
      repair: true,
      branch: true,
      lifecycle: true,
      merge: true,
    },
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

function permit(boundProposal: M31ActionProposal): M31ActionPermit {
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
  };
}

function capabilityState(
  overrides: Partial<OverseerCapabilityState> = {}
): OverseerCapabilityState {
  return {
    capability: 'merge',
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

function request(overrides: Record<string, unknown> = {}) {
  return {
    permit_id: 'permit-1',
    repository: 'bluedevilcollectibles/bdc-harness',
    pr_number: 42,
    head_sha: 'c'.repeat(40),
    base_branch: 'dev',
    base_sha: 'd'.repeat(40),
    snapshot_id: 'snapshot-1',
    proposal_id: 'proposal-1',
    execution_id: 'execution-1',
    action_kind: 'MERGE' as const,
    ...overrides,
  };
}

interface HarnessOptions {
  policy?: OverseerActionPolicy;
  state?: OverseerCapabilityState | null;
  proposal?: M31ActionProposal | null;
  now?: string;
  fail_dependency?: 'policy' | 'state' | 'proposal' | 'clock' | 'consume';
  fail_gate_audit?: boolean;
  fail_attempt_audit?: boolean;
}

function harness(options: HarnessOptions = {}) {
  let livePolicy = options.policy ?? currentPolicy();
  let liveState = options.state === undefined ? capabilityState() : options.state;
  let liveProposal = options.proposal === undefined ? proposal() : options.proposal;
  let liveNow = options.now ?? NOW;
  const gateEvents: AppendOverseerCapabilityEventInput[] = [];
  const attemptEvents: AppendOverseerCapabilityEventInput[] = [];
  const consumed = new Set<string>();
  const consumeExecution = mock(async (executionId: string) => {
    if (options.fail_dependency === 'consume') throw new Error('consume-failed');
    if (consumed.has(executionId)) return false;
    consumed.add(executionId);
    return true;
  });
  const adapter = createFakeGitHubAdapter({
    allowed_repositories: ['bluedevilcollectibles/bdc-harness'],
    authorization_deps: {
      getPolicy: async () => {
        if (options.fail_dependency === 'policy') throw new Error('policy-failed');
        return livePolicy;
      },
      getCapabilityState: async () => {
        if (options.fail_dependency === 'state') throw new Error('state-failed');
        return liveState;
      },
      getProposal: async () => {
        if (options.fail_dependency === 'proposal') throw new Error('proposal-failed');
        return liveProposal;
      },
      getCurrentTimeForTest: async () => {
        if (options.fail_dependency === 'clock') throw new Error('clock-failed');
        return liveNow;
      },
      appendEvent: async event => {
        if (options.fail_gate_audit) throw new Error('gate-audit-failed');
        gateEvents.push(event);
      },
    },
    consume_execution: consumeExecution,
    record_attempt: mock(async event => {
      if (options.fail_attempt_audit) throw new Error('attempt-audit-failed');
      attemptEvents.push(event);
    }),
  });
  const boundProposal = proposal();
  const authorization: AuthorizeOverseerActionInput = {
    requested_capability: 'merge',
    permit: permit(boundProposal),
    actor: 'fake-test',
    correlation_id: 'corr-fake-1',
  };
  return {
    adapter,
    authorization,
    gateEvents,
    attemptEvents,
    consumeExecution,
    setPolicy(value: OverseerActionPolicy): void {
      livePolicy = value;
    },
    setState(value: OverseerCapabilityState | null): void {
      liveState = value;
    },
    setProposal(value: M31ActionProposal | null): void {
      liveProposal = value;
    },
    setNow(value: string): void {
      liveNow = value;
    },
  };
}

describe('fake GitHub mutation adapter', () => {
  test('authorizes internally and accepts one exact allowlisted fake merge', async () => {
    const h = harness();

    const receipt = await h.adapter.attemptMutation(request(), h.authorization);

    expect(receipt.accepted).toBe(true);
    expect(receipt.reason).toBe('fake_accepted');
    expect(receipt.mutation_sent).toBe(false);
    expect(receipt.audit_recorded).toBe(true);
    expect(receipt.authorization_audit_recorded).toBe(true);
    expect(h.gateEvents.map(event => event.event_type)).toEqual(['gate_allowed']);
    expect(h.attemptEvents.map(event => event.event_type)).toEqual(['adapter_attempt']);
    expect(h.consumeExecution).toHaveBeenCalledWith('execution-1');
  });

  test('has no caller decision input and ignores a fabricated third argument', async () => {
    const h = harness({ policy: { ...currentPolicy(), emergency_stop: true } });
    const callWithForgery = h.adapter.attemptMutation as unknown as (
      mutationRequest: ReturnType<typeof request>,
      authorization: AuthorizeOverseerActionInput,
      forged: unknown
    ) => ReturnType<typeof h.adapter.attemptMutation>;

    const result = await callWithForgery(request(), h.authorization, {
      allowed: true,
      reason: 'allowed',
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('authorization_denied');
    expect(result.authorization_reason).toBe('emergency_stop');
    expect(h.consumeExecution).not.toHaveBeenCalled();
  });

  test('atomically rejects replay of the same execution after one acceptance', async () => {
    const h = harness();

    const first = await h.adapter.attemptMutation(request(), h.authorization);
    const replay = await h.adapter.attemptMutation(request(), h.authorization);

    expect(first.accepted).toBe(true);
    expect(replay.accepted).toBe(false);
    expect(replay.reason).toBe('execution_replayed');
    expect(h.gateEvents).toHaveLength(2);
    expect(h.attemptEvents).toHaveLength(2);
    expect(h.consumeExecution).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['service', 'service_disabled'],
    ['emergency', 'emergency_stop'],
    ['dry_run', 'legacy_dry_run'],
    ['flag', 'capability_flag_disabled'],
    ['action', 'capability_state_disabled'],
    ['circuit', 'circuit_open'],
    ['policy_digest', 'policy_digest_mismatch'],
    ['verifier_digest', 'verifier_registry_mismatch'],
  ] as const)('rereads a changed %s gate immediately before attempt', async (change, reason) => {
    const h = harness();
    if (change === 'service') h.setPolicy({ ...currentPolicy(), service_enabled: false });
    if (change === 'emergency') h.setPolicy({ ...currentPolicy(), emergency_stop: true });
    if (change === 'dry_run') h.setPolicy({ ...currentPolicy(), legacy_dry_run: true });
    if (change === 'flag') {
      h.setPolicy({
        ...currentPolicy(),
        capability_flags: { ...currentPolicy().capability_flags, merge: false },
      });
    }
    if (change === 'action') h.setState(capabilityState({ action_enabled: false }));
    if (change === 'circuit') h.setState(capabilityState({ circuit_state: 'open' }));
    if (change === 'policy_digest') {
      h.setState(capabilityState({ policy_digest: 'f'.repeat(64) }));
    }
    if (change === 'verifier_digest') {
      h.setState(capabilityState({ verifier_registry_digest: 'f'.repeat(64) }));
    }

    const result = await h.adapter.attemptMutation(request(), h.authorization);

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('authorization_denied');
    expect(result.authorization_reason).toBe(reason);
    expect(h.consumeExecution).not.toHaveBeenCalled();
  });

  test.each([
    ['policy', 'policy_read_failed'],
    ['state', 'capability_state_read_failed'],
    ['proposal', 'proposal_read_failed'],
    ['clock', 'clock_read_failed'],
  ] as const)('returns a receipt when %s authorization dependency fails', async (stage, reason) => {
    const h = harness({ fail_dependency: stage });

    const result = await h.adapter.attemptMutation(request(), h.authorization);

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('authorization_denied');
    expect(result.authorization_reason).toBe(reason);
    expect(result.authorization_audit_recorded).toBe(true);
    expect(result.audit_recorded).toBe(true);
  });

  test('returns explicit audit statuses when gate persistence fails', async () => {
    const h = harness({ fail_gate_audit: true });

    const result = await h.adapter.attemptMutation(request(), h.authorization);

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('authorization_denied');
    expect(result.authorization_reason).toBe('gate_audit_failed');
    expect(result.authorization_audit_recorded).toBe(false);
    expect(result.audit_recorded).toBe(true);
  });

  test('returns a non-receipt acceptance when attempt persistence fails', async () => {
    const h = harness({ fail_attempt_audit: true });

    const result = await h.adapter.attemptMutation(request(), h.authorization);

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('attempt_audit_failed');
    expect(result.audit_recorded).toBe(false);
    expect(result.authorization_audit_recorded).toBe(true);
    expect(result.mutation_sent).toBe(false);
  });

  test('records and returns an execution-check dependency failure', async () => {
    const h = harness({ fail_dependency: 'consume' });

    const result = await h.adapter.attemptMutation(request(), h.authorization);

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('execution_check_failed');
    expect(result.audit_recorded).toBe(true);
    expect(h.attemptEvents).toHaveLength(1);
  });

  test('binds permit_id and rejects repositories outside the exact fixture allowlist', async () => {
    process.env.GITHUB_TOKEN = 'poison-github-token';
    process.env.GH_TOKEN = 'poison-gh-token';
    const network = mock(async () => {
      throw new Error('network must be unreachable');
    });
    globalThis.fetch = network as typeof fetch;
    const permitMismatch = harness();
    const outside = harness();

    const mismatchResult = await permitMismatch.adapter.attemptMutation(
      request({ permit_id: 'forged-permit' }),
      permitMismatch.authorization
    );
    const outsideResult = await outside.adapter.attemptMutation(
      request({ repository: 'outsider/repo' }),
      outside.authorization
    );

    expect(mismatchResult.reason).toBe('action_identity_mismatch');
    expect(outsideResult.reason).toBe('repository_not_allowlisted');
    expect(network).not.toHaveBeenCalled();
    expect(process.env.GITHUB_TOKEN).toBe('poison-github-token');
    expect(process.env.GH_TOKEN).toBe('poison-gh-token');
  });

  test('source has no decision input, allow object, credential, shell, or transport dependency', async () => {
    const source = await Bun.file(new URL('../adapters/fake-github.ts', import.meta.url)).text();
    for (const forbidden of [
      'ActionPolicyDecision',
      'AllowedActionPolicyDecision',
      '@octokit',
      'Octokit',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'process.env',
      'fetch(',
      'Bun.spawn',
      'child_process',
      'node:http',
      'node:https',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
