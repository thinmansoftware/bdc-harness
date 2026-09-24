import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import {
  runMergeExecutionBridgeOnce,
  type MergeExecutionBridgeStore,
} from '../merge-execution-bridge';
import { parseMergeRepoPolicy } from '../merge-repo-policy';
import type {
  GitHubClientDeps,
  GitHubPullRequestSearchInput,
  PullRequestEvidence,
} from '../types.ts';

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

function policy(merge = true, emergencyStop = false, serviceEnabled = true, legacyDryRun = false) {
  return {
    service_enabled: serviceEnabled,
    emergency_stop: emergencyStop,
    legacy_dry_run: legacyDryRun,
    capability_flags: {
      escalation: false,
      repair: false,
      branch: false,
      lifecycle: false,
      merge,
    },
  } as const;
}

function harness(
  rows: OverseerVerdictRow[],
  evidence = greenPr(),
  recentMerges = 0,
  githubExtras: Partial<GitHubClientDeps> = {}
) {
  const pending = [...rows];
  const outcomes: { verdictId: string; mutationSent: boolean; reason: string }[] = [];
  const claimReleases: { verdictId: string; reason: string }[] = [];
  const processing = new Set<string>();
  let merges = 0;
  let approvals = 0;
  let occupied = recentMerges;
  const slots = new Map<string, { released: boolean }>();
  const store: MergeExecutionBridgeStore = {
    listUnactionedVerdicts: async () => [...pending],
    claimVerdict: async verdictId => {
      if (!pending.some(row => row.id === verdictId)) return false;
      processing.add(verdictId);
      return true;
    },
    releaseVerdictClaim: async (verdictId, reason) => {
      if (!processing.has(verdictId)) return false;
      processing.delete(verdictId);
      claimReleases.push({ verdictId, reason });
      return true;
    },
    getRunById: async runId => run(runId.replace('run-', '')),
    reserveMergeSlot: async (verdictId, _since, limit) => {
      const existing = slots.get(verdictId);
      if (existing && !existing.released) return false;
      if (occupied >= limit) return false;
      occupied += 1;
      slots.set(verdictId, { released: false });
      return true;
    },
    releaseMergeSlot: async verdictId => {
      const existing = slots.get(verdictId);
      if (!existing || existing.released) return;
      existing.released = true;
      occupied -= 1;
    },
    recordOutcome: async input => {
      outcomes.push(input);
      processing.delete(input.verdictId);
      const index = pending.findIndex(row => row.id === input.verdictId);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  const github: GitHubClientDeps = {
    findPullRequest: async () => evidence,
    approvePullRequest: async input => {
      expect(input.expectedHeadSha).toBe('judged-sha');
      approvals += 1;
      return { approved: true };
    },
    mergePullRequest: async input => {
      expect(input.mergeMethod).toBe('squash');
      expect(input.expectedHeadSha).toBe('judged-sha');
      merges += 1;
      return { merged: true, mergeSha: 'merge-sha' };
    },
    ...githubExtras,
  };
  return {
    store,
    github,
    outcomes,
    claimReleases,
    get merges() {
      return merges;
    },
    get approvals() {
      return approvals;
    },
    get occupied() {
      return occupied;
    },
  };
}

afterEach(() => {
  delete process.env.OVERSEER_MAX_MERGES_PER_HOUR;
  delete process.env.OVERSEER_MERGE_REPO_CONFIG;
  delete process.env.MERGE_MANAGER_REPO_POLICY;
});

describe('merge execution bridge', () => {
  test('docs-only PR into bdc-xo main merges when docs_only is merge', async () => {
    process.env.MERGE_MANAGER_REPO_POLICY = JSON.stringify({
      'thinmansoftware/bdc-xo': { main: { unattended: true, docs_only: 'merge' } },
    });
    const h = harness(
      [verdict('xo-docs')],
      greenPr({
        baseBranch: 'main',
        changedFilePaths: ['docs/work-orders/WO.md', 'README.md'],
        pr: { owner: 'thinmansoftware', repo: 'bdc-xo', number: 2175 },
      })
    );
    h.store.getRunById = async () => ({ ...run('xo-docs'), repo: 'bdc-xo' });

    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });

    expect(h.merges).toBe(1);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
  });

  test('malformed MERGE_MANAGER_REPO_POLICY warns once and fails closed', async () => {
    const warn = mock(() => undefined);
    expect(parseMergeRepoPolicy('{"thinmansoftware/bdc-xo": {"main": nope', { warn })).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ env: 'MERGE_MANAGER_REPO_POLICY' })
    );

    process.env.MERGE_MANAGER_REPO_POLICY = '{"thinmansoftware/bdc-xo": {"main": nope';
    const h = harness([verdict('malformed')]);
    await expect(
      runMergeExecutionBridgeOnce({ store: h.store, github: h.github, readPolicy: () => policy() })
    ).resolves.toBeUndefined();
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('repo_not_allowed');
  });

  test('docs_only skip preserves the spec_only outcome and sends no mutation', async () => {
    process.env.MERGE_MANAGER_REPO_POLICY = JSON.stringify({
      'thinmansoftware/bdc-harness': { dev: { unattended: true, docs_only: 'skip' } },
    });
    const h = harness([verdict('docs-skip')], greenPr({ changedFilePaths: ['docs/WO.md'] }));

    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });

    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('spec_only');
  });

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

  test('does not execute a verdict when its claim is rejected even if it remains listed', async () => {
    const h = harness([verdict('already-claimed')]);
    h.store.claimVerdict = async () => false;
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.merges).toBe(0);
    expect(h.approvals).toBe(0);
    expect(h.outcomes).toEqual([]);
    expect(await h.store.listUnactionedVerdicts()).toHaveLength(1);
  });

  test('uses the configured per-repository integration branch allowlist', async () => {
    process.env.OVERSEER_MERGE_REPO_CONFIG = JSON.stringify({
      'thinmansoftware/new-repo': { baseBranch: 'integration' },
    });
    const h = harness([verdict('configured')], greenPr({ baseBranch: 'integration' }));
    h.store.getRunById = async () => ({ ...run('configured'), repo: 'new-repo' });
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.merges).toBe(1);
  });

  test('continues to merge when optional approval fails', async () => {
    const h = harness([verdict('approval-fails')]);
    h.github.approvePullRequest = async () => {
      throw new Error('approval unavailable');
    };
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.merges).toBe(1);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
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
    [
      'missing-pr',
      greenPr({ exists: false, state: 'missing', pr: undefined }),
      0,
      'open_pr_not_found',
    ],
    [
      'lookup-failed',
      greenPr({ exists: false, state: 'lookup_failed', pr: undefined, lookupFailed: true }),
      0,
      'pr_lookup_failed',
    ],
    ['closed', greenPr({ state: 'closed' }), 0, 'pr_not_open'],
    ['dirty', greenPr({ mergeable: false, mergeableState: 'dirty' }), 0, 'not_mergeable_dirty'],
    [
      'blocked-state',
      greenPr({ mergeable: false, mergeableState: 'blocked' }),
      0,
      'mergeable_state_not_clean',
    ],
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

  test('records a matching repo name on a non-allowlisted owner as not allowed', async () => {
    const h = harness([verdict('fork')]);
    h.store.getRunById = async () => ({ ...run('fork'), owner: 'other-org', repo: 'bdc-harness' });
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('repo_not_allowed');
  });

  test('two concurrent executions at limit-1 admit exactly one merge', async () => {
    let occupied = 3;
    const slots = new Map<string, { released: boolean }>();
    const outcomes: { verdictId: string; mutationSent: boolean; reason: string }[] = [];
    const claimReleases: { verdictId: string; reason: string }[] = [];
    let merges = 0;
    const reserveMergeSlot = async (
      verdictId: string,
      _since: string,
      limit: number
    ): Promise<boolean> => {
      const existing = slots.get(verdictId);
      if (existing && !existing.released) return false;
      if (occupied >= limit) return false;
      occupied += 1;
      slots.set(verdictId, { released: false });
      return true;
    };
    const releaseMergeSlot = async (verdictId: string): Promise<void> => {
      const existing = slots.get(verdictId);
      if (!existing || existing.released) return;
      existing.released = true;
      occupied -= 1;
    };
    const storeFor = (id: string): MergeExecutionBridgeStore => ({
      listUnactionedVerdicts: async () => [verdict(id)],
      claimVerdict: async () => true,
      releaseVerdictClaim: async (verdictId, reason) => {
        claimReleases.push({ verdictId, reason });
        return true;
      },
      getRunById: async () => run(id),
      reserveMergeSlot,
      releaseMergeSlot,
      recordOutcome: async input => {
        outcomes.push(input);
      },
    });
    const github: GitHubClientDeps = {
      findPullRequest: async () => greenPr(),
      approvePullRequest: async () => ({ approved: true }),
      mergePullRequest: async input => {
        expect(input.mergeMethod).toBe('squash');
        expect(input.expectedHeadSha).toBe('judged-sha');
        merges += 1;
        return { merged: true, mergeSha: 'merge-sha' };
      },
    };
    await Promise.all([
      runMergeExecutionBridgeOnce({
        store: storeFor('left'),
        github,
        readPolicy: () => policy(),
        maxMergesPerHour: 4,
      }),
      runMergeExecutionBridgeOnce({
        store: storeFor('right'),
        github,
        readPolicy: () => policy(),
        maxMergesPerHour: 4,
      }),
    ]);
    expect(merges).toBe(1);
    expect(outcomes.filter(row => row.reason === 'merge_executed')).toHaveLength(1);
    expect(outcomes.filter(row => row.reason === 'rate_ceiling_exceeded')).toHaveLength(0);
    expect(claimReleases).toEqual([expect.objectContaining({ reason: 'rate_ceiling_deferred' })]);
  });

  test('releases a rate-ceiling claim so a later pass can merge when capacity returns', async () => {
    const h = harness([verdict('ceiling')], greenPr(), 4);
    const options = {
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
      maxMergesPerHour: 4,
    };
    await runMergeExecutionBridgeOnce(options);
    expect(h.merges).toBe(0);
    expect(h.outcomes).toEqual([]);
    expect(h.occupied).toBe(4);
    expect(h.claimReleases).toEqual([{ verdictId: 'ceiling', reason: 'rate_ceiling_deferred' }]);
    expect(await h.store.listUnactionedVerdicts()).toHaveLength(1);

    await runMergeExecutionBridgeOnce({ ...options, maxMergesPerHour: 5 });
    expect(h.merges).toBe(1);
    expect(h.outcomes).toEqual([
      expect.objectContaining({
        verdictId: 'ceiling',
        mutationSent: true,
        reason: 'merge_executed',
      }),
    ]);
  });

  test('stops claiming further verdicts in a pass after a rate-ceiling deferral', async () => {
    const h = harness([verdict('first'), verdict('second')], greenPr(), 4);
    let claims = 0;
    const claimVerdict = h.store.claimVerdict;
    h.store.claimVerdict = async verdictId => {
      claims += 1;
      return claimVerdict(verdictId);
    };
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(claims).toBe(1);
    expect(h.merges).toBe(0);
    expect(h.outcomes).toEqual([]);
    expect(h.occupied).toBe(4);
    expect(h.claimReleases).toEqual([{ verdictId: 'first', reason: 'rate_ceiling_deferred' }]);
    expect(await h.store.listUnactionedVerdicts()).toHaveLength(2);
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
    expect(h.merges).toBe(0);
    expect(h.occupied).toBe(0);
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
    expect(h.merges).toBe(0);
    expect(h.occupied).toBe(0);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: false, reason: 'github rejected' })
    );
  });

  test.each([
    [false, false, true, false, 'merge_actions_disabled'],
    [true, true, true, false, 'emergency_stop'],
    [true, false, false, false, 'service_disabled'],
    [true, false, true, true, 'legacy_dry_run'],
  ])(
    'gates execution from live policy',
    async (merge, stop, serviceEnabled, legacyDryRun, reason) => {
      const h = harness([verdict(reason)]);
      await runMergeExecutionBridgeOnce({
        store: h.store,
        github: h.github,
        readPolicy: () => policy(merge, stop, serviceEnabled, legacyDryRun),
      });
      expect(h.merges).toBe(0);
      expect(h.outcomes[0]?.reason).toBe(reason);
    }
  );

  test('forwards verdict.head_sha as expectedHeadSha on merge and approve', async () => {
    const reviewed = 'reviewed-head-sha';
    const h = harness([verdict('pin-sha', reviewed)], greenPr({ headSha: reviewed }));
    const seen: { merge?: string; approve?: string } = {};
    h.github.approvePullRequest = async input => {
      seen.approve = input.expectedHeadSha;
      return { approved: true };
    };
    h.github.mergePullRequest = async input => {
      seen.merge = input.expectedHeadSha;
      return { merged: true, mergeSha: 'merge-sha' };
    };
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(seen.merge).toBe(reviewed);
    expect(seen.approve).toBe(reviewed);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
  });

  test('releases a claim when getRunById throws so the next cycle can merge', async () => {
    const h = harness([verdict('lookup-throws')]);
    let lookups = 0;
    h.store.getRunById = async runId => {
      lookups += 1;
      if (lookups === 1) throw new Error('db unavailable');
      return run(runId.replace('run-', ''));
    };
    const options = { store: h.store, github: h.github, readPolicy: () => policy() };
    await runMergeExecutionBridgeOnce(options);
    expect(h.merges).toBe(0);
    expect(h.outcomes).toEqual([]);
    expect(h.claimReleases).toEqual([{ verdictId: 'lookup-throws', reason: 'db unavailable' }]);
    expect(await h.store.listUnactionedVerdicts()).toHaveLength(1);
    await runMergeExecutionBridgeOnce(options);
    expect(h.merges).toBe(1);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
  });

  test('releases the merge slot and claim when findPullRequest throws after a reservation', async () => {
    const h = harness([verdict('pr-throws')]);
    expect(await h.store.reserveMergeSlot('pr-throws', '2026-09-14T00:00:00.000Z', 4)).toBe(true);
    expect(h.occupied).toBe(1);
    h.github.findPullRequest = async () => {
      throw new Error('github unavailable');
    };
    const options = { store: h.store, github: h.github, readPolicy: () => policy() };
    await runMergeExecutionBridgeOnce(options);
    expect(h.merges).toBe(0);
    expect(h.occupied).toBe(0);
    expect(h.outcomes).toEqual([]);
    expect(h.claimReleases).toEqual([{ verdictId: 'pr-throws', reason: 'github unavailable' }]);
    expect(await h.store.listUnactionedVerdicts()).toHaveLength(1);
    h.github.findPullRequest = async () => greenPr();
    await runMergeExecutionBridgeOnce(options);
    expect(h.merges).toBe(1);
    expect(h.occupied).toBe(1);
  });

  test('does not un-finalize a recorded outcome when releaseVerdictClaim is invoked', async () => {
    const h = harness([verdict('finalized')]);
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
    expect(h.claimReleases).toEqual([]);
    expect(await h.store.releaseVerdictClaim('finalized', 'should-not-unfinalize')).toBe(false);
    expect(await h.store.listUnactionedVerdicts()).toHaveLength(0);
  });

  test('keeps claim and slot when merge succeeds and recordOutcome throws once', async () => {
    const h = harness([verdict('persist-throws')]);
    const record = h.store.recordOutcome;
    let recordCalls = 0;
    h.store.recordOutcome = async input => {
      recordCalls += 1;
      if (recordCalls === 1) throw new Error('db write failed');
      return record(input);
    };
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.merges).toBe(1);
    expect(h.occupied).toBe(1);
    expect(h.claimReleases).toEqual([]);
    expect(recordCalls).toBe(2);
    expect(h.outcomes).toEqual([
      expect.objectContaining({
        verdictId: 'persist-throws',
        mutationSent: true,
        reason: 'merge_executed_outcome_unpersisted:db write failed',
      }),
    ]);
    expect(await h.store.listUnactionedVerdicts()).toHaveLength(0);
  });
});

