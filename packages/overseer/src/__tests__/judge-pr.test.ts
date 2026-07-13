import { describe, expect, test } from 'bun:test';
import { isPrGreen, isPrMergeReady, judgePullRequest } from '../judge-pr.ts';

describe('judge-pr', () => {
  test('detects green mergeable PR evidence', async () => {
    const evidence = await judgePullRequest(
      {
        owner: 'bluedevilcollectibles',
        repo: 'bdc-harness',
        headBranch: 'wo/test',
        woId: 'WO-TEST-01',
      },
      {
        findPullRequest: async () => ({
          exists: true,
          state: 'open',
          checks: { total: 2, passed: 2, failed: 0, pending: 0 },
          mergeable: true,
          pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 7 },
        }),
        mergePullRequest: async () => ({ merged: true }),
      }
    );

    expect(evidence.mergeable).toBe(true);
    expect(isPrGreen(evidence)).toBe(true);
    expect(isPrMergeReady(evidence)).toBe(true);
  });
});
