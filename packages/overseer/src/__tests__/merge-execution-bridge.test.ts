import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import { rootLogger } from '@archon/paths';
import {
  buildCeScopeCompareAdapter,
  runMergeExecutionBridgeOnce as runMergeExecutionBridgeOnceProduction,
  type MergeExecutionBridgeOptions,
  type MergeExecutionBridgeStore,
} from '../merge-execution-bridge';
import { readWoSpecForMergeHold, specDeclaresMergeHold } from '../merge-hold';
import { parseMergeRepoPolicy } from '../merge-repo-policy';
import {
  REQUIRED_CONTEXTS_BLOCKED_REASON,
  REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV,
  REQUIRED_CONTEXTS_OVERRIDE_ENV,
  resetRequiredContextsAttemptCounters,
  resetRequiredContextsCache,
} from '../adapters/required-contexts.ts';
import type { RecheckCheckRun } from '../pr-review-check-ingest.ts';
import type {
  GitHubClientDeps,
  GitHubPullRequestSearchInput,
  PullRequestEvidence,
} from '../types.ts';

const runMergeExecutionBridgeOnce = (options: MergeExecutionBridgeOptions): Promise<void> =>
  runMergeExecutionBridgeOnceProduction({
    hasQualifiedReview: async () => true,
    reviewConflictAtHead: async () => null,
    ...options,
  });

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
    getEarliestMergeSlotReservation: async () =>
      new Date(Date.now() - 50 * 60 * 1000).toISOString(),
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
    listPullRequestComments: async () => [],
    commentOnPullRequest: async () => ({ commented: true }),
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

function captureRootLogLines(): { lines: string[]; restore: () => void } {
  const streamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
    symbol => symbol.description === 'pino.stream'
  );
  if (!streamSymbol) throw new Error('pino.stream symbol missing on rootLogger');
  const stream = (rootLogger as unknown as Record<symbol, { write: (line: string) => void }>)[
    streamSymbol
  ];
  const lines: string[] = [];
  const write = spyOn(stream, 'write').mockImplementation(line => {
    lines.push(String(line));
  });
  return { lines, restore: () => write.mockRestore() };
}

function expectCoordinatorWarn(
  lines: string[],
  msg: string,
  fields: Record<string, unknown>
): Record<string, unknown> {
  const raw = lines.find(line => line.includes(msg));
  expect(raw).toBeDefined();
  const start = raw!.indexOf('{');
  expect(start).toBeGreaterThanOrEqual(0);
  const parsed = JSON.parse(raw!.slice(start)) as Record<string, unknown>;
  expect(parsed.msg).toBe(msg);
  expect(parsed).toEqual(expect.objectContaining(fields));
  return parsed;
}

afterEach(() => {
  delete process.env.OVERSEER_MAX_MERGES_PER_HOUR;
  delete process.env.OVERSEER_MERGE_REPO_CONFIG;
  delete process.env.MERGE_MANAGER_REPO_POLICY;
});

