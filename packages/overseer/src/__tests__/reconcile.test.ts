import { describe, expect, mock, test } from 'bun:test';
import {
  runReconcileOnce,
  type ReconcileActionRecord,
  type ReconcileDeps,
  type ReconcileMergedPullRequest,
  type ReconcileTrackerIssue,
} from '../reconcile';

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

function fakeDeps(
  input: {
    prs?: ReconcileMergedPullRequest[];
    tracker?: ReconcileTrackerIssue | null;
    searchError?: unknown;
    trackerLookupError?: unknown;
  } = {}
): ReconcileDeps & {
  comments: string[];
  labels: string[];
  closes: number[];
  actions: ReconcileActionRecord[];
  warnings: string[];
} {
  const comments: string[] = [];
  const labels: string[] = [];
  const closes: number[] = [];
  const actions: ReconcileActionRecord[] = [];
  const warnings: string[] = [];
  return {
    comments,
    labels,
    closes,
    actions,
    warnings,
    readCursor: mock(async () => null),
    now: () => new Date('2026-07-17T12:00:00Z'),
    searchMergedPullRequests: mock(async () => {
      if (input.searchError) throw input.searchError;
      return input.prs ?? [mergedPr()];
    }),
    findTrackerIssueByStem: mock(async (candidate: string) => {
      if (input.trackerLookupError) throw input.trackerLookupError;
      if (candidate !== stem) return null;
      return input.tracker === undefined ? trackerIssue() : input.tracker;
    }),
    addTrackerEvidenceComment: mock(async request => {
      comments.push(request.body);
    }),
    addTrackerLabel: mock(async request => {
      labels.push(request.label);
    }),
    closeTrackerIssue: mock(async request => {
      closes.push(request.issue.number);
    }),
    insertAction: mock(async record => {
      actions.push(record);
    }),
    hasReconcileAction: mock(async (query: { prRef: string; woId: string; action: string }) =>
      actions.some(
        a => a.prRef === query.prRef && a.woId === query.woId && a.action === query.action
      )
    ),
    log: {
      warn: (_fields, message) => {
        warnings.push(message);
      },
    },
  };
}

describe('reconcile', () => {
  test('merged fixture PR with stem in BODY and open tracker closes with evidence and records action=reconcile_close', async () => {
    const deps = fakeDeps();

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 1, skipped: false });
    expect(deps.comments).toHaveLength(1);
    expect(deps.comments[0]).toContain(
      'https://github.com/bluedevilcollectibles/bdc-harness/pull/404'
    );
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

  test('401 auth-error response skips cycle with warn log and does not throw', async () => {
    const deps = fakeDeps({
      searchError: Object.assign(new Error('Bad credentials'), { status: 401 }),
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 0, closed: 0, skipped: true });
    expect(deps.warnings).toEqual(['overseer.reconcile.auth_error_skip']);
    expect(deps.findTrackerIssueByStem).not.toHaveBeenCalled();
    expect(deps.comments).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });

  test('rate-limit response from findTrackerIssueByStem (per-stem search, not the merged-PR search) skips cleanly instead of crashing the watcher (regression: live incident 2026-07-22, overseer_runtime.watcher_exception_degraded)', async () => {
    const deps = fakeDeps({
      trackerLookupError: Object.assign(new Error('API rate limit exceeded'), {
        status: 403,
        response: { headers: { 'x-ratelimit-resource': 'search' } },
      }),
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: true });
    expect(deps.warnings).toEqual(['overseer.reconcile.rate_limit_skip']);
    expect(deps.comments).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });

  test('401 auth-error response from findTrackerIssueByStem skips cleanly instead of crashing the watcher', async () => {
    const deps = fakeDeps({
      trackerLookupError: Object.assign(new Error('Bad credentials'), { status: 401 }),
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: true });
    expect(deps.warnings).toEqual(['overseer.reconcile.auth_error_skip']);
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

  test('Reconcile-Skip marker suppresses close, posts left-open evidence, records action=reconcile_skip_noted', async () => {
    const deps = fakeDeps({
      prs: [mergedPr({ body: `Implements ${stem}.\nReconcile-Skip: ${stem}` })],
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    // Tracker must NOT be closed and must NOT be labeled wo:done.
    expect(deps.closes).toEqual([]);
    expect(deps.labels).toEqual([]);
    // Evidence comment IS still posted, noting the tracker was left open.
    expect(deps.comments).toHaveLength(1);
    expect(deps.comments[0]).toContain('intentionally OPEN');
    expect(deps.comments[0]).toContain(
      'https://github.com/bluedevilcollectibles/bdc-harness/pull/404'
    );
    // Audit row recorded with the exact literal action string.
    expect(deps.actions).toMatchObject([
      {
        woId: stem,
        action: 'reconcile_skip_noted',
        result: 'https://github.com/bluedevilcollectibles/bdc-harness/pull/404:abc123merge',
      },
    ]);
  });

  test('no Reconcile-Skip marker leaves the existing close path unchanged (regression guard)', async () => {
    const deps = fakeDeps();

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 1, skipped: false });
    expect(deps.closes).toEqual([1044]);
    expect(deps.labels).toEqual(['wo:done']);
    expect(deps.actions).toMatchObject([{ woId: stem, action: 'reconcile_close' }]);
    // Skip-path idempotency dep must never be consulted for a non-skip PR.
    expect(deps.hasReconcileAction).not.toHaveBeenCalled();
  });

  test('second reconcile run against the same skip-marked PR does not double-post comment or action row', async () => {
    const deps = fakeDeps({
      prs: [mergedPr({ body: `Implements ${stem}.\nReconcile-Skip: ${stem}` })],
    });

    await runReconcileOnce({ deps });
    expect(deps.comments).toHaveLength(1);
    expect(deps.actions).toHaveLength(1);

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    // No duplicate comment and no duplicate action row on the second cycle.
    expect(deps.comments).toHaveLength(1);
    expect(deps.actions).toHaveLength(1);
    expect(deps.closes).toEqual([]);
  });
});
