import { describe, expect, mock, test } from 'bun:test';
import {
  createFailClosedM31CapabilityGate,
  prepareM31ActionPermit,
  type M31ActionPermit,
  type M31ActionProposal,
  type M31ExecutionReceipt,
  type M31LiveObservation,
  type M31LiveStateReader,
  type M31PermitPreparationDeps,
} from '../m31-substrate';

// These tests exercise prepareM31ActionPermit in ISOLATION via dependency
// injection -- no database and NO provider client. This structurally proves the
// permit-preparation path reaches no external provider mutation: the only
// injected dependency that touches the outside world is a READ-ONLY
// M31LiveStateReader, and the returned permit is inert data.

function hex(len: number, seed: string): string {
  // Deterministic hex without crypto import churn; digests need 64, blobs 40.
  const base = '0123456789abcdef';
  let out = '';
  let x = 0;
  for (let i = 0; i < seed.length; i += 1) x = (x * 31 + seed.charCodeAt(i)) & 0xffff;
  for (let i = 0; i < len; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += base[x & 0xf];
  }
  return out;
}

function fakeProposal(over: Partial<M31ActionProposal> = {}): M31ActionProposal {
  return {
    proposal_id: 'proposal-1',
    repository: 'bluedevilcollectibles/bdc-harness',
    pr_number: 101,
    head_sha: hex(40, 'head'),
    base_branch: 'dev',
    base_sha: hex(40, 'base'),
    snapshot_id: 'snapshot-1',
    evidence_path: 'artifacts/proposal.json',
    evidence_git_blob: hex(40, 'evidence'),
    action_kind: 'MERGE',
    action_parameters: {},
    actor: 'xo-model',
    created_at: '2026-07-14T00:00:00.000Z',
    expires_at: '2026-07-14T00:15:00.000Z',
    execution_id: 'exec-1',
    capability: 'overseer.m31.merge',
    policy_digest: hex(64, 'policy'),
    verifier_registry_digest: hex(64, 'verifier'),
    ...over,
  };
}

function observationFor(proposal: M31ActionProposal): M31LiveObservation {
  return {
    known: true,
    repository: proposal.repository,
    pr_number: proposal.pr_number,
    head_sha: proposal.head_sha,
    base_branch: proposal.base_branch,
    base_sha: proposal.base_sha,
    policy_digest: proposal.policy_digest,
    verifier_registry_digest: proposal.verifier_registry_digest,
    observed_at: '2026-07-14T00:00:30.000Z',
  };
}

function permitFor(proposal: M31ActionProposal): M31ActionPermit {
  return {
    permit_id: 'receipt-1',
    proposal_id: proposal.proposal_id,
    execution_id: proposal.execution_id,
    repository: proposal.repository,
    pr_number: proposal.pr_number,
    head_sha: proposal.head_sha,
    base_branch: proposal.base_branch,
    base_sha: proposal.base_sha,
    snapshot_id: proposal.snapshot_id,
    action_kind: proposal.action_kind,
    capability: proposal.capability,
    issued_at: '2026-07-14T00:00:31.000Z',
    valid_until: '2026-07-14T00:01:30.000Z',
  };
}

function receiptFor(proposal: M31ActionProposal): M31ExecutionReceipt {
  return {
    receipt_id: 'receipt-1',
    proposal_id: proposal.proposal_id,
    execution_id: proposal.execution_id,
    snapshot_id: proposal.snapshot_id,
    live_observation: observationFor(proposal),
    live_observation_digest: hex(64, 'obs'),
    revalidated_at: '2026-07-14T00:00:30.000Z',
    valid_until: '2026-07-14T00:01:30.000Z',
    compare_result: 'permit_issued',
    provider_atomic_operation: null,
    created_at: '2026-07-14T00:00:31.000Z',
  };
}