const RUNLESS_PR = 844;

const runlessVerdict = (
  id: string,
  overrides: Partial<Pick<OverseerVerdictRow, 'run_id' | 'wo_id' | 'head_sha'>> = {}
): OverseerVerdictRow =>
  ({
    id,
    run_id: `pr-discovery:thinmansoftware/bdc-harness#${RUNLESS_PR}`,
    wo_id: `gh:thinmansoftware/bdc-harness#${RUNLESS_PR}`,
    head_sha: 'judged-sha',
    proposed_action: 'flag_merge_ready',
    ...overrides,
  }) as OverseerVerdictRow;

const runlessPr = (overrides: Partial<PullRequestEvidence> = {}): PullRequestEvidence =>
  greenPr({
    htmlUrl: `https://github.test/pr/${RUNLESS_PR}`,
    pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: RUNLESS_PR },
    ...overrides,
  });

function runlessHarness(rows: OverseerVerdictRow[], evidence = runlessPr()) {
  const h = harness(rows, evidence);
  const searches: GitHubPullRequestSearchInput[] = [];
  let runLookups = 0;
  h.store.getRunById = async () => {
    runLookups += 1;
    return null;
  };
  h.github.findPullRequest = async input => {
    searches.push(input);
    return evidence;
  };
  return { h, searches, runLookups: (): number => runLookups };
}

