import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECONCILE_SUPERSEDE_ACTION,
  closeSupersededPullRequest,
  proveSupersession,
  runReconcileOnce,
  type OctokitLike,
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
    headSha: 'a'.repeat(40),
    labels: [],
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
  deps.listPullRequestFiles = async () => ['src/index.ts'];
  deps.proveSupersession = async (_merged, candidate) => ({
    headSha: candidate.headSha!,
    baseSha: 'b'.repeat(40),
    baseRef: 'dev',
  });
  deps.closePullRequest = async closeInput => {
    pullCloses.push({ number: closeInput.number, comment: closeInput.comment });
    return true;
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
  test('overlapping_wo_ids_do_not_match', async () => {
    const deps = supersedeDeps({
      pr: mergedPr({ number: 4425, body: 'WO: WO-FOO-01' }),
      opens: [
        keeperOpenPr(1, 'WO: WO-FOO-010', 'fix/wo-foo-010-thread-abc'),
        keeperOpenPr(2, 'WO: WO-FOO-01', 'fix/wo-foo-01-thread-def'),
        keeperOpenPr(3, 'WO: WO-OTHER-01', 'fix/WO-FOO-01'),
        keeperOpenPr(4, 'WO: WO-FOO-01A', 'fix/wo-foo-01a'),
        keeperOpenPr(5, 'WO: WO-OTHER-01', 'fix/prefixwo-foo-01'),
        keeperOpenPr(6, 'WO: WO-FOO-01-EXTRA', 'fix/wo-foo-01-extra'),
        keeperOpenPr(7, 'WO: WO-FOO-01-EXTRA', 'fix/wo-foo-01-extra-thread-abc'),
        keeperOpenPr(8, 'WO: WO-FOO-01-02', 'fix/wo-foo-01-02-thread-abc'),
        // Branch-only match through the engine -thread- suffix.
        keeperOpenPr(9, 'WO: WO-OTHER-01', 'fix/wo-foo-01-thread-ghi'),
      ],
    });
    await runReconcileOnce({ deps });
    expect(deps.pullCloses.map(pr => pr.number)).toEqual([2, 3, 9]);
  });

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

    // A spec-only merge (only the WO document changed) is not completion evidence.
    const specOnly = supersedeDeps({
      pr: mergedPr({ ...merged, baseRef: 'dev' }),
      opens: [sibling],
    });
    specOnly.listPullRequestFiles = async () => [`docs/work-orders/${KEEPER_WO}.md`];
    await runReconcileOnce({ deps: specOnly });
    expect(specOnly.pullCloses).toEqual([]);
    expect(specOnly.listCalls.count).toBe(0);

    // Positive control: the same merge with a code change on the project base closes it.
    const eligible = supersedeDeps({
      pr: mergedPr({ ...merged, baseRef: 'dev' }),
      opens: [sibling],
    });
    eligible.listPullRequestFiles = async () => [
      `docs/work-orders/${KEEPER_WO}.md`,
      'packages/overseer/src/reconcile.ts',
    ];
    await runReconcileOnce({ deps: eligible });
    expect(eligible.pullCloses.map(close => close.number)).toEqual([4422]);
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

describe('bdc-xo#6714: supersession requires the exact deliverable in the landed tree', () => {
  let cwd: string;
  let base: string;
  let head: string;
  let squash: string;
  let ancestryOnly: string;
  let dropped: string;

  function git(...args: string[]): string {
    const result = Bun.spawnSync(
      ['git', '-c', 'core.hooksPath=hooks-disabled', '-c', 'core.autocrlf=false', ...args],
      { cwd }
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  }

  function write(path: string, value: string): void {
    writeFileSync(join(cwd, path), value);
  }

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'reconcile-supersession-'));
    git('init');
    git('config', 'user.name', 'Reconcile Fixture');
    git('config', 'user.email', 'reconcile@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    write('feature.ts', 'before\n');
    write('old.txt', 'rename me\n');
    write('remove.txt', 'remove me\n');
    git('add', '.');
    git('commit', '-m', 'base');
    base = git('rev-parse', 'HEAD').trim();

    write('feature.ts', 'after\n');
    git('mv', 'old.txt', 'new.txt');
    git('rm', 'remove.txt');
    git('add', '.');
    git('commit', '-m', 'candidate implementation');
    head = git('rev-parse', 'HEAD').trim();

    git('checkout', '--detach', base);
    git('cherry-pick', '--no-commit', head);
    write('extra.txt', 'independent landed change\n');
    git('add', '.');
    git('commit', '-m', 'squash candidate with an extra change');
    squash = git('rev-parse', 'HEAD').trim();

    git('checkout', '--detach', base);
    git('merge', '--no-ff', '-s', 'ours', head, '-m', 'record ancestry only');
    ancestryOnly = git('rev-parse', 'HEAD').trim();

    git('checkout', '--detach', base);
    git('merge', '--no-ff', '--no-commit', '-s', 'ours', head);
    write('extra.txt', 'different change that does not carry the candidate\n');
    git('add', '.');
    git('commit', '-m', 'merge with candidate changes dropped');
    dropped = git('rev-parse', 'HEAD').trim();
  });

  afterAll(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  function changedFiles(range: string) {
    return git('diff', '--name-status', '-M', range)
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const [code, path, renamedTo] = line.split('\t');
        if (code.startsWith('R')) {
          return { filename: renamedTo, status: 'renamed', previous_filename: path };
        }
        const status = code === 'D' ? 'removed' : code === 'A' ? 'added' : 'modified';
        return { filename: path, status };
      });
  }

  async function reconcile(
    landed: string,
    options: {
      listingHeld?: boolean;
      lateHold?: boolean;
      movedHead?: boolean;
      unknownLabels?: boolean;
      truncated?: boolean;
      incompleteFiles?: boolean;
      mergedFiles?: string[];
      explicitLink?: boolean;
    } = {}
  ) {
    const candidate = {
      ...keeperOpenPr(
        1259,
        `WO: ${KEEPER_WO}\n${options.explicitLink ? 'Superseded by #1263' : ''}`,
        'fix/candidate'
      ),
      headSha: head,
      labels: options.listingHeld ? ['Merge-Hold'] : [],
    };
    const deps = supersedeDeps({
      pr: mergedPr({ number: 1263, body: `WO: ${KEEPER_WO}`, mergeCommitSha: landed }),
      opens: [candidate],
    });
    deps.listPullRequestFiles = async () =>
      options.mergedFiles ?? changedFiles(`${base}..${landed}`).map(file => file.filename);
    const close = mock(async () => undefined);
    const comment = mock(async () => undefined);
    const candidateFiles = changedFiles(`${base}...${head}`);
    let reads = 0;
    const pullsGet = mock(async () => {
      reads++;
      const labels = options.unknownLabels
        ? undefined
        : reads > 1 && options.lateHold
          ? [{ name: 'merge-hold' }]
          : [];
      return {
        data: {
          html_url: 'https://github.com/thinmansoftware/bdc-harness/pull/1259',
          state: 'open' as const,
          draft: false,
          head: { sha: reads > 1 && options.movedHead ? dropped : head },
          base: { ref: 'dev', sha: base },
          labels,
          changed_files: candidateFiles.length,
        },
      };
    });
    const octokit: OctokitLike = {
      search: { issuesAndPullRequests: async () => ({ data: { items: [] } }) },
      pulls: { listFiles: async () => ({ data: [] }), get: pullsGet },
      git: {
        getCommit: async ({ commit_sha }) => {
          const sha = String(commit_sha);
          const [tree, ...parents] = git('show', '-s', '--format=%T %P', sha).trim().split(' ');
          return { data: { sha, tree: { sha: tree }, parents: parents.map(sha => ({ sha })) } };
        },
        getTree: async ({ tree_sha }) => {
          const sha = String(tree_sha);
          const tree = git('ls-tree', '-r', '-z', sha)
            .split('\0')
            .filter(Boolean)
            .map(entry => {
              const [object, path] = entry.split('\t');
              const [mode, type, sha] = object.split(' ');
              return { path, mode, type, sha };
            });
          return { data: { sha, truncated: options.truncated ?? false, tree } };
        },
      },
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => {
          const files = changedFiles(String(basehead));
          return { data: { files: options.incompleteFiles ? files.slice(1) : files } };
        },
      },
      issues: { update: close, createComment: comment, addLabels: async () => undefined },
    };
    deps.proveSupersession = (pr, sibling) => proveSupersession(octokit, pr, sibling);
    deps.closePullRequest = request => closeSupersededPullRequest(octokit, request, deps.log!);
    await runReconcileOnce({ deps });
    return {
      close,
      comment,
      pullsGet,
      actions: deps.actions.filter(action => action.action === RECONCILE_SUPERSEDE_ACTION),
    };
  }

  function expectOpen(result: Awaited<ReturnType<typeof reconcile>>): void {
    expect(result.close).not.toHaveBeenCalled();
    expect(result.comment).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
  }

  test('held candidate remains open even with an explicit link and full content inclusion', async () => {
    const result = await reconcile(squash, { listingHeld: true, explicitLink: true });
    expectOpen(result);
    expect(result.pullsGet).not.toHaveBeenCalled();
  });

  test('a merged PR with zero changed paths cannot close a code PR', async () => {
    expectOpen(await reconcile(ancestryOnly, { explicitLink: true }));
  });

  test('an unchanged landed tree cannot close a PR even if GitHub lists changed paths', async () => {
    expect(git('merge-base', ancestryOnly, head).trim()).toBe(head);
    expectOpen(await reconcile(ancestryOnly, { mergedFiles: ['feature.ts'] }));
  });

  test('ancestry plus a changed landed tree is insufficient when the deliverable was dropped', async () => {
    expect(git('merge-base', dropped, head).trim()).toBe(head);
    expectOpen(await reconcile(dropped));
  });

  test('incomplete tree or file evidence fails closed', async () => {
    expectOpen(await reconcile(squash, { truncated: true }));
    expectOpen(await reconcile(squash, { incompleteFiles: true }));
    expectOpen(await reconcile(squash, { unknownLabels: true }));
  });

  test('head drift or a newly applied hold immediately before close fails closed', async () => {
    expectOpen(await reconcile(squash, { movedHead: true }));
    expectOpen(await reconcile(squash, { lateHold: true }));
  });

  test('squashed inclusion of changes, deletion, and rename closes once and records the action', async () => {
    expect(git('merge-base', squash, head).trim()).toBe(base);
    const result = await reconcile(squash);
    expect(result.close).toHaveBeenCalledTimes(1);
    expect(result.comment).toHaveBeenCalledTimes(1);
    expect(result.actions).toEqual([
      expect.objectContaining({ prRef: 'thinmansoftware/bdc-harness#1259', result: '#1263' }),
    ]);
  });
});
