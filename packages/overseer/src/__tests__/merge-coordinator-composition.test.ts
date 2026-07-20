import { describe, expect, mock, test } from 'bun:test';
import {
  createMergeCoordinatorRuntimeDeps,
  createRealMergeCoordinatorDeps,
} from '../merge-coordinator-composition.ts';
import type { GrokDispositionReceipt, WatchedRunRecord } from '../types.ts';

const record: WatchedRunRecord = {
  runId: 'run-1',
  woId: 'WO-TEST-01',
  owner: 'bluedevilcollectibles',
  repo: 'bdc-harness',
  status: 'failed',
  action: 'merge_ready',
  reason: 'green PR',
  headBranch: 'feature/pr-42',
  metadata: {
    manifest_v2: { valid: true },
    proposal_id: 'proposal-1',
    fusion: {
      present: true,
      components: ['grok'],
      raw_dissent_recorded: true,
      cost_recorded: true,
      verifier_correlated: false,
      hidden_model_substitution: false,
      receipt_digest: '1'.repeat(64),
      evidence_digest: '2'.repeat(64),
    },
  },
  prEvidence: {
    exists: true,
    state: 'open',
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: true,
    pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 42 },
  },
};

function octokit() {
  return {
    pulls: {
      get: mock(async () => ({
        data: {
          state: 'open',
          title: 'Exact PR',
          html_url: 'https://github.test/pr/42',
          node_id: 'PR_node',
          updated_at: '2026-07-20T00:00:00.000Z',
          mergeable: true,
          head: { sha: 'a'.repeat(40) },
          base: { sha: 'b'.repeat(40), ref: 'dev' },
        },
      })),
      listFiles: mock(async () => ({
        data: [{ filename: 'packages/server/src/index.ts', additions: 4, deletions: 1 }],
      })),
      listReviews: mock(async () => ({ data: [{ state: 'APPROVED' }] })),
      merge: mock(async () => ({ data: { merged: true, sha: 'merge-sha' } })),
    },
    checks: {
      listForRef: mock(async () => ({
        data: { check_runs: [{ name: 'ci', conclusion: 'success', head_sha: 'a'.repeat(40) }] },
      })),
    },
    repos: {
      compareCommitsWithBasehead: mock(async () => ({ data: { files: [] } })),
    },
  };
}

describe('merge coordinator composition', () => {
  test('constructs complete coordinator deps with injected fake transports', async () => {
    const judge = mock(
      async (input): Promise<GrokDispositionReceipt> => ({
        schemaVersion: 'overseer-grok-merge-disposition-v1',
        disposition: 'hold',
        reason: 'judge_hold',
        woId: input.woId,
        prNumber: input.prNumber,
        headSha: input.headSha,
        baseSha: input.baseSha,
        evidenceDigest: input.evidenceDigest,
        operator: input.operator,
      })
    );
    const deps = await createRealMergeCoordinatorDeps({
      octokit: octokit(),
      judge,
      readM31Proposal: async () => ({
        proposalId: 'proposal-1',
        present: true,
        verifierRegistryDigest: '3'.repeat(64),
      }),
      compareFinalState: async () => true,
    });

    expect(typeof deps.assembleEvidence).toBe('function');
    expect(typeof deps.judge).toBe('function');
    expect(typeof deps.executionDeps.preparePermit).toBe('function');
    expect(deps.executionDeps.mergeAdapter).toBeTruthy();

    const result = await deps.assembleEvidence(record);
    expect(result.evidence).toMatchObject({
      pr_number: 42,
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      manifest: { valid: true },
      fusion: { present: true },
      final_state_consistent: true,
    });
  });

  test('runtime factory wraps coordinateMergeReady behind a service-shaped coordinator', async () => {
    const runtime = await createMergeCoordinatorRuntimeDeps({
      octokit: octokit(),
      judge: async input => ({
        schemaVersion: 'overseer-grok-merge-disposition-v1',
        disposition: 'hold',
        reason: 'judge_hold',
        woId: input.woId,
        prNumber: input.prNumber,
        headSha: input.headSha,
        baseSha: input.baseSha,
        evidenceDigest: input.evidenceDigest,
        operator: input.operator,
      }),
      readM31Proposal: async () => ({
        proposalId: 'proposal-1',
        present: true,
        verifierRegistryDigest: '3'.repeat(64),
      }),
      compareFinalState: async () => true,
    });

    expect(typeof runtime.deps.listRunsForWatch).toBe('function');
    expect(typeof runtime.deps.insertOverseerAction).toBe('function');
    expect(typeof runtime.mergeCoordinator).toBe('function');
  });
});