async function runOnce(h: ReturnType<typeof harness>): Promise<void> {
  await runMergeExecutionBridgeOnce({
    store: h.store,
    github: h.github,
    readPolicy: () => policy(),
  });
}

describe('merge execution bridge -- run-less verdicts (#846)', () => {
  test('(a) merges a run-less verdict on an open allowlisted PR via the same mutation path', async () => {
    const { h, searches, runLookups } = runlessHarness([runlessVerdict('runless-ok')]);
    const seen: { number?: number; expectedHeadSha?: string } = {};
    const merge = h.github.mergePullRequest;
    h.github.mergePullRequest = async input => {
      seen.number = input.number;
      seen.expectedHeadSha = input.expectedHeadSha;
      return merge(input);
    };
    await runOnce(h);
    expect(runLookups()).toBe(0);
    expect(searches).toEqual([
      {
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: RUNLESS_PR,
        includeChangedFiles: true,
      },
    ]);
    expect(h.merges).toBe(1);
    expect(h.approvals).toBe(1);
    expect(h.occupied).toBe(1);
    expect(seen).toEqual({ number: RUNLESS_PR, expectedHeadSha: 'judged-sha' });
    expect(h.outcomes).toEqual([
      expect.objectContaining({
        verdictId: 'runless-ok',
        mutationSent: true,
        reason: 'merge_executed',
      }),
    ]);
  });

  test('(b) skips a run-less verdict whose PR targets a base outside the allowlist', async () => {
    const { h, searches } = runlessHarness(
      [runlessVerdict('runless-base')],
      runlessPr({ baseBranch: 'master' })
    );
    await runOnce(h);
    expect(searches).toHaveLength(1);
    expect(h.merges).toBe(0);
    expect(h.occupied).toBe(0);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: false, reason: 'base_not_allowlisted' })
    );
  });

  test.each([
    ['(c) closed PR', runlessPr({ state: 'closed' }), 'pr_not_open'],
    ['(c) merged PR', runlessPr({ state: 'merged' }), 'pr_not_open'],
    ['(d) moved head', runlessPr({ headSha: 'moved' }), 'head_moved'],
    [
      '(e) lookup failed',
      runlessPr({ exists: false, state: 'lookup_failed', pr: undefined, lookupFailed: true }),
      'pr_context_unresolvable',
    ],
  ])('%s is recorded honestly with no mutation', async (_label, evidence, reason) => {
    const { h } = runlessHarness([runlessVerdict('runless-skip')], evidence);
    await runOnce(h);
    expect(h.merges).toBe(0);
    expect(h.approvals).toBe(0);
    expect(h.occupied).toBe(0);
    expect(h.outcomes[0]).toEqual(expect.objectContaining({ mutationSent: false, reason }));
  });

  test('(e) records pr_context_unresolvable and sends no mutation when the fetch throws', async () => {
    const { h } = runlessHarness([runlessVerdict('runless-throws')]);
    h.github.findPullRequest = async () => {
      throw new Error('github unavailable');
    };
    await runOnce(h);
    expect(h.merges).toBe(0);
    expect(h.approvals).toBe(0);
    expect(h.occupied).toBe(0);
    expect(h.claimReleases).toEqual([]);
    expect(h.outcomes).toEqual([
      expect.objectContaining({
        verdictId: 'runless-throws',
        mutationSent: false,
        reason: 'pr_context_unresolvable',
      }),
    ]);
    expect(await h.store.listUnactionedVerdicts()).toHaveLength(0);
  });

  test('(f) a verdict WITH a run id whose run row is missing still records run_context_unresolvable', async () => {
    const { h, searches, runLookups } = runlessHarness([verdict('run-gone')]);
    await runOnce(h);
    expect(runLookups()).toBe(1);
    expect(searches).toEqual([]);
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('run_context_unresolvable');
  });

  test('resolves the PR from a gh: wo_id when the run id is empty', async () => {
    const { h, searches } = runlessHarness([runlessVerdict('runless-wo', { run_id: '' })]);
    await runOnce(h);
    expect(searches[0]?.prNumber).toBe(RUNLESS_PR);
    expect(h.merges).toBe(1);
  });

  test('records pr_context_unresolvable without calling GitHub when no PR identity exists', async () => {
    const { h, searches } = runlessHarness([
      runlessVerdict('runless-blank', { run_id: '', wo_id: 'WO-TEST' }),
    ]);
    await runOnce(h);
    expect(searches).toEqual([]);
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('pr_context_unresolvable');
  });

  test('records repo_not_allowed without calling GitHub for a run-less PR outside the allowlist', async () => {
    const { h, searches } = runlessHarness([
      runlessVerdict('runless-repo', {
        run_id: 'pr-discovery:other-org/bdc-harness#7',
        wo_id: 'gh:other-org/bdc-harness#7',
      }),
    ]);
    await runOnce(h);
    expect(searches).toEqual([]);
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('repo_not_allowed');
  });

  test('receipt posts one comment with marker, head sha, and merge sha', async () => {
    const bodies: string[] = [];
    const h = harness([verdict('receipt-once')], greenPr(), 0, {
      listPullRequestComments: async () => [],
      commentOnPullRequest: async input => {
        bodies.push(input.body);
        return { commented: true };
      },
    });
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('<!-- merge-manager-receipt -->');
    expect(bodies[0]).toContain('judged-s');
    expect(bodies[0]).toContain('merge-sh');
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
  });

  test('receipt replay posts nothing when the marker comment already exists', async () => {
    const bodies: string[] = [];
    const h = harness([verdict('receipt-replay')], greenPr(), 0, {
      listPullRequestComments: async () => [{ body: '<!-- merge-manager-receipt -->\nalready' }],
      commentOnPullRequest: async input => {
        bodies.push(input.body);
        return { commented: true };
      },
    });
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.merges).toBe(1);
    expect(bodies).toEqual([]);
    expect(h.outcomes[0]?.reason).toBe('merge_executed');
  });

  test('receipt comment failure stays non-fatal and keeps merge_executed', async () => {
    const h = harness([verdict('receipt-fail')], greenPr(), 0, {
      listPullRequestComments: async () => [],
      commentOnPullRequest: async () => {
        throw new Error('comment rejected');
      },
    });
    await expect(
      runMergeExecutionBridgeOnce({
        store: h.store,
        github: h.github,
        readPolicy: () => policy(),
      })
    ).resolves.toBeUndefined();
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
    expect(h.claimReleases).toEqual([]);
    expect(h.occupied).toBe(1);
  });

  test('receipt is a no-throw when commentOnPullRequest is absent', async () => {
    const h = harness([verdict('receipt-absent')]);
    expect(h.github.commentOnPullRequest).toBeUndefined();
    await expect(
      runMergeExecutionBridgeOnce({
        store: h.store,
        github: h.github,
        readPolicy: () => policy(),
      })
    ).resolves.toBeUndefined();
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
    expect(h.claimReleases).toEqual([]);
  });

  test('receipt skip, hold, and failed merge post no comment', async () => {
    const bodies: string[] = [];
    const commentOnPullRequest = async (input: {
      body: string;
    }): Promise<{ commented: boolean }> => {
      bodies.push(input.body);
      return { commented: true };
    };
    const skipped = harness(
      [verdict('receipt-skip')],
      greenPr({ checks: { total: 1, passed: 0, failed: 0, pending: 1 } }),
      0,
      { commentOnPullRequest }
    );
    await runMergeExecutionBridgeOnce({
      store: skipped.store,
      github: skipped.github,
      readPolicy: () => policy(),
    });
    const held = harness([verdict('receipt-hold')], greenPr(), 4, { commentOnPullRequest });
    await runMergeExecutionBridgeOnce({
      store: held.store,
      github: held.github,
      readPolicy: () => policy(),
      maxMergesPerHour: 4,
    });
    const failed = harness([verdict('receipt-failed')], greenPr(), 0, {
      commentOnPullRequest,
      mergePullRequest: async () => ({ merged: false, message: 'merge_failed' }),
    });
    await runMergeExecutionBridgeOnce({
      store: failed.store,
      github: failed.github,
      readPolicy: () => policy(),
    });
    expect(bodies).toEqual([]);
    expect(skipped.outcomes[0]?.reason).toBe('required_checks_not_success');
    expect(held.claimReleases).toEqual([
      { verdictId: 'receipt-hold', reason: 'rate_ceiling_deferred' },
    ]);
    expect(failed.outcomes[0]?.reason).toBe('merge_failed');
  });

  test('receipt body is ASCII and contains no at-sign', async () => {
    const bodies: string[] = [];
    const h = harness([verdict('receipt-ascii')], greenPr(), 0, {
      commentOnPullRequest: async input => {
        bodies.push(input.body);
        return { commented: true };
      },
    });
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? '';
    expect(/^[\x00-\x7F]*$/.test(body)).toBe(true);
    expect(body.includes('@')).toBe(false);
    expect(body).toContain('policy thinmansoftware/bdc-harness:dev');
  });
});
