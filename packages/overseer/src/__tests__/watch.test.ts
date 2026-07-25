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

/**
 * Salvage of CANCELLED runs.
 *
 * The conductor cancels a run on stall/runaway and then EXITS -- it is a CLI
 * process, so it cannot own recovery. Overseer is the persistent watcher and picks
 * the run up at the terminal-state boundary.
 *
 * Anchor (2026-07-25): run 3ff3f773 was cancelled on a progress-timeout having
 * produced a real commit. The live container log shows Overseer reading it and
 * returning action:"ignore", reason:"terminal status cancelled does not require
 * failure handling" -- so the work was orphaned by design, not by accident.
 */
describe('watch -- cancelled-run salvage', () => {
  function cancelledDeps(evidence: PullRequestEvidence): OverseerRunStoreDeps & GitHubClientDeps {
    return {
      listRunsForWatch: async () => [
        {
          id: 'run-cancelled-1',
          woId: 'WO-SALVAGE-01',
          owner: 'bluedevilcollectibles',
          repo: 'bdc-harness',
          status: 'cancelled',
          headBranch: 'archon/thread-abc',
        },
      ],
      listRunEvents: async () => [],
      findPullRequest: async () => evidence,
      mergePullRequest: async () => ({ merged: true }),
    };
  }

  test('a cancelled run with a green mergeable PR is salvaged, not ignored', async () => {
    const [record] = await watchOnce(cancelledDeps(greenPr));

    expect(record.action).toBe('merge_ready');
    expect(record.action).not.toBe('ignore');
    expect(record.decision?.decision).toBe('merge_ready');
    expect(record.reason).toContain('salvaging orphaned work');
  });

  test('a cancelled run with NO PR is still ignored -- nothing to salvage', async () => {
    const [record] = await watchOnce(
      cancelledDeps({
        exists: false,
        state: 'missing',
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        mergeable: null,
      })
    );

    expect(record.action).toBe('ignore');
  });

  test('a cancelled run with a RED PR is not salvaged -- salvage never merges broken work', async () => {
    const [record] = await watchOnce(
      cancelledDeps({
        ...greenPr,
        checks: { total: 2, passed: 1, failed: 1, pending: 0 },
      })
    );

    expect(record.action).not.toBe('merge_ready');
  });

  test('a cancelled run whose PR is already merged reports success, not a second merge', async () => {
    const [record] = await watchOnce(cancelledDeps({ ...greenPr, state: 'merged' }));

    expect(record.action).toBe('success');
    expect(record.action).not.toBe('merge_ready');
  });
});
