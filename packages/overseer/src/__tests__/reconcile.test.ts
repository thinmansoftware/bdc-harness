import { describe, expect, mock, test } from 'bun:test';
import {
  RECONCILE_SUPERSEDE_ACTION,
  runReconcileOnce,
  type ReconcileActionRecord,
  type ReconcileDeps,
  type ReconcileMergedPullRequest,
  type ReconcileRepoOpenPullRequest,
  type ReconcileTrackerIssue,
} from '../reconcile';

export const stem = 'WO-HARNESS-OVERSEER-V1B-TRACKER-RECONCILE-01';

// Default fixture: a merged bdc-harness PR on its project base (dev) that carries
// a closing keyword for tracker #1044. Under the keyword-close rule this is what
// closes a tracker (a bare name-mention never does).
export function mergedPr(
  overrides: Partial<ReconcileMergedPullRequest> = {}
): ReconcileMergedPullRequest {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    number: 404,
    title: 'BDC feature Work Order implementation',
    body: `Implements ${stem}.\n\nCloses thinmansoftware/bdc-xo#1044`,
    htmlUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/404',
    state: 'closed',
    merged: true,
    mergeCommitSha: 'abc123merge',
    mergedAt: '2026-07-17T12:00:00Z',
    baseRef: 'dev',
    ...overrides,
  };
}

export function trackerIssue(state: 'open' | 'closed' = 'open'): ReconcileTrackerIssue {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-xo',
    number: 1044,
    title: stem,
    state,
  };
}

