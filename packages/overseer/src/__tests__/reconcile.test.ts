import { describe, expect, mock, test } from 'bun:test';
import {
  runReconcileOnce,
  type ReconcileActionRecord,
  type ReconcileDeps,
  type ReconcileMergedPullRequest,
  type ReconcileTrackerIssue,
} from '../reconcile';
import { runOverseerService } from '../service';

const stem = 'WO-HARNESS-OVERSEER-V1B-TRACKER-RECONCILE-01';

function mergedPr(overrides: Partial<ReconcileMergedPullRequest> = {}): ReconcileMergedPullRequest {
  return {
    owner: 'bluedevilcollectibles',
    repo: 'bdc-harness',
    number: 404,
    title: 'BDC feature Work Order implementation',
    body: `Implements ${stem}.`,
    htmlUrl: 'https://github.com/bluedevilcollectibles/bdc-harness/pull/404',
    state: 'closed',
    merged: true,
    mergeCommitSha: 'abc123merge',
    mergedAt: '2026-07-17T12:00:00Z',
    ...overrides,
  };
}

function trackerIssue(state: 'open' | 'closed' = 'open'): ReconcileTrackerIssue {
  return {
    owner: 'bluedevilcollectibles',
    repo: 'bdc-xo',
    number: 1044,
    title: stem,
    state,
  };
}

function fakeDeps(input: {
  prs?: ReconcileMergedPullRequest[];
  tracker?: ReconcileTrackerIssue | null;
  searchError?: unknown;
  readCursor?: string | null;
  labelError?: unknown;
  hasEvidence?: boolean;
} = {}): ReconcileDeps & {
  comments: string[];
  labels: string[];
  closes: number[];
  actions: ReconcileActionRecord[];
  warnings: string[];
  searches: Array<{ org: string; since: string }>;
} {
  const comments: string[] = [];
  const labels: string[] = [];
  const closes: number[] = [];
  const actions: ReconcileActionRecord[] = [];
  const warnings: string[] = [];
  const searches: Array<{ org: string; since: string }> = [];
  return {
    comments,
    labels,
    closes,
    actions,
    warnings,
    searches,
    readCursor: mock(async () => input.readCursor ?? null),
    now: () => new Date('2026-07-17T12:00:00Z'),
    searchMergedPullRequests: mock(async request => {
      searches.push(request);
      if (input.searchError) throw input.searchError;
      return input.prs ?? [mergedPr()];
    }),
    findTrackerIssueByStem: mock(async (candidate: string) => {
      if (candidate !== stem) return null;
      return input.tracker === undefined ? trackerIssue() : input.tracker;
    }),
    hasTrackerEvidenceComment: mock(async () => input.hasEvidence ?? false),
    addTrackerEvidenceComment: mock(async request => {
      comments.push(request.body);
    }),
    addTrackerLabel: mock(async request => {
      if (input.labelError) throw input.labelError;
      labels.push(request.label);
    }),
    closeTrackerIssue: mock(async request => {
      closes.push(request.issue.number);
    }),
    insertAction: mock(async record => {
      actions.push(record);
    }),
    log: {
      warn: (_fields, message) => {
        warnings.push(message);
      },
    },
  };
}

function fakeServiceDeps() {
  return {
    listRunsForWatch: async () => [],
    listRunEvents: async () => [],
    findPullRequest: async () => ({ exists: false as const }),
    mergePullRequest: async () => undefined,
    insertOverseerAction: async () => undefined,
  };
}

