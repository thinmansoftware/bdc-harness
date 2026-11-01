import { describe, expect, mock, test } from 'bun:test';
import { executeAutomaticRefire, type AutomaticRefireDeps } from '../actions/automatic-refire';
import type { RepairRefireExecutionDeps } from '../actions/repair-refire';
import type { WatchedRunRecord } from '../types';

const digest = (value: string): string =>
  new Bun.CryptoHasher('sha256').update(value).digest('hex');

const record: WatchedRunRecord = {
  runId: 'r1',
  woId: 'WO-X-01',
  status: 'failed',
  repo: 'bdc-harness',
  workflowName: 'lane',
  action: 'escalate',
  reason: 'timeout',
  prEvidence: {
    exists: false,
    state: 'none',
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: false,
  },
  recovery: { plan: 'refire', reason: 'bash_node_timeout' },
};

const events = [
  {
    id: 'e1',
    workflow_run_id: 'r1',
    event_type: 'node_failed',
    step_name: 'implement',
    data: { message: 'timeout' },
  },
];

function harness(overrides: Partial<AutomaticRefireDeps> = {}) {
  const order: string[] = [];
  let persisted: import('../actions/repair-refire').FirstRefireOnRampResultV1 | undefined;
  const executionDeps: Omit<RepairRefireExecutionDeps, 'adapter' | 'adapterName'> = {
    gate: {
      preparePermit: async () => (order.push('permit'), { ok: true, reason: 'ok' }),
      authorizeAction: async () => (order.push('authorize'), { allowed: true, reason: 'ok' }),
      reserveEffect: async () => (order.push('reserve'), { ok: true, reason: 'ok' }),
      appendOutcome: async () => (order.push('outcome'), { ok: true }),
    },
    idempotency: {
      begin: async () =>
        persisted ? { status: 'replay', result: persisted } : { status: 'fresh' },
      commit: async (_key, result) => {
        persisted = result;
      },
    },
    circuit: { openRepairCircuit: async () => undefined },
    recorder: { recordDisposition: async () => undefined },
    executionClaim: {
      acquire: async () => ({
        ok: true,
        claim: {
          claim_id: 'claim-1',
          action_class: 'recovery',
          repository: 'bdc-harness',
          action_key: 'WO-X-01',
          target_digest: digest('target'),
          claimant_principal: 'overseer-refire',
          lease_owner: 'overseer-refire',
          execution_id: 'refire:r1:1',
          execution_fencing_token: 1,
          status: 'active',
          lease_expires_at: '2099-01-01T00:00:00.000Z',
          effect_attempt_id: null,
          effect_committed_at: null,
          completion_evidence: null,
          terminal_outcome: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        taken_over: false,
      }),
      validate: async () => ({ ok: true, effect_attempt_id: 'effect-1' }),
      complete: async () => ({ ok: true }),
      release: async () => ({ ok: true }),
    },
    sha256hex: digest,
  };
  const deps: AutomaticRefireDeps = {
    countAutomaticAttempts: async () => 0,
    findLiveRunsForWo: async () => [],
    workflowName: current => current.workflowName,
    salvage: async current => ({
      schema_version: 'overseer-salvage-receipt-v1',
      repository: current.repo ?? '',
      wo_id: current.woId,
      source_target_kind: 'workflow_run',
      source_target_key: current.runId,
      source_target_digest: digest(current.runId),
      source_run_id: current.runId,
      worktree_path: '/tmp/r1',
      artifact_kind: 'git_object',
      git_object_format: 'sha1',
      git_object_id: 'a'.repeat(40),
      patch_path: null,
      patch_sha256: null,
      scope_digest: digest(current.woId),
      captured_at: '2026-01-01T00:00:00.000Z',
      verified_at: '2026-01-01T00:00:00.000Z',
    }),
    fireWorkflowRun: async () => (
      order.push('fire'),
      { ok: true, runId: 'r2', conversationId: 'c2' }
    ),
    executionDeps,
    ...overrides,
  };
  return { deps, order };
}

describe('automatic refire', () => {
  test('attempt ceiling invokes no downstream dependency', async () => {
    const findLiveRunsForWo = mock(async () => []);
    const { deps } = harness({ countAutomaticAttempts: async () => 2, findLiveRunsForWo });
    const result = await executeAutomaticRefire(record, [], deps);
    expect(result).toEqual({ status: 'refused', reason: 'attempt_ceiling' });
    expect(findLiveRunsForWo).not.toHaveBeenCalled();
  });
  test('live owner refuses before salvage', async () => {
    const { deps } = harness({ findLiveRunsForWo: async () => [{}] });
    const result = await executeAutomaticRefire(record, [], deps);
    expect(result).toEqual({ status: 'refused', reason: 'duplicate_owner' });
  });
  test('fires only after permit, authorization, and reservation', async () => {
    const { deps, order } = harness();
    expect(await executeAutomaticRefire(record, events, deps)).toEqual({
      status: 'fired',
      runId: 'r2',
      attempt: 1,
    });
    expect(order).toEqual(['permit', 'authorize', 'reserve', 'fire', 'outcome']);
  });
  test('policy denial refuses without firing', async () => {
    const { deps, order } = harness();
    deps.executionDeps.gate.authorizeAction = async () => (
      order.push('authorize'),
      { allowed: false, reason: 'policy_denied' }
    );
    expect(await executeAutomaticRefire(record, events, deps)).toEqual({
      status: 'refused',
      reason: 'policy_denied',
    });
    expect(order).toEqual(['permit', 'authorize']);
  });
  test('dispatch uncertainty is indeterminate', async () => {
    const { deps } = harness({ fireWorkflowRun: async () => Promise.reject(new Error('lost')) });
    expect(await executeAutomaticRefire(record, events, deps)).toEqual({
      status: 'indeterminate',
      reason: 'lost',
    });
  });
  test('collision salvages before terminal release', async () => {
    const sequence: string[] = [];
    const base = harness();
    const originalSalvage = base.deps.salvage;
    base.deps.salvage = async (...args) => (sequence.push('salvage'), originalSalvage(...args));
    base.deps.releaseTerminalWorktree = async () => (sequence.push('release'), { ok: true });
    await executeAutomaticRefire(
      { ...record, errorClass: 'worktree_collision' },
      events,
      base.deps
    );
    expect(sequence).toEqual(['salvage', 'release']);
  });
  test('replay returns persisted result without firing twice', async () => {
    const { deps, order } = harness();
    await executeAutomaticRefire(record, events, deps);
    await executeAutomaticRefire(record, events, deps);
    expect(order.filter(item => item === 'fire')).toHaveLength(1);
  });
});