describe('merge execution bridge', () => {
  test('fails closed when exact-head review qualification is not wired', async () => {
    const h = harness([verdict('qualification-missing')]);
    await runMergeExecutionBridgeOnceProduction({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('review_execution_unqualified');
  });

  describe('exact-head review conflict (WO-HARNESS-MERGE-GATE-REFUSE-CONFLICTING-VERDICTS-01)', () => {
    test('Test 1: approved_then_changes_requested_no_merge', async () => {
      const h = harness([verdict('cr-at-head')]);
      await runMergeExecutionBridgeOnce({
        store: h.store,
        github: h.github,
        readPolicy: () => policy(),
        reviewConflictAtHead: async input => {
          expect(input).toEqual({
            owner: 'thinmansoftware',
            repo: 'bdc-harness',
            number: 1,
            headSha: 'judged-sha',
          });
          return 'changes_requested';
        },
      });
      expect(h.merges).toBe(0);
      expect(h.occupied).toBe(0);
      expect(h.outcomes[0]).toEqual(
        expect.objectContaining({
          mutationSent: false,
          reason: 'review_conflict_at_head:changes_requested',
        })
      );
    });

    test('Test 2: review_in_flight_no_merge', async () => {
      const h = harness([verdict('in-flight')]);
      const deferrals: { verdictId: string; reason: string }[] = [];
      h.store.deferVerdictClaim = async (verdictId, reason) => {
        deferrals.push({ verdictId, reason });
        return true;
      };
      const capture = captureRootLogLines();
      try {
        await runMergeExecutionBridgeOnce({
          store: h.store,
          github: h.github,
          readPolicy: () => policy(),
          reviewConflictAtHead: async () => 'review_in_flight',
        });
        expectCoordinatorWarn(
          capture.lines,
          'merge-coordinator.merge_refused_conflicting_reviews',
          {
            verdictId: 'in-flight',
            conflict: 'review_in_flight',
          }
        );
      } finally {
        capture.restore();
      }
      expect(h.merges).toBe(0);
      expect(h.occupied).toBe(0);
      expect(h.outcomes).toEqual([]);
      expect(deferrals).toEqual([
        { verdictId: 'in-flight', reason: 'review_conflict_at_head:review_in_flight' },
      ]);
    });

    test('Test 3: no_conflict_merges', async () => {
      const h = harness([verdict('no-conflict')]);
      await runMergeExecutionBridgeOnce({
        store: h.store,
        github: h.github,
        readPolicy: () => policy(),
        reviewConflictAtHead: async () => null,
      });
      expect(h.merges).toBe(1);
    });

    test('Test 4: missing_dep_fails_closed', async () => {
      const h = harness([verdict('conflict-missing')]);
      await runMergeExecutionBridgeOnceProduction({
        store: h.store,
        github: h.github,
        readPolicy: () => policy(),
        hasQualifiedReview: async () => true,
      });
      expect(h.merges).toBe(0);
      expect(h.outcomes[0]?.reason).toBe('review_conflict_at_head:check_unavailable');
    });

    test('a throwing conflict lookup fails closed as lookup_failed', async () => {
      const h = harness([verdict('conflict-throws')]);
      await runMergeExecutionBridgeOnce({
        store: h.store,
        github: h.github,
        readPolicy: () => policy(),
        reviewConflictAtHead: async () => {
          throw new Error('db down');
        },
      });
      expect(h.merges).toBe(0);
      expect(h.outcomes[0]?.reason).toBe('review_conflict_at_head:lookup_failed');
    });
  });

  test('production CE compare adapter accepts 150 page-one files as complete', async () => {
    const compareCommits = mock(async () => ({
      data: {
        files: Array.from({ length: 150 }, (_, index) => ({
          filename: `src/components/ce/file-${index}.ts`,
          status: 'modified',
        })),
      },
    }));
    const result = await buildCeScopeCompareAdapter({ repos: { compareCommits } })(
      'thinmansoftware',
      'lspro-react',
      'base',
      'head'
    );

    expect(compareCommits).toHaveBeenCalledTimes(1);
    expect(compareCommits).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
    expect(result.files).toHaveLength(150);
    expect(result.complete).toBe(true);
  });

  test('production CE compare adapter rejects the 300-file cap as truncated', async () => {
    const compareCommits = mock(async () => ({
      data: {
        files: Array.from({ length: 300 }, (_, index) => ({
          filename: `src/components/ce/file-${index}.ts`,
          status: 'modified',
        })),
      },
    }));
    const result = await buildCeScopeCompareAdapter({ repos: { compareCommits } })(
      'thinmansoftware',
      'lspro-react',
      'base',
      'head'
    );

    expect(compareCommits).toHaveBeenCalledTimes(1);
    expect(result.files).toHaveLength(300);
    expect(result.complete).toBe(false);
  });

  test('production CE compare adapter rejects a missing files array as truncated', async () => {
    const compareCommits = mock(async () => ({ data: {} }));
    const result = await buildCeScopeCompareAdapter({ repos: { compareCommits } })(
      'thinmansoftware',
      'lspro-react',
      'base',
      'head'
    );

    expect(compareCommits).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ complete: false });
  });

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
      getEarliestMergeSlotReservation: async () => null,
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

  test('Test 5: production base shopops master is refused by the bridge', async () => {
    const h = harness(
      [
        {
          ...verdict('shopops-master'),
          run_id: 'pr-discovery:thinmansoftware/shopops#1',
          wo_id: 'gh:thinmansoftware/shopops#1',
        },
      ],
      greenPr({
        baseBranch: 'master',
        headSha: 'judged-sha',
        mergeable: true,
        mergeableState: 'clean',
        pr: { owner: 'thinmansoftware', repo: 'shopops', number: 1 },
      })
    );

    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });

    expect(h.merges).toBe(0);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({
        mutationSent: false,
        reason: 'base_not_allowlisted',
      })
    );
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

  test('(e) defers pr_context_fetch_failed and sends no mutation when the fetch throws', async () => {
    const { h } = runlessHarness([runlessVerdict('runless-throws')]);
    const deferrals: { verdictId: string; reason: string; notBefore: string }[] = [];
    h.store.deferVerdictClaim = async (verdictId, reason, notBefore) => {
      deferrals.push({ verdictId, reason, notBefore });
      return true;
    };
    h.github.findPullRequest = async () => {
      throw new Error('github unavailable');
    };
    await runOnce(h);
    expect(h.merges).toBe(0);
    expect(h.approvals).toBe(0);
    expect(h.occupied).toBe(0);
    expect(h.claimReleases).toEqual([]);
    expect(h.outcomes).toEqual([]);
    expect(deferrals).toEqual([
      expect.objectContaining({ verdictId: 'runless-throws', reason: 'pr_context_fetch_failed' }),
    ]);
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
      commentAuthorLogin: 'thinman-overseer[bot]',
      listPullRequestComments: async () => [
        {
          body: [
            '<!-- merge-manager-receipt -->',
            '<!-- merge-manager-receipt-key verdict=receipt-replay head=judged-sha -->',
          ].join('\n'),
          authorLogin: 'thinman-overseer[bot]',
        },
      ],
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
    expect(bodies.filter(body => body.includes('merge-manager-receipt'))).toEqual([]);
    expect(h.outcomes[0]?.reason).toBe('merge_executed');
  });

  test('a forged receipt marker from another author cannot suppress the authoritative receipt', async () => {
    const bodies: string[] = [];
    const h = harness([verdict('receipt-forged-author')], greenPr(), 0, {
      commentAuthorLogin: 'thinman-overseer[bot]',
      listPullRequestComments: async () => [
        {
          body: '<!-- merge-manager-receipt -->\nforged receipt',
          authorLogin: 'pull-request-author',
        },
      ],
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
  });

  test('a trusted receipt marker for a different verdict and head cannot suppress this receipt', async () => {
    const bodies: string[] = [];
    const h = harness([verdict('receipt-bound')], greenPr(), 0, {
      commentAuthorLogin: 'thinman-overseer[bot]',
      listPullRequestComments: async () => [
        {
          body: [
            '<!-- merge-manager-receipt -->',
            '<!-- merge-manager-receipt-key verdict=other-verdict head=other-head -->',
          ].join('\n'),
          authorLogin: 'thinman-overseer[bot]',
        },
      ],
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
    expect(bodies[0]).toContain(
      '<!-- merge-manager-receipt-key verdict=receipt-bound head=judged-sha -->'
    );
  });

  test('receipt comment failure stays non-fatal and keeps merge_executed', async () => {
    const captured = captureRootLogLines();
    try {
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
      const failed = expectCoordinatorWarn(
        captured.lines,
        'merge-coordinator.receipt_comment_failed',
        {
          verdictId: 'receipt-fail',
          prUrl: 'https://github.test/pr/1',
          module: 'overseer/merge-coordinator',
        }
      );
      expect(failed.err).toEqual(expect.objectContaining({ message: 'comment rejected' }));
    } finally {
      captured.restore();
    }
  });

  test('receipt is a no-throw when commentOnPullRequest is absent', async () => {
    const captured = captureRootLogLines();
    try {
      const h = harness([verdict('receipt-absent')], greenPr(), 0, {
        commentOnPullRequest: undefined,
      });
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
      expectCoordinatorWarn(captured.lines, 'merge-coordinator.receipt_comment_unavailable', {
        verdictId: 'receipt-absent',
        prUrl: 'https://github.test/pr/1',
        module: 'overseer/merge-coordinator',
      });
    } finally {
      captured.restore();
    }
  });

  test('receipt skip, hold, and failed merge post no receipt', async () => {
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
    expect(bodies.filter(body => body.includes('merge-manager-receipt'))).toEqual([]);
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

  // Overseer review, PR #918, [major]: baseBranch and policyLabel are
  // interpolated from live GitHub data. baseBranch itself is constrained by
  // the repo allowlist gate (only 'dev'/'staging'/'main' reach the receipt),
  // but policyLabel embeds the owner/repo identity, which is attacker-
  // influenced on the run-less PR-discovery path (bdc-harness #846) -- a
  // fork can be opened as 'owner' string content the bridge never validates
  // as a GitHub handle shape. Unsanitized, this either breaks the documented
  // ASCII/no-at-sign receipt contract or triggers an unwanted GitHub @mention.
  test('receipt sanitizes an at-sign in the policy label owner/repo identity', async () => {
    const bodies: string[] = [];
    const h = harness([verdict('receipt-adversarial-policy')], greenPr(), 0, {
      commentOnPullRequest: async input => {
        bodies.push(input.body);
        return { commented: true };
      },
      findPullRequest: async () => ({
        ...greenPr(),
        // A run/PR identity string is still attacker-influenced data flowing
        // into policyLabel via `${ownerRepo}:${baseBranch}`.
        pr: { owner: '@evil-owner', repo: 'bdc-harness', number: 1 },
      }),
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
    expect(body).toContain('policy (at)evil-owner/bdc-harness:dev');
  });

  test('receipt strips non-ASCII bytes from the policy label owner/repo identity', async () => {
    const bodies: string[] = [];
    const h = harness([verdict('receipt-non-ascii-policy')], greenPr(), 0, {
      commentOnPullRequest: async input => {
        bodies.push(input.body);
        return { commented: true };
      },
      findPullRequest: async () => ({
        ...greenPr(),
        pr: { owner: 'thinman\u00e9soft\u00e8ware', repo: 'bdc-harness', number: 1 },
      }),
    });
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? '';
    expect(/^[\x00-\x7F]*$/.test(body)).toBe(true);
    expect(body).toContain('policy thinmansoftware/bdc-harness:dev');
  });
});

function httpStatusError(status: number): Error & { status: number } {
  const error = new Error(`github status ${status}`) as Error & { status: number };
  error.status = status;
  return error;
}

describe('merge hold', () => {
  test('spec hold blocks an otherwise mergeable PR', async () => {
    const row = { ...verdict('spec-hold'), wo_id: 'WO-X-01' };
    const h = harness([row], greenPr());
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
      readWoSpec: async () => 'WO: WO-X-01\nmerge_hold: true\n',
    });
    expect(h.merges).toBe(0);
    expect(h.approvals).toBe(0);
    expect(h.outcomes).toEqual([]);
    expect(h.claimReleases).toEqual([{ verdictId: 'spec-hold', reason: 'merge_hold' }]);
  });

  test('header parsing is strict', () => {
    expect(specDeclaresMergeHold('merge_hold: false')).toBe(false);
    expect(specDeclaresMergeHold('merge_hold: true # note')).toBe(false);
    expect(specDeclaresMergeHold('The words merge_hold true appear in a prose paragraph.')).toBe(
      false
    );
    expect(specDeclaresMergeHold(' merge_hold: true')).toBe(false);
    expect(specDeclaresMergeHold('merge_hold: true')).toBe(true);
    expect(specDeclaresMergeHold('merge_hold: true   ')).toBe(true);
    expect(specDeclaresMergeHold('Merge_Hold: TRUE')).toBe(true);
    expect(specDeclaresMergeHold('WO: WO-X-01\nmerge_hold: true\n\nBody text.\n')).toBe(true);
    // `\s` used to swallow the newline and treat the next line's `true` as the value.
    expect(specDeclaresMergeHold('merge_hold:\ntrue')).toBe(false);
    expect(specDeclaresMergeHold('merge_hold:\r\ntrue')).toBe(false);
    expect(specDeclaresMergeHold('merge_hold: \ntrue')).toBe(false);
    expect(specDeclaresMergeHold('WO: WO-X-01\nmerge_hold:\ntrue\n')).toBe(false);
    expect(specDeclaresMergeHold('merge_hold: true\r\n')).toBe(true);
  });

  test('malformed spec bytes throw so the hold stays unverified', async () => {
    const woId = 'WO-X-01';
    const clientFor = (content: string, encoding = 'base64') => ({
      repos: {
        getContent: async () => ({
          data: { type: 'file' as const, encoding, content },
        }),
      },
    });

    const malformed = readWoSpecForMergeHold(woId, clientFor('!!!!'));
    await expect(malformed).rejects.toMatchObject({
      message: 'wo_spec_decode_failed',
      status: 422,
    });

    const missingPadding = readWoSpecForMergeHold(woId, clientFor('YQ'));
    await expect(missingPadding).rejects.toMatchObject({ status: 422 });

    const invalidUtf8 = readWoSpecForMergeHold(
      woId,
      clientFor(Buffer.from([0xff, 0xfe]).toString('base64'))
    );
    await expect(invalidUtf8).rejects.toMatchObject({
      message: 'wo_spec_decode_failed',
      status: 422,
    });

    const spec = 'WO: WO-X-01\nmerge_hold: true\n';
    const wrapped = Buffer.from(spec).toString('base64').replace(/.{60}/g, '$&\n');
    await expect(readWoSpecForMergeHold(woId, clientFor(wrapped))).resolves.toBe(spec);
  });

  test('lifting the hold merges normally', async () => {
    let spec = 'WO: WO-X-01\nmerge_hold: true\n';
    const row = { ...verdict('lift-hold'), wo_id: 'WO-X-01' };
    const h = harness([row], greenPr());
    const options = {
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
      readWoSpec: async (): Promise<string> => spec,
    };
    await runMergeExecutionBridgeOnce(options);
    expect(h.merges).toBe(0);
    expect(h.approvals).toBe(0);
    expect(h.outcomes).toEqual([]);
    expect(h.claimReleases).toEqual([{ verdictId: 'lift-hold', reason: 'merge_hold' }]);

    spec = 'WO: WO-X-01\n\nThe hold line is gone.\n';
    await runMergeExecutionBridgeOnce(options);
    expect(h.merges).toBe(1);
    expect(h.approvals).toBe(1);
    expect(h.outcomes).toEqual([
      expect.objectContaining({
        verdictId: 'lift-hold',
        mutationSent: true,
        reason: 'merge_executed',
      }),
    ]);
  });

  test('malformed spec base64 defers, never merges', async () => {
    const row = { ...verdict('bad-b64'), wo_id: 'WO-X-01' };
    const h = harness([row], greenPr());
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
      readWoSpec: woId =>
        readWoSpecForMergeHold(woId, {
          repos: {
            getContent: async () => ({
              data: { type: 'file', encoding: 'base64', content: '!!!!' },
            }),
          },
        }),
    });
    expect(h.merges).toBe(0);
    expect(h.approvals).toBe(0);
    expect(h.outcomes).toEqual([]);
    expect(h.claimReleases).toEqual([{ verdictId: 'bad-b64', reason: 'merge_hold_unverified' }]);
  });

  test('fetch error defers, never merges', async () => {
    const row = { ...verdict('fetch-502'), wo_id: 'WO-X-01' };
    const h = harness([row], greenPr());
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
      readWoSpec: async () => {
        throw httpStatusError(502);
      },
    });
    expect(h.merges).toBe(0);
    expect(h.approvals).toBe(0);
    expect(h.outcomes).toEqual([]);
    expect(h.claimReleases).toEqual([{ verdictId: 'fetch-502', reason: 'merge_hold_unverified' }]);
  });

  test('missing spec is no hold', async () => {
    const row = { ...verdict('missing-spec'), wo_id: 'WO-X-01' };
    const h = harness([row], greenPr());
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
      readWoSpec: async () => {
        throw httpStatusError(404);
      },
    });
    expect(h.merges).toBe(1);
    expect(h.approvals).toBe(1);
    expect(h.outcomes).toEqual([
      expect.objectContaining({
        verdictId: 'missing-spec',
        mutationSent: true,
        reason: 'merge_executed',
      }),
    ]);
  });

  test('label hold applies to non-WO PRs', async () => {
    const row = {
      ...verdict('label-hold'),
      run_id: 'pr-discovery:thinmansoftware/bdc-harness#5',
      wo_id: 'gh:thinmansoftware/bdc-harness#5',
    };
    const h = harness(
      [row],
      greenPr({
        labels: ['merge-hold'],
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 5 },
      })
    );
    let reads = 0;
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
      readWoSpec: async () => {
        reads += 1;
        return 'merge_hold: true\n';
      },
    });
    expect(h.merges).toBe(0);
    expect(h.approvals).toBe(0);
    expect(h.outcomes).toEqual([]);
    expect(h.claimReleases).toEqual([{ verdictId: 'label-hold', reason: 'merge_hold_label' }]);
    expect(reads).toBe(0);
  });
});