describe('reconcile', () => {
  test('merged fixture PR with stem in BODY and open tracker closes with evidence and records action=reconcile_close', async () => {
    const deps = fakeDeps();

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 1, skipped: false });
    expect(deps.searches).toEqual([{ org: 'bluedevilcollectibles', since: '2026-07-03' }]);
    expect(deps.comments).toHaveLength(1);
    expect(deps.comments[0]).toContain('https://github.com/bluedevilcollectibles/bdc-harness/pull/404');
    expect(deps.comments[0]).toContain('abc123merge');
    expect(deps.comments[0]).toContain('bluedevilcollectibles/bdc-harness');
    expect(deps.labels).toEqual(['wo:done']);
    expect(deps.closes).toEqual([1044]);
    expect(deps.actions).toMatchObject([
      {
        woId: stem,
        action: 'reconcile_close',
        result: 'https://github.com/bluedevilcollectibles/bdc-harness/pull/404:abc123merge',
      },
    ]);
  });

  test('cursor value bounds merged PR search since date', async () => {
    const deps = fakeDeps({ readCursor: '2026-07-15T22:33:44.000Z' });

    const result = await runReconcileOnce({ org: 'custom-org', deps });

    expect(result).toEqual({ scanned: 1, closed: 1, skipped: false });
    expect(deps.searches).toEqual([{ org: 'custom-org', since: '2026-07-15' }]);
  });

  test('same input second run no-ops when tracker is already closed', async () => {
    const deps = fakeDeps({ tracker: trackerIssue('open') });
    await runReconcileOnce({ deps });
    deps.comments.length = 0;
    deps.labels.length = 0;
    deps.closes.length = 0;
    deps.actions.length = 0;
    deps.findTrackerIssueByStem = mock(async () => trackerIssue('closed'));

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.comments).toEqual([]);
    expect(deps.labels).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });

  test('merged PR with no stem is ignored', async () => {
    const deps = fakeDeps({
      prs: [mergedPr({ title: 'Generic merged PR', body: 'No work order marker here.' })],
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.findTrackerIssueByStem).not.toHaveBeenCalled();
    expect(deps.closes).toEqual([]);
  });

  test('OPEN unmerged PR with stem is ignored', async () => {
    const deps = fakeDeps({ prs: [mergedPr({ state: 'open', merged: false })] });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.findTrackerIssueByStem).not.toHaveBeenCalled();
    expect(deps.closes).toEqual([]);
  });

  test('rate-limit response skips cycle with warn log and no tracker action or false no PR conclusion', async () => {
    const deps = fakeDeps({
      searchError: Object.assign(new Error('API rate limit exceeded'), { status: 403 }),
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 0, closed: 0, skipped: true });
    expect(deps.warnings).toEqual(['overseer.reconcile.rate_limit_skip']);
    expect(deps.findTrackerIssueByStem).not.toHaveBeenCalled();
    expect(deps.comments).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });

  test('tracker already closed no-ops with no duplicate comment', async () => {
    const deps = fakeDeps({ tracker: trackerIssue('closed') });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.comments).toEqual([]);
    expect(deps.labels).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });

  test('retry after partial failure reuses existing evidence marker and still closes tracker', async () => {
    const firstAttempt = fakeDeps({ labelError: new Error('label_failed') });

    await expect(runReconcileOnce({ deps: firstAttempt })).rejects.toThrow('label_failed');
    expect(firstAttempt.comments).toHaveLength(1);
    expect(firstAttempt.labels).toEqual([]);
    expect(firstAttempt.closes).toEqual([]);
    expect(firstAttempt.actions).toEqual([]);

    const retry = fakeDeps({ hasEvidence: true });

    const result = await runReconcileOnce({ deps: retry });

    expect(result).toEqual({ scanned: 1, closed: 1, skipped: false });
    expect(retry.comments).toEqual([]);
    expect(retry.labels).toEqual(['wo:done']);
    expect(retry.closes).toEqual([1044]);
    expect(retry.actions).toMatchObject([{ woId: stem, action: 'reconcile_close' }]);
  });

  test('service reconcile scheduler is default-off when overseer service is enabled', async () => {
    const previousEnv = process.env.OVERSEER_RECONCILE_ENABLED;
    delete process.env.OVERSEER_RECONCILE_ENABLED;
    const reconcileRun = mock(async () => {
      throw new Error('reconcile_should_not_run');
    });

    try {
      await runOverseerService({
        once: true,
        enabled: true,
        adapterKind: 'fake',
        deps: fakeServiceDeps(),
        reconcileRun,
      });
    } finally {
      if (previousEnv === undefined) {
        delete process.env.OVERSEER_RECONCILE_ENABLED;
      } else {
        process.env.OVERSEER_RECONCILE_ENABLED = previousEnv;
      }
    }

    expect(reconcileRun).not.toHaveBeenCalled();
  });

  test('service reconcile scheduler runs only when explicitly enabled', async () => {
    const reconcileRun = mock(async () => undefined);

    await runOverseerService({
      once: true,
      enabled: true,
      adapterKind: 'fake',
      deps: fakeServiceDeps(),
      reconcileEnabled: true,
      reconcileRun,
    });

    expect(reconcileRun).toHaveBeenCalledTimes(1);
  });
});