describe('prepareM31ActionPermit', () => {
  // Test 3 -- final live-state comparison success, no external provider called.
  test('issues a permit when live state matches and the gate allows', async () => {
    const proposal = fakeProposal();
    const reader: M31LiveStateReader = {
      readBoundState: mock(async () => observationFor(proposal)),
    };
    const consume = mock(async () => ({
      ok: true as const,
      permit: permitFor(proposal),
      receipt: receiptFor(proposal),
    }));
    const deps: M31PermitPreparationDeps = {
      liveStateReader: reader,
      capabilityGate: createFailClosedM31CapabilityGate(),
      getProposal: mock(async () => proposal),
      compareAndConsume: consume,
    };

    const result = await prepareM31ActionPermit({ proposal_id: 'proposal-1' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected permit');
    expect(result.permit.execution_id).toBe('exec-1');
    expect(result.receipt.compare_result).toBe('permit_issued');
    expect(result.receipt.provider_atomic_operation).toBeNull();
    expect(reader.readBoundState).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);

    // Structural absence of provider mutation: the injected deps expose only a
    // read-only reader + a pure gate (plus test seams), and the permit is inert.
    expect(Object.keys(reader)).toEqual(['readBoundState']);
    for (const value of Object.values(result.permit)) {
      expect(typeof value).not.toBe('function');
    }
    // The observation passed to consume is exactly what the reader returned.
    const consumeArg = consume.mock.calls[0]?.[0] as { observation: M31LiveObservation };
    expect(consumeArg.observation).toEqual(observationFor(proposal));
  });

  test('returns not_found without reading live state when the proposal is absent', async () => {
    const reader: M31LiveStateReader = {
      readBoundState: mock(async () => observationFor(fakeProposal())),
    };
    const consume = mock(async () => {
      throw new Error('must not be called');
    });
    const result = await prepareM31ActionPermit(
      { proposal_id: 'missing' },
      {
        liveStateReader: reader,
        capabilityGate: createFailClosedM31CapabilityGate(),
        getProposal: mock(async () => null),
        compareAndConsume: consume as never,
      }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect('not_found' in result && result.not_found).toBe(true);
    expect(reader.readBoundState).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  test('denies via the gate and never consumes when the capability mismatches', async () => {
    // Proposal capability does not match its action kind -> fail-closed denial.
    const proposal = fakeProposal({ capability: 'overseer.m31.deploy', action_kind: 'MERGE' });
    const reader: M31LiveStateReader = {
      readBoundState: mock(async () => observationFor(proposal)),
    };
    const consume = mock(async () => {
      throw new Error('must not be called');
    });
    const result = await prepareM31ActionPermit(
      { proposal_id: 'proposal-1' },
      {
        liveStateReader: reader,
        capabilityGate: createFailClosedM31CapabilityGate(),
        getProposal: mock(async () => proposal),
        compareAndConsume: consume as never,
      }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect('denied' in result).toBe(true);
    if (!('denied' in result)) throw new Error('unexpected');
    expect(result.denied.reason).toBe('capability_mismatch');
    expect(consume).not.toHaveBeenCalled();
  });

  // Test 4/5 propagation -- typed failures from compare-and-consume surface verbatim.
  test('propagates a typed failure from compare-and-consume', async () => {
    const proposal = fakeProposal();
    const reader: M31LiveStateReader = {
      readBoundState: mock(async () => observationFor(proposal)),
    };
    const result = await prepareM31ActionPermit(
      { proposal_id: 'proposal-1', validity_window_ms: 60_000 },
      {
        liveStateReader: reader,
        capabilityGate: createFailClosedM31CapabilityGate(),
        getProposal: mock(async () => proposal),
        compareAndConsume: mock(async () => ({
          ok: false as const,
          failure: 'observation_stale' as const,
        })),
      }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect('failure' in result && result.failure).toBe('observation_stale');
  });
});

describe('createFailClosedM31CapabilityGate', () => {
  const gate = createFailClosedM31CapabilityGate();

  test('allows the exact capability with well-formed digests', () => {
    const decision = gate.authorize({
      capability: 'overseer.m31.merge',
      action_kind: 'MERGE',
      policy_digest: hex(64, 'policy'),
      verifier_registry_digest: hex(64, 'verifier'),
    });
    expect(decision.allowed).toBe(true);
  });

  test('denies a capability that does not match the action kind', () => {
    const decision = gate.authorize({
      capability: 'overseer.m31.deploy',
      action_kind: 'MERGE',
      policy_digest: hex(64, 'policy'),
      verifier_registry_digest: hex(64, 'verifier'),
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unexpected');
    expect(decision.reason).toBe('capability_mismatch');
  });

  test('denies malformed digests fail-closed', () => {
    const decision = gate.authorize({
      capability: 'overseer.m31.merge',
      action_kind: 'MERGE',
      policy_digest: 'not-a-digest',
      verifier_registry_digest: hex(64, 'verifier'),
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unexpected');
    expect(decision.reason).toBe('policy_digest_malformed');
  });
});
