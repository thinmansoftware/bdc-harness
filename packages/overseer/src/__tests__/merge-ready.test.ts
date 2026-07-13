import { describe, expect, mock, test } from 'bun:test';
import { handleMergeReady } from '../actions/merge-ready.ts';
import type { WatchedRunRecord } from '../types.ts';

function record(repo: string): WatchedRunRecord {
  return {
    runId: `run-${repo}`,
    woId: 'WO-TEST-01',
    owner: 'bluedevilcollectibles',
    repo,
    status: 'failed',
    errorClass: 'tail_node_false_fail',
    action: 'merge_ready',
    reason: 'failed run has green, mergeable PR evidence',
    prEvidence: {
      exists: true,
      state: 'open',
      checks: { total: 1, passed: 1, failed: 0, pending: 0 },
      mergeable: true,
      pr: { owner: 'bluedevilcollectibles', repo, number: 12 },
    },
  };
}

describe('merge-ready action', () => {
  test('tail-node false-fail internal repo merges and writes overseer_actions row', async () => {
    const mergePullRequest = mock(async () => ({ merged: true, message: 'merged' }));
    const insertOverseerAction = mock(async () => undefined);

    const result = await handleMergeReady(record('bdc-harness'), {
      findPullRequest: async () => {
        throw new Error('not used');
      },
      mergePullRequest,
      insertOverseerAction,
    });

    expect(result.decision.decision).toBe('merge_ready');
    expect(result.merged).toBe(true);
    expect(mergePullRequest).toHaveBeenCalledTimes(1);
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-bdc-harness',
        class: 'tail_node_false_fail',
        action: 'merge_ready',
      })
    );
  });

  test('tail-node false-fail customer repo is report-only and never merges', async () => {
    const mergePullRequest = mock(async () => ({ merged: true }));
    const insertOverseerAction = mock(async () => undefined);

    const result = await handleMergeReady(record('shopops-storefront'), {
      findPullRequest: async () => {
        throw new Error('not used');
      },
      mergePullRequest,
      insertOverseerAction,
    });

    expect(result.action).toBe('report_only');
    expect(result.merged).toBe(false);
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'report_only' })
    );
  });
});