describe('merge ceiling queue notices', () => {
  const marker = '<!-- overseer:merge-ceiling-queued -->';
  const now = new Date('2026-11-03T12:00:00.000Z');
  function queued(head = 'abc', comments: string[] = []) {
    const post = mock(async (_input: { body: string }) => ({ commented: true }));
    const h = harness(
      [verdict('queued', head)],
      greenPr({
        headSha: head,
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1439 },
      }),
      4,
      {
        commentOnPullRequest: post,
        listPullRequestComments: async () => comments.map(body => ({ body, authorLogin: 'bot' })),
      }
    );
    h.store.getEarliestMergeSlotReservation = async since => {
      expect(since).toBe('2026-11-03T11:00:00.000Z');
      return '2026-11-03T11:10:00.000Z';
    };
    return {
      h,
      post,
      execute: () =>
        runMergeExecutionBridgeOnce({
          store: h.store,
          github: h.github,
          now: () => now,
          maxMergesPerHour: 4,
          readPolicy: () => policy(),
        }),
    };
  }

  test('ceiling_deferral_posts_notice', async () => {
    const { h, post, execute } = queued();
    h.store.listUnactionedVerdicts = async () => [
      verdict('a'),
      { ...verdict('other'), proposed_action: 'observe' } as OverseerVerdictRow,
      verdict('b'),
      verdict('queued', 'abc'),
    ];
    h.store.claimVerdict = async id => id === 'queued';
    await execute();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ number: 1439, body: expect.stringContaining(marker) })
    );
    const body = (post.mock.calls[0] as unknown as [{ body: string }])[0].body;
    for (const value of ['abc', 'position 3', 'ceiling 4', '2026-11-03T12:10:00.000Z']) {
      expect(body).toContain(value);
    }
  });

  test('next_slot_time_from_oldest_live_reservation', async () => {
    const { post, execute } = queued();
    await execute();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('2026-11-03T12:10:00.000Z'),
      })
    );
  });

  test('no_duplicate_notice_same_head', async () => {
    const { post, execute } = queued('abc', [`${marker}\nHead: \`abc\``]);
    await execute();
    expect(post).not.toHaveBeenCalled();
  });

  test('new_head_gets_new_notice', async () => {
    const { post, execute } = queued('def', [
      `${marker}\nHead: \`abc\``,
      `${marker}\nHead: \`def123\``,
    ]);
    await execute();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Head: `def`') })
    );
  });

  test.each(['post', 'list', 'missing-post', 'missing-list', 'lookup', 'empty', 'invalid'])(
    'comment_failure_does_not_break_deferral: %s',
    async failure => {
      const { h, execute } = queued();
      const logs = captureRootLogLines();
      const claims: string[] = [];
      const claim = h.store.claimVerdict;
      h.store.claimVerdict = async id => {
        claims.push(id);
        return claim(id);
      };
      h.store.listUnactionedVerdicts = async () => [verdict('queued', 'abc'), verdict('next')];
      const fail = async (): Promise<never> => {
        throw new Error('notice failed');
      };
      if (failure === 'post') h.github.commentOnPullRequest = fail;
      if (failure === 'list') h.github.listPullRequestComments = fail;
      if (failure === 'missing-post') h.github.commentOnPullRequest = undefined;
      if (failure === 'missing-list') h.github.listPullRequestComments = undefined;
      if (failure === 'lookup') h.store.getEarliestMergeSlotReservation = fail;
      if (failure === 'empty') h.store.getEarliestMergeSlotReservation = async () => null;
      if (failure === 'invalid') h.store.getEarliestMergeSlotReservation = async () => 'invalid';
      try {
        await execute();
        expect(h.claimReleases).toContainEqual({
          verdictId: 'queued',
          reason: 'rate_ceiling_deferred',
        });
        expect(claims).toEqual(['queued', 'next']);
        expect(
          logs.lines.some(
            line => line.includes('ceiling_queue_notice_failed') && line.includes('"level":40')
          )
        ).toBe(true);
      } finally {
        logs.restore();
      }
    }
  );
});

