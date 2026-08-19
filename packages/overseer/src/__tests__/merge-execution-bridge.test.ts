import { afterEach, describe, expect, test } from 'bun:test';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import {
  runMergeExecutionBridgeOnce,
  type MergeExecutionBridgeStore,
} from '../merge-execution-bridge';
import type { GitHubClientDeps, PullRequestEvidence } from '../types.ts';

const verdict = (id: string, head = 'judged-sha'): OverseerVerdictRow =>
  ({
    id,
    run_id: `run-${id}`,
    wo_id: 'WO-TEST',
    head_sha: head,
    proposed_action: 'flag_merge_ready',
  }) as OverseerVerdictRow;

const run = (id: string): OverseerWatchRun => ({
  id: `run-${id}`,
  woId: 'WO-TEST',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  status: 'completed',
  headBranch: `branch-${id}`,
  metadata: {},
});

const greenPr = (overrides: Partial<PullRequestEvidence> = {}): PullRequestEvidence => ({
  exists: true,
  state: 'open',
  checks: { total: 2, passed: 2, failed: 0, pending: 0 },
  mergeable: true,
  mergeableState: 'clean',
  changedFilePaths: ['packages/overseer/src/code.ts'],
  baseBranch: 'dev',
  headSha: 'judged-sha',
  htmlUrl: 'https://github.test/pr/1',
  pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1 },
  ...overrides,
});

function policy(merge = true, emergencyStop = false) {
  return {
    service_enabled: true,
    emergency_stop: emergencyStop,
    legacy_dry_run: false,
    capability_flags: {
      escalation: false,
      repair: false,
      branch: false,
      lifecycle: false,
      merge,
    },
  } as const;
}

function harness(rows: OverseerVerdictRow[], evidence = greenPr(), recentMerges = 0) {
  const pending = [...rows];
  const outcomes: { verdictId: string; mutationSent: boolean; reason: string }[] = [];
  let merges = 0;
  let approvals = 0;
  const store: MergeExecutionBridgeStore = {
    listUnactionedVerdicts: async () => [...pending],
    claimVerdict: async verdictId => pending.some(row => row.id === verdictId),
    getRunById: async runId => run(runId.replace('run-', '')),
    countRecentMerges: async () => recentMerges + outcomes.filter(row => row.mutationSent).length,
    recordOutcome: async input => {
      outcomes.push(input);
      const index = pending.findIndex(row => row.id === input.verdictId);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  const github: GitHubClientDeps = {
    findPullRequest: async () => evidence,
    approvePullRequest: async () => {
      approvals += 1;
      return { approved: true };
    },
    mergePullRequest: async input => {
      expect(input.mergeMethod).toBe('squash');
      merges += 1;
      return { merged: true, mergeSha: 'merge-sha' };
    },
  };
  return {
    store,
    github,
    outcomes,
    get merges() {
      return merges;
    },
    get approvals() {
      return approvals;
    },
  };
}

afterEach(() => delete process.env.OVERSEER_MAX_MERGES_PER_HOUR);

describe('merge execution bridge', () => {
  test('merges an eligible verdict exactly once across two cycles', async () => {
    const h = harness([verdict('eligible')]);
    const options = { store: h.store, github: h.github, readPolicy: () => policy() };
    await runMergeExecutionBridgeOnce(options);
    await runMergeExecutionBridgeOnce(options);
    expect(h.merges).toBe(1);
    expect(h.approvals).toBe(1);
    expect(h.outcomes).toEqual([
      expect.objectContaining({
        verdictId: 'eligible',
        mutationSent: true,
        reason: 'merge_executed',
      }),
    ]);
  });

  test.each([
    ['stale', greenPr({ headSha: 'moved' }), 0, 'verdict_stale_head'],
    [
      'red',
      greenPr({ checks: { total: 2, passed: 1, failed: 1, pending: 0 } }),
      0,
      'required_checks_not_success',
    ],
    ['docs', greenPr({ changedFilePaths: ['docs/work-orders/WO.md'] }), 0, 'spec_only'],
    ['truncated', greenPr({ changedFilePaths: undefined }), 0, 'changed_files_unresolved'],
    ['wrong-base', greenPr({ baseBranch: 'main' }), 0, 'integration_base_mismatch'],
    ['missing-pr', greenPr({ exists: false, state: 'missing', pr: undefined }), 0, 'open_pr_not_found'],
    [
      'lookup-failed',
      greenPr({ exists: false, state: 'lookup_failed', pr: undefined, lookupFailed: true }),
      0,
      'pr_lookup_failed',
    ],
    ['limited', greenPr(), 4, 'rate_ceiling_exceeded'],
  ])('records honest skip for %s', async (id, evidence, recent, reason) => {
    const h = harness([verdict(id)], evidence, recent);
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]).toEqual(expect.objectContaining({ mutationSent: false, reason }));
  });

  test('records unresolvable run context', async () => {
    const h = harness([verdict('missing')]);
    h.store.getRunById = async () => null;
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.outcomes[0]?.reason).toBe('run_context_unresolvable');
  });

  test('records a repository outside the allowlist', async () => {
    const h = harness([verdict('repo')]);
    h.store.getRunById = async () => ({ ...run('repo'), repo: 'not-allowed' });
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.outcomes[0]?.reason).toBe('repo_not_allowed');
  });

  test('records a thrown merge failure precisely', async () => {
    const h = harness([verdict('throws')]);
    h.github.mergePullRequest = async () => {
      throw new Error('network down');
    };
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: false, reason: 'merge_failed:network down' })
    );
  });

  test('records a rejected merge response precisely', async () => {
    const h = harness([verdict('rejected')]);
    h.github.mergePullRequest = async () => ({ merged: false, message: 'github rejected' });
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: false, reason: 'github rejected' })
    );
  });

  test('reconciles a merge after a crash before outcome persistence', async () => {
    const recovering = verdict('recovering');
    recovering.mutation_reason = 'processing';
    const h = harness([recovering], greenPr({ state: 'merged' }));
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
  });

  test.each([
    [false, false, 'merge_actions_disabled'],
    [true, true, 'emergency_stop'],
  ])('gates execution from live policy', async (merge, stop, reason) => {
    const h = harness([verdict(reason)]);
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(merge, stop),
    });
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe(reason);
  });
});
