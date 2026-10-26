import { describe, expect, test } from 'bun:test';
import { executeAutomaticRefire } from '../actions/automatic-refire';

describe('automatic refire fail-closed guards', () => {
  const record = {
    runId: 'r1',
    woId: 'WO-X-01',
    status: 'failed',
    repo: 'bdc-harness',
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
  test('attempt ceiling invokes no downstream dependency', async () => {
    let invoked = false;
    const result = await executeAutomaticRefire(record, [], {
      countAutomaticAttempts: async () => 2,
      findLiveRunsForWo: async () => {
        invoked = true;
        return [];
      },
    } as never);
    expect(result).toEqual({ status: 'refused', reason: 'attempt_ceiling' });
    expect(invoked).toBe(false);
  });
  test('live owner refuses before salvage', async () => {
    const result = await executeAutomaticRefire(record, [], {
      countAutomaticAttempts: async () => 0,
      findLiveRunsForWo: async () => [{}],
    } as never);
    expect(result).toEqual({ status: 'refused', reason: 'duplicate_owner' });
  });
});