describe('merge execution bridge required contexts', () => {
  const required = ['docker-build', 'test (ubuntu-latest)'] as const;

  function checkRun(
    id: number,
    name: string,
    status: string,
    conclusion: string | null
  ): RecheckCheckRun {
    return { id, name, status, conclusion, completed_at: `2026-11-0${id}T00:00:00.000Z` };
  }

  function contextsLookup(
    contexts: readonly string[]
  ): NonNullable<GitHubClientDeps['requiredContextsLookups']> {
    return {
      fetchWithAppClient: async () => ({ data: [...contexts] }),
    };
  }

  async function evaluate(h: ReturnType<typeof harness>): Promise<void> {
    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });
  }

  beforeEach(() => {
    resetRequiredContextsCache();
    resetRequiredContextsAttemptCounters();
    delete process.env[REQUIRED_CONTEXTS_OVERRIDE_ENV];
    delete process.env[REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV];
  });

  afterEach(() => {
    resetRequiredContextsCache();
    resetRequiredContextsAttemptCounters();
    delete process.env[REQUIRED_CONTEXTS_OVERRIDE_ENV];
    delete process.env[REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV];
  });

  test('non-required cancelled check does not block when required checks succeed', async () => {
    const h = harness(
      [verdict('required-green')],
      greenPr({
        checks: { total: 3, passed: 2, failed: 1, pending: 0 },
        checkRuns: [
          checkRun(1, 'docker-build', 'completed', 'failure'),
          checkRun(2, ' Docker-Build ', 'completed', 'success'),
          checkRun(3, 'test (ubuntu-latest)', 'completed', 'success'),
          checkRun(4, 'test (windows-latest)', 'completed', 'cancelled'),
        ],
      }),
      0,
      { requiredContextsLookups: contextsLookup(required) }
    );
    await evaluate(h);
    expect(h.merges).toBe(1);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
  });

  test('unstable mergeable state merges when every known required context passed', async () => {
    // GitHub reports `unstable` when only a non-required check failed or was
    // cancelled, which is exactly the Windows-job case this gate exists for.
    const h = harness(
      [verdict('required-green-unstable')],
      greenPr({
        mergeableState: 'unstable',
        checks: { total: 3, passed: 2, failed: 1, pending: 0 },
        checkRuns: [
          checkRun(1, 'docker-build', 'completed', 'success'),
          checkRun(2, 'test (ubuntu-latest)', 'completed', 'success'),
          checkRun(3, 'test (windows-latest)', 'completed', 'cancelled'),
        ],
      }),
      0,
      { requiredContextsLookups: contextsLookup(required) }
    );
    await evaluate(h);
    expect(h.merges).toBe(1);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
  });

  test('a newer queued rerun beats an older completed success and blocks unstable', async () => {
    // filter=all returns the historical success next to the queued rerun. The
    // rerun has no timestamps yet; creation order (id) must still pick it.
    const h = harness(
      [verdict('required-rerun-queued')],
      greenPr({
        mergeableState: 'unstable',
        checks: { total: 3, passed: 3, failed: 0, pending: 0 },
        checkRuns: [
          checkRun(1, 'docker-build', 'completed', 'success'),
          {
            id: 9,
            name: 'docker-build',
            status: 'queued',
            conclusion: null,
            started_at: null,
            completed_at: null,
          },
          checkRun(2, 'test (ubuntu-latest)', 'completed', 'success'),
        ],
      }),
      0,
      { requiredContextsLookups: contextsLookup(required) }
    );
    await evaluate(h);
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: false, reason: 'required_checks_not_success' })
    );
  });

  test('unstable mergeable state still skips without a known required set', async () => {
    const h = harness(
      [verdict('empty-unstable')],
      greenPr({
        mergeableState: 'unstable',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        checkRuns: [checkRun(1, 'docker-build', 'completed', 'success')],
      }),
      0,
      { requiredContextsLookups: contextsLookup([]) }
    );
    await evaluate(h);
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('mergeable_state_not_clean');
  });

  test('blocked mergeable state still skips when known required contexts passed', async () => {
    const h = harness(
      [verdict('required-green-blocked')],
      greenPr({
        mergeableState: 'blocked',
        checkRuns: [
          checkRun(1, 'docker-build', 'completed', 'success'),
          checkRun(2, 'test (ubuntu-latest)', 'completed', 'success'),
        ],
      }),
      0,
      { requiredContextsLookups: contextsLookup(required) }
    );
    await evaluate(h);
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('mergeable_state_not_clean');
  });

  test('required failure still blocks and the skip log names the context', async () => {
    const captured = captureRootLogLines();
    try {
      const h = harness(
        [verdict('required-red')],
        greenPr({
          checks: { total: 2, passed: 2, failed: 0, pending: 0 },
          checkRuns: [
            checkRun(1, 'docker-build', 'completed', 'success'),
            checkRun(2, 'test (ubuntu-latest)', 'completed', 'failure'),
          ],
        }),
        0,
        { requiredContextsLookups: contextsLookup(required) }
      );
      await evaluate(h);
      expect(h.merges).toBe(0);
      expect(h.outcomes[0]).toEqual(
        expect.objectContaining({ mutationSent: false, reason: 'required_checks_not_success' })
      );
      expectCoordinatorWarn(captured.lines, 'merge-coordinator.merge_skipped', {
        reason: 'required_checks_not_success',
        blockingContexts: ['test (ubuntu-latest)'],
        prUrl: 'https://github.test/pr/1',
      });
    } finally {
      captured.restore();
    }
  });

  test('required pending check blocks even when the aggregate summary is green', async () => {
    const h = harness(
      [verdict('required-pending')],
      greenPr({
        checks: { total: 2, passed: 2, failed: 0, pending: 0 },
        checkRuns: [
          checkRun(1, 'docker-build', 'in_progress', null),
          checkRun(2, 'test (ubuntu-latest)', 'completed', 'success'),
        ],
      }),
      0,
      { requiredContextsLookups: contextsLookup(required) }
    );
    await evaluate(h);
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('required_checks_not_success');
  });

  test('missing required check blocks even when the aggregate summary is green', async () => {
    const h = harness(
      [verdict('required-missing')],
      greenPr({
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        checkRuns: [checkRun(1, 'test (ubuntu-latest)', 'completed', 'success')],
      }),
      0,
      { requiredContextsLookups: contextsLookup(required) }
    );
    await evaluate(h);
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('required_checks_not_success');
  });

  test('unknown required set falls back to aggregate checks and logs the fallback', async () => {
    const captured = captureRootLogLines();
    try {
      const h = harness(
        [verdict('required-unknown')],
        greenPr({
          checks: { total: 3, passed: 2, failed: 1, pending: 0 },
          checkRuns: [
            checkRun(1, 'docker-build', 'completed', 'success'),
            checkRun(2, 'test (ubuntu-latest)', 'completed', 'success'),
            checkRun(3, 'test (windows-latest)', 'completed', 'cancelled'),
          ],
        })
      );
      await evaluate(h);
      expect(h.merges).toBe(0);
      expect(h.outcomes[0]?.reason).toBe('required_checks_not_success');
      expectCoordinatorWarn(captured.lines, 'merge-coordinator.required_contexts_fallback', {
        state: 'unknown',
        reason: 'protection_api_unavailable',
        prUrl: 'https://github.test/pr/1',
      });
    } finally {
      captured.restore();
    }
  });

  test('authoritative empty required set merges when reported checks pass', async () => {
    const captured = captureRootLogLines();
    try {
      const h = harness(
        [verdict('empty-pass')],
        greenPr({
          checks: { total: 1, passed: 1, failed: 0, pending: 0 },
          checkRuns: [checkRun(1, 'test (windows-latest)', 'completed', 'success')],
        }),
        0,
        { requiredContextsLookups: contextsLookup([]) }
      );
      await evaluate(h);
      expect(h.merges).toBe(1);
      expect(h.outcomes[0]).toEqual(
        expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
      );
      expect(
        captured.lines.some(line => line.includes('merge-coordinator.required_contexts_fallback'))
      ).toBe(false);
    } finally {
      captured.restore();
    }
  });

  test('authoritative empty required set skips when a reported check fails', async () => {
    const captured = captureRootLogLines();
    try {
      const h = harness(
        [verdict('empty-fail')],
        greenPr({
          checks: { total: 2, passed: 1, failed: 1, pending: 0 },
          checkRuns: [
            checkRun(1, 'docker-build', 'completed', 'success'),
            checkRun(2, 'test (windows-latest)', 'completed', 'failure'),
          ],
        }),
        0,
        { requiredContextsLookups: contextsLookup([]) }
      );
      await evaluate(h);
      expect(h.merges).toBe(0);
      expect(h.outcomes[0]?.reason).toBe('required_checks_not_success');
      expect(
        captured.lines.some(line => line.includes('merge-coordinator.required_contexts_fallback'))
      ).toBe(false);
    } finally {
      captured.restore();
    }
  });

  test('exhausted required set falls back to aggregate checks and logs the fallback', async () => {
    process.env[REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV] = '1';
    const captured = captureRootLogLines();
    try {
      const head = 'exhausted-head';
      const h = harness(
        [verdict('required-exhausted', head)],
        greenPr({
          headSha: head,
          checks: { total: 1, passed: 0, failed: 1, pending: 0 },
          checkRuns: [checkRun(1, 'test (windows-latest)', 'completed', 'cancelled')],
        }),
        0,
        {
          requiredContextsLookups: {
            fetchWithAppClient: async () => {
              throw new Error('lookup_down');
            },
          },
        }
      );
      await evaluate(h);
      expect(h.merges).toBe(0);
      expect(h.outcomes[0]?.reason).toBe('required_checks_not_success');
      expectCoordinatorWarn(captured.lines, 'merge-coordinator.required_contexts_fallback', {
        state: 'exhausted',
        reason: REQUIRED_CONTEXTS_BLOCKED_REASON,
        prUrl: 'https://github.test/pr/1',
      });
    } finally {
      captured.restore();
    }
  });

  test('a newer successful commit status satisfies a required context with no check run', async () => {
    const h = harness(
      [verdict('status-green')],
      greenPr({
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        checkRuns: [checkRun(1, 'test (ubuntu-latest)', 'completed', 'success')],
        commitStatuses: [
          {
            id: 3,
            context: ' Docker-Build ',
            state: 'success',
            createdAt: '2026-11-03T00:00:00.000Z',
          },
          {
            id: 50,
            context: 'docker-build',
            state: 'failure',
            createdAt: '2026-11-01T00:00:00.000Z',
          },
        ],
      }),
      0,
      { requiredContextsLookups: contextsLookup(required) }
    );
    await evaluate(h);
    expect(h.merges).toBe(1);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
  });

  test('a newer failed commit status blocks and the skip log names the context', async () => {
    const captured = captureRootLogLines();
    try {
      const h = harness(
        [verdict('status-red')],
        greenPr({
          checks: { total: 1, passed: 1, failed: 0, pending: 0 },
          checkRuns: [checkRun(1, 'test (ubuntu-latest)', 'completed', 'success')],
          commitStatuses: [
            {
              id: 3,
              context: 'docker-build',
              state: 'success',
              createdAt: '2026-11-01T00:00:00.000Z',
            },
            {
              id: 1,
              context: 'docker-build',
              state: 'failure',
              createdAt: '2026-11-03T00:00:00.000Z',
            },
          ],
        }),
        0,
        { requiredContextsLookups: contextsLookup(required) }
      );
      await evaluate(h);
      expect(h.merges).toBe(0);
      expect(h.outcomes[0]?.reason).toBe('required_checks_not_success');
      expectCoordinatorWarn(captured.lines, 'merge-coordinator.merge_skipped', {
        reason: 'required_checks_not_success',
        blockingContexts: ['docker-build'],
        prUrl: 'https://github.test/pr/1',
      });
    } finally {
      captured.restore();
    }
  });

  test('a pending commit status blocks when the context has no check run', async () => {
    const h = harness(
      [verdict('status-pending')],
      greenPr({
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        checkRuns: [checkRun(1, 'test (ubuntu-latest)', 'completed', 'success')],
        commitStatuses: [
          {
            id: 4,
            context: 'docker-build',
            state: 'pending',
            createdAt: '2026-11-03T00:00:00.000Z',
          },
        ],
      }),
      0,
      { requiredContextsLookups: contextsLookup(required) }
    );
    await evaluate(h);
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('required_checks_not_success');
  });

  test('a successful commit status does not clear a failing check run of the same name', async () => {
    const h = harness(
      [verdict('check-beats-status')],
      greenPr({
        checks: { total: 2, passed: 1, failed: 1, pending: 0 },
        checkRuns: [
          checkRun(1, 'docker-build', 'completed', 'failure'),
          checkRun(2, 'test (ubuntu-latest)', 'completed', 'success'),
        ],
        commitStatuses: [
          {
            id: 9,
            context: 'docker-build',
            state: 'success',
            createdAt: '2026-11-04T00:00:00.000Z',
          },
        ],
      }),
      0,
      { requiredContextsLookups: contextsLookup(required) }
    );
    await evaluate(h);
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('required_checks_not_success');
  });

  test('a successful check run does not clear a newer failed commit status of the same name', async () => {
    const captured = captureRootLogLines();
    try {
      const h = harness(
        [verdict('status-and-check-red')],
        greenPr({
          checks: { total: 2, passed: 2, failed: 0, pending: 0 },
          checkRuns: [
            checkRun(1, 'docker-build', 'completed', 'success'),
            checkRun(2, 'test (ubuntu-latest)', 'completed', 'success'),
          ],
          commitStatuses: [
            {
              id: 8,
              context: 'docker-build',
              state: 'success',
              createdAt: '2026-11-01T00:00:00.000Z',
            },
            {
              id: 9,
              context: ' Docker-Build ',
              state: 'failure',
              createdAt: '2026-11-04T00:00:00.000Z',
            },
          ],
        }),
        0,
        { requiredContextsLookups: contextsLookup(required) }
      );
      await evaluate(h);
      expect(h.merges).toBe(0);
      expect(h.outcomes[0]?.reason).toBe('required_checks_not_success');
      expectCoordinatorWarn(captured.lines, 'merge-coordinator.merge_skipped', {
        reason: 'required_checks_not_success',
        blockingContexts: ['docker-build'],
        prUrl: 'https://github.test/pr/1',
      });
    } finally {
      captured.restore();
    }
  });

  test('a successful check run does not clear a pending commit status of the same name', async () => {
    const h = harness(
      [verdict('status-and-check-pending')],
      greenPr({
        checks: { total: 2, passed: 2, failed: 0, pending: 0 },
        checkRuns: [
          checkRun(1, 'docker-build', 'completed', 'success'),
          checkRun(2, 'test (ubuntu-latest)', 'completed', 'success'),
        ],
        commitStatuses: [
          {
            id: 10,
            context: 'docker-build',
            state: 'pending',
            createdAt: '2026-11-04T00:00:00.000Z',
          },
        ],
      }),
      0,
      { requiredContextsLookups: contextsLookup(required) }
    );
    await evaluate(h);
    expect(h.merges).toBe(0);
    expect(h.outcomes[0]?.reason).toBe('required_checks_not_success');
  });

  test('a required context passes when its check run and latest commit status both succeed', async () => {
    const h = harness(
      [verdict('status-and-check-green')],
      greenPr({
        checks: { total: 2, passed: 2, failed: 0, pending: 0 },
        checkRuns: [
          checkRun(1, 'docker-build', 'completed', 'success'),
          checkRun(2, 'test (ubuntu-latest)', 'completed', 'success'),
        ],
        commitStatuses: [
          {
            id: 1,
            context: 'docker-build',
            state: 'failure',
            createdAt: '2026-11-01T00:00:00.000Z',
          },
          {
            id: 11,
            context: 'docker-build',
            state: 'success',
            createdAt: '2026-11-04T00:00:00.000Z',
          },
        ],
      }),
      0,
      { requiredContextsLookups: contextsLookup(required) }
    );
    await evaluate(h);
    expect(h.merges).toBe(1);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
  });
});
