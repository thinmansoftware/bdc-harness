import { describe, expect, test } from 'bun:test';
import { watchOnce } from '../watch.ts';
import type { GitHubClientDeps, OverseerRunStoreDeps, PullRequestEvidence } from '../types.ts';

const greenPr: PullRequestEvidence = {
  exists: true,
  state: 'open',
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  mergeable: true,
  pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1 },
};

function deps(evidence: PullRequestEvidence): OverseerRunStoreDeps & GitHubClientDeps {
  return {
    listRunsForWatch: async () => [
      {
        id: 'run-1',
        woId: 'WO-TEST-01',
        owner: 'thinmansoftware',
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

  test('caps each tick while preserving the store oldest-first ordering', async () => {
    const visited: string[] = [];
    const boundedDeps: OverseerRunStoreDeps & GitHubClientDeps = {
      listRunsForWatch: async () =>
        ['oldest', 'middle', 'newest'].map(id => ({
          id,
          woId: `WO-${id.toUpperCase()}`,
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          status: 'completed',
          headBranch: `fix/${id}`,
        })),
      listRunEvents: async () => [],
      findPullRequest: async input => {
        visited.push(input.headBranch ?? 'missing');
        return { ...greenPr, state: 'merged' };
      },
      mergePullRequest: async () => ({ merged: true }),
    };

    const outcomes = await watchOnce(boundedDeps, { maxRunsPerTick: 2 });

    expect(outcomes.map(outcome => outcome.runId)).toEqual(['oldest', 'middle']);
    expect(visited).toEqual(['fix/oldest', 'fix/middle']);
  });
});

/**
 * Per-run isolation (bdc-xo#1366).
 *
 * Anchor (2026-08-01 13:52:30 UTC): a GitHub search API call inside judgePullRequest
 * threw an unhandled HttpError ("operation timed out"). Before this isolation, that
 * exception propagated out of watchOnce's loop, out of watchLoop's for(;;) body, and
 * killed the entire watcher process -- overseer_verdicts saw zero new rows for 62+
 * hours until a human found it and manually restarted the container. This is the same
 * defect class #1348 already fixed one level downstream in handleRecord (a bad
 * verdict-store query killed the watcher for 28 hours on 2026-07-30); this closes the
 * matching gap one level upstream, in the run-assessment step itself.
 */
describe('watch -- per-run exception isolation', () => {
  test('one run whose PR lookup throws does not stop the rest of the batch from being assessed', async () => {
    // findPullRequest doesn't receive the run id directly, so the throw is keyed on
    // call order: first call (run-throws) rejects, second call (run-ok) succeeds.
    let call = 0;
    const deps: OverseerRunStoreDeps & GitHubClientDeps = {
      listRunsForWatch: async () => [
        {
          id: 'run-throws',
          woId: 'WO-THROWS-01',
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          status: 'failed',
          headBranch: 'archon/thread-throws',
        },
        {
          id: 'run-ok',
          woId: 'WO-OK-01',
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          status: 'failed',
          headBranch: 'archon/thread-ok',
        },
      ],
      listRunEvents: async () => [],
      findPullRequest: async () => {
        call += 1;
        if (call === 1) {
          throw new Error('operation timed out');
        }
        return greenPr;
      },
      mergePullRequest: async () => ({ merged: true }),
    };

    const outcomes = await watchOnce(deps);

    // The throwing run is dropped from the batch (logged, not returned); the healthy
    // run right after it is still assessed normally -- the watcher survives.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.runId).toBe('run-ok');
    expect(outcomes[0]?.action).toBe('merge_ready');
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
          owner: 'thinmansoftware',
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

/**
 * THE MERGE DOOR -- completed runs.
 *
 * This is the regression guard for why Overseer had merged NOTHING, ever. The merge
 * path was gated on `status === 'failed'` because it was built for one scenario (the
 * tail-node false-fail). Verified against the live event store 2026-07-25: 57
 * overseer_actions, ZERO merge-class, while 468 terminal runs sat in the watch queue
 * -- 388 completed, 58 cancelled, 22 escalated, and ZERO failed. Every candidate
 * walked past a door marked "failed runs only".
 *
 * If someone ever re-narrows this to a status allowlist, these tests fail.
 */
describe('watch -- completed-run merge candidates', () => {
  function statusDeps(
    status: string,
    evidence: PullRequestEvidence
  ): OverseerRunStoreDeps & GitHubClientDeps {
    return {
      listRunsForWatch: async () => [
        {
          id: `run-${status}-1`,
          woId: 'WO-MERGE-DOOR-01',
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          status,
          headBranch: 'archon/thread-xyz',
        },
      ],
      listRunEvents: async () => [],
      findPullRequest: async () => evidence,
      mergePullRequest: async () => ({ merged: true }),
    };
  }

  test('a COMPLETED run with a green mergeable PR is a merge candidate', async () => {
    const [record] = await watchOnce(statusDeps('completed', greenPr));

    expect(record.action).toBe('merge_ready');
    expect(record.action).not.toBe('success');
    expect(record.decision?.decision).toBe('merge_ready');
  });

  test('an ESCALATED run with a green mergeable PR is a merge candidate', async () => {
    const [record] = await watchOnce(statusDeps('escalated', greenPr));

    expect(record.action).toBe('merge_ready');
  });

  test('a FAILED run with a green PR still merges and keeps the false-fail class', async () => {
    // The original tail-node false-fail case must survive the generalization.
    const [record] = await watchOnce(statusDeps('failed', greenPr));

    expect(record.action).toBe('merge_ready');
    expect(record.errorClass).toBe('tail_node_false_fail');
  });

  test('a completed run with a RED PR is NOT a merge candidate', async () => {
    const [record] = await watchOnce(
      statusDeps('completed', {
        ...greenPr,
        checks: { total: 2, passed: 1, failed: 1, pending: 0 },
      })
    );

    expect(record.action).not.toBe('merge_ready');
  });

  test('a completed run with PENDING checks is NOT a merge candidate', async () => {
    // Merge-if-green means green, not "not yet red".
    const [record] = await watchOnce(
      statusDeps('completed', {
        ...greenPr,
        checks: { total: 2, passed: 1, failed: 0, pending: 1 },
      })
    );

    expect(record.action).not.toBe('merge_ready');
  });

  test('a completed run with an UNMERGEABLE (conflicting) PR is not a merge candidate', async () => {
    const [record] = await watchOnce(statusDeps('completed', { ...greenPr, mergeable: false }));

    expect(record.action).not.toBe('merge_ready');
    expect(record.action).toBe('success');
  });

  test('a completed run with no PR at all is not a merge candidate', async () => {
    const [record] = await watchOnce(
      statusDeps('completed', {
        exists: false,
        state: 'missing',
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        mergeable: null,
      })
    );

    expect(record.action).not.toBe('merge_ready');
  });
});