export function fakeDeps(
  input: {
    prs?: ReconcileMergedPullRequest[];
    tracker?: ReconcileTrackerIssue | null;
    searchError?: unknown;
    trackerLookupError?: unknown;
    skipAlreadyNoted?: boolean;
    closeAlreadyRecorded?: boolean;
    mergedAlreadyNoted?: boolean;
  } = {}
): ReconcileDeps & {
  comments: string[];
  labels: string[];
  closes: number[];
  actions: ReconcileActionRecord[];
  warnings: string[];
  infos: string[];
} {
  const comments: string[] = [];
  const labels: string[] = [];
  const closes: number[] = [];
  const actions: ReconcileActionRecord[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const resolveTracker = (): ReconcileTrackerIssue | null =>
    input.tracker === undefined ? trackerIssue() : input.tracker;
  return {
    comments,
    labels,
    closes,
    actions,
    warnings,
    infos,
    readCursor: mock(async () => null),
    now: () => new Date('2026-07-17T12:00:00Z'),
    searchMergedPullRequests: mock(async () => {
      if (input.searchError) throw input.searchError;
      return input.prs ?? [mergedPr()];
    }),
    // Keyword closes resolve the tracker by NUMBER; the default fixture closes #1044.
    findTrackerIssueByNumber: mock(async (number: number) => {
      if (input.trackerLookupError) throw input.trackerLookupError;
      if (number !== 1044) return null;
      return resolveTracker();
    }),
    // Still used for the holder guard and the keyword-missing note (declared stems).
    findTrackerIssueByStem: mock(async (candidate: string) => {
      if (input.trackerLookupError) throw input.trackerLookupError;
      if (candidate !== stem) return null;
      return resolveTracker();
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
    hasSkipBeenNoted: mock(async () => Boolean(input.skipAlreadyNoted)),
    hasCloseBeenRecorded: mock(async () => Boolean(input.closeAlreadyRecorded)),
    hasMergedBeenNoted: mock(async () => Boolean(input.mergedAlreadyNoted)),
    hasKeywordMissingBeenNoted: mock(async () => false),
    insertAction: mock(async record => {
      actions.push(record);
    }),
    log: {
      warn: (_fields, message) => {
        warnings.push(message);
      },
      info: (_fields, message) => {
        infos.push(message);
      },
    },
  };
}

describe('reconcile', () => {
  test('merged fixture PR with a closing keyword on its project base marks the tracker merged (open) and records action=reconcile_merged_noted class=closes_keyword', async () => {
    const deps = fakeDeps();

    const result = await runReconcileOnce({ deps });

    // Amendment A1: merged is not done -- no close, status:merged, one comment.
    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.comments).toHaveLength(1);
    expect(deps.comments[0]).toContain('https://github.com/thinmansoftware/bdc-harness/pull/404');
    expect(deps.comments[0]).toContain('abc123merge');
    expect(deps.comments[0]).toContain('Base: dev');
    expect(deps.labels).toEqual(['status:merged']);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toMatchObject([
      {
        woId: stem,
        class: 'closes_keyword',
        action: 'reconcile_merged_noted',
        result: 'https://github.com/thinmansoftware/bdc-harness/pull/404:abc123merge',
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
    deps.findTrackerIssueByNumber = mock(async () => trackerIssue('closed'));

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.comments).toEqual([]);
    expect(deps.labels).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });

  test('merged PR with no closing keyword and no WO: declaration is ignored', async () => {
    const deps = fakeDeps({
      prs: [mergedPr({ title: 'Generic merged PR', body: 'No work order marker here.' })],
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.findTrackerIssueByNumber).not.toHaveBeenCalled();
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

  test('generic search transport error skips cycle with warn log and does not throw', async () => {
    const deps = fakeDeps({ searchError: new Error('socket reset') });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 0, closed: 0, skipped: true });
    expect(deps.warnings).toEqual(['overseer.reconcile.transport_error_skip']);
    expect(deps.findTrackerIssueByStem).not.toHaveBeenCalled();
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
});

const KEEPER_WO = 'WO-XO-BDC-BROWSER-KEEPER-04';

function keeperOpenPr(
  number: number,
  woLine: string,
  headRefName: string,
  createdAt: string | null = '2026-07-17T11:00:00Z'
): ReconcileRepoOpenPullRequest {
  return {
    number,
    body: woLine,
    headRefName,
    isDraft: false,
    headRepository: { owner: 'thinmansoftware', repo: 'bdc-harness' },
    createdAt,
  };
}

function supersedeDeps(
  input: {
    pr?: ReconcileMergedPullRequest;
    opens?: ReconcileRepoOpenPullRequest[];
  } = {}
): ReconcileDeps & {
  comments: string[];
  labels: string[];
  closes: number[];
  actions: ReconcileActionRecord[];
  warnings: string[];
  infos: string[];
  pullCloses: Array<{ number: number; comment: string }>;
  listCalls: { count: number };
} {
  const pr =
    input.pr ??
    mergedPr({
      number: 4425,
      title: 'Keeper implementation',
      body: `WO: ${KEEPER_WO}\n`,
      htmlUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/4425',
    });
  const opens = input.opens ?? [
    keeperOpenPr(4422, `WO: ${KEEPER_WO}\n`, 'archon/task-web-worker-1-abc'),
    keeperOpenPr(4424, `WO: ${KEEPER_WO}\n`, 'archon/task-web-worker-2-def'),
    keeperOpenPr(9, 'WO: WO-OTHER-THING-09\n', 'archon/other'),
  ];
  const deps = fakeDeps({ prs: [pr] });
  const pullCloses: Array<{ number: number; comment: string }> = [];
  const listCalls = { count: 0 };
  deps.listOpenPullRequestsInRepo = async () => {
    listCalls.count += 1;
    return opens;
  };
  deps.closePullRequest = async closeInput => {
    pullCloses.push({ number: closeInput.number, comment: closeInput.comment });
  };
  deps.hasSupersedeBeenRecorded = async ({ prRef, woId }) =>
    deps.actions.some(
      action =>
        action.action === RECONCILE_SUPERSEDE_ACTION &&
        action.prRef === prRef &&
        action.woId === woId
    );
  return Object.assign(deps, { pullCloses, listCalls });
}

describe('reconcile supersede', () => {
  test('merge_closes_superseded_wo_prs', async () => {
    const deps = supersedeDeps();

    await runReconcileOnce({ deps });

    expect(deps.pullCloses.map(close => close.number).sort((a, b) => a - b)).toEqual([4422, 4424]);
    expect(deps.pullCloses.every(close => close.comment.includes('Superseded by #4425'))).toBe(
      true
    );
    expect(deps.closes).toEqual([]);
    const supersede = deps.actions.filter(action => action.action === RECONCILE_SUPERSEDE_ACTION);
    expect(supersede).toEqual([
      {
        prRef: 'thinmansoftware/bdc-harness#4422',
        woId: KEEPER_WO,
        class: 'supersede',
        action: RECONCILE_SUPERSEDE_ACTION,
        result: '#4425',
      },
      {
        prRef: 'thinmansoftware/bdc-harness#4424',
        woId: KEEPER_WO,
        class: 'supersede',
        action: RECONCILE_SUPERSEDE_ACTION,
        result: '#4425',
      },
    ]);
  });

  test('supersede_close_is_idempotent', async () => {
    const deps = supersedeDeps();

    await runReconcileOnce({ deps });
    const closesAfterFirst = deps.pullCloses.length;
    const actionsAfterFirst = deps.actions.filter(
      action => action.action === RECONCILE_SUPERSEDE_ACTION
    ).length;

    await runReconcileOnce({ deps });

    expect(deps.pullCloses.length).toBe(closesAfterFirst);
    expect(deps.actions.filter(action => action.action === RECONCILE_SUPERSEDE_ACTION).length).toBe(
      actionsAfterFirst
    );
  });

  test('supersede_respects_completion_gates', async () => {
    const sibling = keeperOpenPr(
      4422,
      `WO: ${KEEPER_WO}\n`,
      'archon/task-web-worker-1-abc',
      '2026-07-17T11:00:00Z'
    );
    const merged = {
      number: 4425,
      title: 'Keeper implementation',
      body: `WO: ${KEEPER_WO}\n`,
      htmlUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/4425',
      mergedAt: '2026-07-17T12:00:00Z',
    };

    const wrongBase = supersedeDeps({
      pr: mergedPr({ ...merged, baseRef: 'feature/not-base' }),
      opens: [sibling],
    });
    await runReconcileOnce({ deps: wrongBase });
    expect(wrongBase.pullCloses).toEqual([]);
    expect(wrongBase.listCalls.count).toBe(0);

    const skipped = supersedeDeps({
      pr: mergedPr({
        ...merged,
        baseRef: 'dev',
        body: `WO: ${KEEPER_WO}\nReconcile-Skip: ${KEEPER_WO}\n`,
      }),
      opens: [sibling],
    });
    await runReconcileOnce({ deps: skipped });
    expect(skipped.pullCloses).toEqual([]);
    expect(skipped.listCalls.count).toBe(0);
    expect(skipped.actions.filter(action => action.action === RECONCILE_SUPERSEDE_ACTION)).toEqual(
      []
    );
  });

  test('newer_sibling_not_superseded', async () => {
    const deps = supersedeDeps({
      pr: mergedPr({
        number: 4425,
        title: 'Keeper implementation',
        body: `WO: ${KEEPER_WO}\n`,
        htmlUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/4425',
        baseRef: 'dev',
        mergedAt: '2026-07-17T12:00:00Z',
      }),
      opens: [
        keeperOpenPr(4422, `WO: ${KEEPER_WO}\n`, 'archon/older', '2026-07-17T11:00:00Z'),
        keeperOpenPr(4424, `WO: ${KEEPER_WO}\n`, 'archon/newer', '2026-07-17T12:01:00Z'),
      ],
    });

    await runReconcileOnce({ deps });

    expect(deps.pullCloses.map(close => close.number)).toEqual([4422]);
    expect(deps.pullCloses[0]?.comment.includes('Superseded by #4425')).toBe(true);
    expect(
      deps.actions
        .filter(action => action.action === RECONCILE_SUPERSEDE_ACTION)
        .map(action => action.prRef)
    ).toEqual(['thinmansoftware/bdc-harness#4422']);
  });

  test('supersede_time_check_fails_closed', async () => {
    const mergedFields = {
      number: 4425,
      title: 'Keeper implementation',
      body: `WO: ${KEEPER_WO}\n`,
      htmlUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/4425',
      baseRef: 'dev' as const,
    };
    const cases: Array<{ createdAt: string | null; mergedAt: string | null }> = [
      { createdAt: '2026-07-17T12:00:00Z', mergedAt: '2026-07-17T12:00:00Z' },
      { createdAt: null, mergedAt: '2026-07-17T12:00:00Z' },
      { createdAt: '', mergedAt: '2026-07-17T12:00:00Z' },
      { createdAt: 'not-a-date', mergedAt: '2026-07-17T12:00:00Z' },
      { createdAt: '2026-07-17T11:00:00Z', mergedAt: null },
      { createdAt: '2026-07-17T11:00:00Z', mergedAt: '' },
      { createdAt: '2026-07-17T11:00:00Z', mergedAt: 'not-a-date' },
    ];

    for (const item of cases) {
      const deps = supersedeDeps({
        pr: mergedPr({ ...mergedFields, mergedAt: item.mergedAt }),
        opens: [keeperOpenPr(4422, `WO: ${KEEPER_WO}\n`, 'archon/older', item.createdAt)],
      });
      await runReconcileOnce({ deps });
      expect(deps.pullCloses).toEqual([]);
      expect(deps.actions.filter(action => action.action === RECONCILE_SUPERSEDE_ACTION)).toEqual(
        []
      );
    }
  });

  test('unskipped_declared_stem_supersedes_when_another_stem_is_skipped', async () => {
    const deps = supersedeDeps({
      pr: mergedPr({
        number: 4425,
        title: 'Keeper implementation',
        body: `WO: ${KEEPER_WO}\nWO: WO-OTHER-THING-09\nReconcile-Skip: WO-OTHER-THING-09\n`,
        htmlUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/4425',
        baseRef: 'dev',
        mergedAt: '2026-07-17T12:00:00Z',
      }),
      opens: [
        keeperOpenPr(4422, `WO: ${KEEPER_WO}\n`, 'archon/older', '2026-07-17T11:00:00Z'),
        keeperOpenPr(9, 'WO: WO-OTHER-THING-09\n', 'archon/other', '2026-07-17T11:00:00Z'),
      ],
    });

    await runReconcileOnce({ deps });

    expect(deps.pullCloses.map(close => close.number)).toEqual([4422]);
    expect(deps.pullCloses[0]?.comment.includes('Superseded by #4425')).toBe(true);
  });
});
