import { describe, expect, mock, test } from 'bun:test';

mock.module('@archon/core/db/m31-target-v2', () => ({
  appendM31ExecutionOutcomeV2: async () => ({ ok: true, value: {} }),
  appendM31ExecutionReconciliationV2: async () => ({ ok: true, value: {} }),
  canonicalJsonV2: (value: unknown) => JSON.stringify(value),
  compareAndConsumeM31ProposalV2: async () => ({ ok: false, failure: 'evidence_missing' }),
  getM31ActionProposalV2: async () => null,
  getM31SnapshotV2: async () => null,
  reserveM31ExecutionEffectV2: async () => ({ ok: true, value: {} }),
}));

mock.module('@archon/core/db/connection', () => ({
  getDatabase: () => ({
    dialect: 'sqlite',
    query: async () => ({ rows: [{ now: '2026-07-20T00:00:00.000Z' }] }),
  }),
}));

mock.module('@archon/core/db/overseer-capabilities', () => ({
  appendOverseerCapabilityEvent: async () => undefined,
  getOverseerCapabilityState: async () => null,
}));

mock.module('@archon/core/db/overseer', () => ({
  insertOverseerAction: async () => undefined,
  listRunEventsForOverseer: async () => [],
  listRunsForOverseerWatch: async () => [],
}));

describe('merge coordinator composition', () => {
  test('constructs service deps and coordinator deps with injected transports', async () => {
    const { createMergeCoordinatorComposition } = await import('../merge-coordinator-composition');
    const composition = createMergeCoordinatorComposition({
      githubToken: 'gh-test',
      xaiApiKey: 'xai-test',
      octokit: octokitFake() as never,
      xaiFetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'VERDICT: HOLD' } }] }), {
          status: 200,
        }),
    });

    expect(composition.deps.listRunsForWatch).toBeFunction();
    expect(composition.deps.listRunEvents).toBeFunction();
    expect(composition.deps.insertOverseerAction).toBeFunction();
    expect(composition.deps.findPullRequest).toBeFunction();
    expect(composition.deps.mergePullRequest).toBeFunction();
    expect(composition.mergeCoordinator).toBeFunction();
    expect(composition.mergeCoordinatorDeps.assembleEvidence).toBeFunction();
    expect(composition.mergeCoordinatorDeps.judge).toBeFunction();
  });

  test('judge transport failure in composed deps returns HOLD without throwing', async () => {
    const { createMergeCoordinatorComposition } = await import('../merge-coordinator-composition');
    const composition = createMergeCoordinatorComposition({
      githubToken: 'gh-test',
      xaiApiKey: 'xai-test',
      octokit: octokitFake() as never,
      xaiFetch: async () => {
        throw new Error('network');
      },
    });

    await expect(
      composition.mergeCoordinatorDeps.judge({
        woId: 'WO-TEST-01',
        prNumber: 42,
        prTitle: 'merge candidate',
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        evidenceDigest: 'c'.repeat(64),
        operator: {
          identity: 'overseer-merge-coordinator',
          provider: 'xai',
          modelFamily: 'grok',
        },
        checksSummary: { total: 1, passed: 1, failed: 0, pending: 0 },
        filesChangedCount: 1,
        diffStat: '+1 -0',
      })
    ).resolves.toMatchObject({ disposition: 'hold', reason: 'judge_error' });
  });
});

function octokitFake() {
  return {
    pulls: {
      merge: async () => ({ data: { merged: true, sha: 'a'.repeat(40), message: 'merged' } }),
      get: async () => ({
        data: {
          number: 42,
          state: 'open',
          title: 'merge candidate',
          html_url: 'https://github.test/pull/42',
          mergeable: true,
          updated_at: '2026-07-20T00:00:00.000Z',
          head: { sha: 'a'.repeat(40) },
          base: { ref: 'dev', sha: 'b'.repeat(40) },
        },
      }),
      list: async () => ({ data: [] }),
      listFiles: async () => ({
        data: [{ filename: 'packages/server/src/index.ts', additions: 1, deletions: 0 }],
      }),
      listReviews: async () => ({ data: [{ state: 'APPROVED' }] }),
    },
    checks: {
      listForRef: async () => ({
        data: {
          total_count: 1,
          check_runs: [
            {
              name: 'ci',
              status: 'completed',
              conclusion: 'success',
              head_sha: 'a'.repeat(40),
            },
          ],
        },
      }),
    },
  };
}
