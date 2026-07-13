import { describe, expect, test } from 'bun:test';
import { watchOnce } from '../watch.ts';
import type { GitHubClientDeps, OverseerRunStoreDeps, PullRequestEvidence } from '../types.ts';

const greenPr: PullRequestEvidence = {
  exists: true,
  state: 'open',
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  mergeable: true,
  pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 1 },
};

function deps(evidence: PullRequestEvidence): OverseerRunStoreDeps & GitHubClientDeps {
  return {
    listRunsForWatch: async () => [
      {
        id: 'run-1',
        woId: 'WO-TEST-01',
        owner: 'bluedevilcollectibles',
        repo: 'bdc-harness',
        status: 'failed',
        headBranch: 'wo/test',
      },
    ],
    listRunEvents: async () => [
      {
        workflow_run_id: 'run-1',
        event_type: 'node_failed',
        step_name: 'gate',
        data: { error: 'FAIL: gate rejected' },
      },
    ],
    findPullRequest: async () => evidence,
    mergePullRequest: async () => ({ merged: true }),
  };
}

describe('watch', () => {
  test('tail-node false-fail is classified as merge_ready by PR evidence', async () => {
    const [record] = await watchOnce(deps(greenPr));
    expect(record.action).toBe('merge_ready');
    expect(record.errorClass).toBe('tail_node_false_fail');
    expect(record.decision?.decision).toBe('merge_ready');
  });

  test('judge-by-PR precedence treats already merged PR as success with no escalation', async () => {
    const [record] = await watchOnce(deps({ ...greenPr, state: 'merged' }));
    expect(record.action).toBe('success');
    expect(record.errorClass).toBeUndefined();
    expect(record.decision).toBeUndefined();
  });

  test('non-tail failure escalates', async () => {
    const [record] = await watchOnce(
      deps({
        exists: false,
        state: 'missing',
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        mergeable: null,
      })
    );
    expect(record.action).toBe('escalate');
    expect(record.errorClass).toBe('unknown');
  });
});
