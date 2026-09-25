import { describe, expect, test } from 'bun:test';
import { executeAutomaticRefire, releaseTerminalWorktree } from '../actions/automatic-refire';

const record = {
  runId: 'r1',
  woId: 'WO-X',
  status: 'failed',
  action: 'escalate' as const,
  reason: 'timeout',
  prEvidence: {
    exists: false,
    state: 'none',
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: false,
  },
  recovery: { plan: 'refire' as const, reason: 'bash_node_timeout' },
};

describe('automatic refire', () => {
  test('ceiling precedes live check and execution', async () => {
    let effects = 0;
    const result = await executeAutomaticRefire(record, [], {
      findConfirmedSuccessor: async () => null,
      countAutomaticAttempts: async () => 2,
      findLiveRunsForWo: async () => {
        effects++;
        return [];
      },
      execute: async () => {
        effects++;
        throw new Error('unreachable');
      },
    });
    expect(result).toEqual({ status: 'refused', reason: 'attempt_ceiling' });
    expect(effects).toBe(0);
  });
  test('terminal worktree is salvaged before force removal', async () => {
    const order: string[] = [];
    const result = await releaseTerminalWorktree(
      "fatal: '/repo' is already used by worktree at '/tmp/wt'",
      {
        getRunByWorkingPath: async path => ({ id: 'owner', status: 'failed', workingPath: path }),
        inspect: async () => ({ dirty: true, diff: 'diff', untracked: ['new.txt'] }),
        persistPatch: async () => {
          order.push('salvage');
        },
        removeForce: async () => {
          order.push('remove');
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(order).toEqual(['salvage', 'remove']);
  });
});
