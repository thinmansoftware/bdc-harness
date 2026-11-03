/**
 * WO-HARNESS-STAGING-CLOSES-LINK-01 -- keyword-close on the project base.
 *
 * A merged PR closes a WO tracker only when it carries a GitHub closing keyword
 * naming that tracker issue AND it merged into the project's Cauldron base branch
 * (staging/dev/main/... per project-bases). GitHub does not auto-close on a merge
 * into a non-default branch, so reconcile is what closes these.
 */

import { expect, test } from 'bun:test';
import {
  MERGED_MARKER,
  RECONCILE_ACTION,
  RECONCILE_MERGED_ACTION,
  findLiveProof,
  liveProofAuthors,
  extractClosingKeywordTrackerRefs,
  openPullRequestsHoldingTracker,
  runReconcileOnce,
  searchOpenPullRequestsReferencingTracker,
  searchMergedPullRequests,
  type OctokitLike,
  type ReconcileActionRecord,
  type ReconcileDeps,
  type ReconcileMergedPullRequest,
  type ReconcileOpenPullRequest,
  type ReconcileTrackerComment,
  type ReconcileTrackerIssue,
} from '../reconcile';
import { resolveProjectBase } from '../project-bases';

const ORG = 'thinmansoftware';
const SHOPOPS_WO = 'WO-SHOPOPS-STAGING-RESIDUE-SWEEP-TRIGGER-SAFE-01';

interface HarnessOptions {
  prs: ReconcileMergedPullRequest[];
  /** Open tracker issues keyed by number. */
  trackersByNumber?: Record<number, ReconcileTrackerIssue>;
  /** Open tracker issues keyed by stem (for the keyword-missing lookup). */
  trackersByStem?: Record<string, ReconcileTrackerIssue>;
  closeAlreadyRecorded?: boolean;
  files?: string[];
  searchMergedPullRequests?: ReconcileDeps['searchMergedPullRequests'];
  openPullRequests?: ReconcileOpenPullRequest[];
  mergedAlreadyNoted?: boolean;
  awaitingProof?: ReconcileTrackerIssue[];
  commentsByIssue?: Record<number, ReconcileTrackerComment[]>;
}

interface HarnessState {
  deps: ReconcileDeps;
  comments: string[];
  labels: string[];
  closes: number[];
  actions: ReconcileActionRecord[];
  warnings: string[];
  infos: string[];
  removed: string[];
}

function harness(options: HarnessOptions): HarnessState {
  const comments: string[] = [];
  const labels: string[] = [];
  const closes: number[] = [];
  const actions: ReconcileActionRecord[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const removed: string[] = [];
  const byNumber = options.trackersByNumber ?? {};
  const byStem = options.trackersByStem ?? {};
  const deps: ReconcileDeps = {
    readCursor: async () => null,
    now: () => new Date('2026-11-02T12:00:00Z'),
    searchMergedPullRequests: options.searchMergedPullRequests ?? (async () => options.prs),
    findTrackerIssueByNumber: async (number: number) => byNumber[number] ?? null,
    findTrackerIssueByStem: async (stem: string) => byStem[stem] ?? null,
    listPullRequestFiles: async () => options.files ?? ['src/real-code.ts'],
    listOpenPullRequestsReferencingTracker: async () => options.openPullRequests ?? [],
    addTrackerEvidenceComment: async request => {
      comments.push(request.body);
    },
    addTrackerLabel: async request => {
      labels.push(request.label);
    },
    closeTrackerIssue: async request => {
      closes.push(request.issue.number);
    },
    hasSkipBeenNoted: async () => false,
    hasCloseBeenRecorded: async () => Boolean(options.closeAlreadyRecorded),
    hasHoldBeenNoted: async () => false,
    hasKeywordMissingBeenNoted: async () => false,
    hasMergedBeenNoted: async () => Boolean(options.mergedAlreadyNoted),
    removeTrackerLabel: async request => {
      removed.push(request.label);
    },
    listMergedAwaitingProof: async () => options.awaitingProof ?? [],
    listTrackerComments: async request => options.commentsByIssue?.[request.issue.number] ?? [],
    insertAction: async record => {
      actions.push(record);
    },
    log: {
      warn: (_fields, message) => warnings.push(message),
      info: (_fields, message) => infos.push(message),
    },
  };
  return { deps, comments, labels, closes, actions, warnings, infos, removed };
}

function tracker(
  number: number,
  title: string,
  state: 'open' | 'closed' = 'open'
): ReconcileTrackerIssue {
  return { owner: ORG, repo: 'bdc-xo', number, title, state };
}

/** Amendment A1: a keyword merge marks the tracker merged, never closes it. */
function expectMarkedOnce(state: HarnessState, woId: string): void {
  expect(state.closes).toEqual([]);
  expect(state.labels).toEqual(['status:merged']);
  expect(state.removed).toEqual(['status:building', 'status:review']);
  expect(state.comments).toHaveLength(1);
  expect(state.comments[0]).toContain(MERGED_MARKER);
  expect(state.actions.filter(a => a.action === RECONCILE_ACTION)).toEqual([]);
  expect(state.actions.filter(a => a.action === RECONCILE_MERGED_ACTION)).toMatchObject([
    { woId, class: 'closes_keyword', action: RECONCILE_MERGED_ACTION },
  ]);
}

function mergedPr(overrides: Partial<ReconcileMergedPullRequest>): ReconcileMergedPullRequest {
  return {
    owner: ORG,
    repo: 'shopops',
    number: 948,
    title: 'merged work',
    body: '',
    htmlUrl: `https://github.com/${ORG}/shopops/pull/948`,
    state: 'closed',
    merged: true,
    mergeCommitSha: 'deadbeef',
    mergedAt: '2026-11-01T18:23:09Z',
    baseRef: 'staging',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: staging_keyword_closes_tracker (with pagination to page 2)
// ---------------------------------------------------------------------------

function searchItem(number: number, repo: string, isPr: boolean) {
  return {
    number,
    title: `item ${number}`,
    body: null as string | null,
    state: 'closed',
    pull_request: isPr ? {} : undefined,
    repository_url: `https://api.github.com/repos/${ORG}/${repo}`,
    html_url: `https://github.com/${ORG}/${repo}/pull/${number}`,
  };
}

/**
 * Fake octokit whose body-query returns a full first page (100 non-PR filler
 * items, so pagination continues) and the target shopops#948 on page 2.
 */
function pagedSearchOctokit(targetItem: ReturnType<typeof searchItem>): OctokitLike {
  const page1Filler = Array.from({ length: 100 }, (_, i) =>
    searchItem(i + 1, 'bdc-harness', false)
  );
  return {
    search: {
      issuesAndPullRequests: async (input: Record<string, unknown>) => {
        const q = String(input.q ?? '');
        const page = Number(input.page ?? 1);
        if (q.includes('in:title')) {
          return { data: { total_count: 0, incomplete_results: false, items: [] } };
        }
        // in:body query -- filler fills page 1, target appears on page 2 (item 150).
        if (page === 1) {
          return { data: { total_count: 150, incomplete_results: false, items: page1Filler } };
        }
        if (page === 2) {
          const page2 = Array.from({ length: 49 }, (_, i) =>
            searchItem(200 + i, 'bdc-harness', false)
          );
          page2.push(targetItem);
          return { data: { total_count: 150, incomplete_results: false, items: page2 } };
        }
        return { data: { total_count: 150, incomplete_results: false, items: [] } };
      },
    },
    pulls: {
      listFiles: async () => ({ data: [] }),
      get: async (input: Record<string, unknown>) => {
        if (Number(input.pull_number) !== 948) throw new Error('unexpected pulls.get');
        return {
          data: {
            title: 'residue sweep',
            body: `Closes ${ORG}/bdc-xo#4130\n\nWO: ${SHOPOPS_WO}`,
            html_url: `https://github.com/${ORG}/shopops/pull/948`,
            state: 'closed' as const,
            merged: true,
            merge_commit_sha: '9d86e9f',
            merged_at: '2026-11-01T18:23:09Z',
            base: { ref: 'staging' },
          },
        };
      },
    },
    issues: {
      createComment: async () => undefined,
      addLabels: async () => undefined,
      update: async () => undefined,
    },
  } as unknown as OctokitLike;
}

test('Test 1 (A1): a staging merge with a Closes keyword on page 2 marks 4130 merged and leaves it open', async () => {
  const octokit = pagedSearchOctokit(searchItem(948, 'shopops', true));
  const state = harness({
    prs: [],
    searchMergedPullRequests: async input => searchMergedPullRequests(octokit, input),
    trackersByNumber: { 4130: tracker(4130, SHOPOPS_WO) },
    trackersByStem: { [SHOPOPS_WO]: tracker(4130, SHOPOPS_WO) },
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expectMarkedOnce(state, SHOPOPS_WO);
  expect(state.comments[0]).toContain(`https://github.com/${ORG}/shopops/pull/948`);
  expect(state.comments[0]).toContain('Merge SHA: 9d86e9f');
  expect(state.comments[0]).toContain('Base: staging');
  // No keyword-missing note: the declared WO's tracker (4130) carried the keyword.
  expect(state.actions.map(a => a.action)).not.toContain('reconcile_keyword_missing_noted');
});

test('Test 1 (negative): a page-1-only search never sees the page-2 PR and closes nothing', async () => {
  const octokit = pagedSearchOctokit(searchItem(948, 'shopops', true));
  // Simulate the OLD single-page behavior: only read page 1 of each query.
  const onePageSearch: ReconcileDeps['searchMergedPullRequests'] = async input => {
    const results: ReconcileMergedPullRequest[] = [];
    for (const q of [
      `org:${input.org} is:pr is:merged merged:>=${input.since} WO- in:title`,
      `org:${input.org} is:pr is:merged merged:>=${input.since} WO- in:body`,
    ]) {
      const search = await octokit.search.issuesAndPullRequests({ q, per_page: 100, page: 1 });
      for (const item of search.data.items) {
        if (!item.pull_request) continue;
        const pr = await octokit.pulls.get({ pull_number: item.number });
        results.push({
          owner: ORG,
          repo: 'shopops',
          number: item.number,
          title: pr.data.title ?? '',
          body: pr.data.body,
          htmlUrl: pr.data.html_url,
          state: pr.data.state,
          merged: Boolean(pr.data.merged),
          mergeCommitSha: pr.data.merge_commit_sha,
          baseRef: pr.data.base?.ref ?? null,
        });
      }
    }
    return results;
  };
  const state = harness({
    prs: [],
    searchMergedPullRequests: onePageSearch,
    trackersByNumber: { 4130: tracker(4130, SHOPOPS_WO) },
    trackersByStem: { [SHOPOPS_WO]: tracker(4130, SHOPOPS_WO) },
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expect(state.closes).toEqual([]);
});

// ---------------------------------------------------------------------------
// Test 2: same_repo_hash_reference
// ---------------------------------------------------------------------------

test('Test 2 (A1): a bdc-xo PR into main with `Fixes #4999` marks 4999 merged exactly once', async () => {
  const WO_4999 = 'WO-XO-HASH-REF-01';
  const state = harness({
    prs: [
      mergedPr({
        owner: ORG,
        repo: 'bdc-xo',
        number: 4326,
        htmlUrl: `https://github.com/${ORG}/bdc-xo/pull/4326`,
        baseRef: 'main',
        body: 'Fixes #4999',
      }),
    ],
    trackersByNumber: { 4999: tracker(4999, WO_4999) },
    trackersByStem: { [WO_4999]: tracker(4999, WO_4999) },
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expectMarkedOnce(state, WO_4999);
});

test('Test 2 (native close): an already-closed 4999 is not double-closed and does not error', async () => {
  const WO_4999 = 'WO-XO-HASH-REF-01';
  const state = harness({
    prs: [
      mergedPr({
        owner: ORG,
        repo: 'bdc-xo',
        number: 4326,
        baseRef: 'main',
        body: 'Fixes #4999',
      }),
    ],
    trackersByNumber: { 4999: tracker(4999, WO_4999, 'closed') },
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expect(state.closes).toEqual([]);
});

// ---------------------------------------------------------------------------
// Test 3: non_base_merge_closes_nothing
// ---------------------------------------------------------------------------

test('Test 3: a shopops PR merged into a feature branch closes nothing', async () => {
  const state = harness({
    prs: [mergedPr({ baseRef: 'feat/some-branch', body: `Closes ${ORG}/bdc-xo#4130` })],
    trackersByNumber: { 4130: tracker(4130, SHOPOPS_WO) },
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expect(state.closes).toEqual([]);
  expect(state.actions).toEqual([]);
});

// ---------------------------------------------------------------------------
// Test 5: rescan_is_idempotent
// ---------------------------------------------------------------------------

test('Test 5 (A1): a recorded merged mark is not repeated when the lookback floor rescans the same PR', async () => {
  const state = harness({
    prs: [mergedPr({ baseRef: 'staging', body: `Closes ${ORG}/bdc-xo#4130` })],
    trackersByNumber: { 4130: tracker(4130, SHOPOPS_WO) },
    mergedAlreadyNoted: true,
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expect(state.labels).toEqual([]);
  expect(state.comments).toEqual([]);
  expect(state.actions).toEqual([]);
});

test('Test 5: a recorded close is not repeated when the lookback floor rescans the same PR', async () => {
  const state = harness({
    prs: [mergedPr({ baseRef: 'staging', body: `Closes ${ORG}/bdc-xo#4130` })],
    trackersByNumber: { 4130: tracker(4130, SHOPOPS_WO) },
    closeAlreadyRecorded: true,
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expect(state.closes).toEqual([]);
  expect(state.warnings).toContain('overseer.reconcile.tracker_reopened_after_close_left_open');
});

test('Test 5 (human reopen): the same recorded close still does not re-close after a reopen', async () => {
  // Tracker is open again (a human reopened it); the re-close guard still holds.
  const state = harness({
    prs: [mergedPr({ baseRef: 'staging', body: `Closes ${ORG}/bdc-xo#4130` })],
    trackersByNumber: { 4130: tracker(4130, SHOPOPS_WO, 'open') },
    closeAlreadyRecorded: true,
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expect(state.closes).toEqual([]);
});

// ---------------------------------------------------------------------------
// Test 6: base_map_override
// ---------------------------------------------------------------------------

async function withBasesEnv<T>(value: string, fn: () => Promise<T> | T): Promise<T> {
  const original = process.env.OVERSEER_PROJECT_BASES;
  process.env.OVERSEER_PROJECT_BASES = value;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.OVERSEER_PROJECT_BASES;
    else process.env.OVERSEER_PROJECT_BASES = original;
  }
}

test('Test 6: OVERSEER_PROJECT_BASES override wins over the constant and unknown repos resolve to null', async () => {
  await withBasesEnv('{"thinmansoftware/shopops":"release/x"}', () => {
    expect(resolveProjectBase(ORG, 'shopops')).toBe('release/x');
    expect(resolveProjectBase(ORG, 'a-repo-that-does-not-exist')).toBeNull();
  });
});

test('Test 6 (mark path): the override redirects which branch marks, and an unknown repo marks nothing', async () => {
  await withBasesEnv('{"thinmansoftware/shopops":"release/x"}', async () => {
    // shopops now closes only on release/x; a staging merge no longer closes.
    const stagingState = harness({
      prs: [mergedPr({ baseRef: 'staging', body: `Closes ${ORG}/bdc-xo#4130` })],
      trackersByNumber: { 4130: tracker(4130, SHOPOPS_WO) },
    });
    expect((await runReconcileOnce({ deps: stagingState.deps })).closed).toBe(0);

    const releaseState = harness({
      prs: [mergedPr({ baseRef: 'release/x', body: `Closes ${ORG}/bdc-xo#4130` })],
      trackersByNumber: { 4130: tracker(4130, SHOPOPS_WO) },
    });
    expect((await runReconcileOnce({ deps: releaseState.deps })).closed).toBe(0);
    expect(releaseState.labels).toEqual(['status:merged']);

    const unknownState = harness({
      prs: [
        mergedPr({
          repo: 'a-repo-that-does-not-exist',
          baseRef: 'main',
          body: `Closes ${ORG}/bdc-xo#4130`,
        }),
      ],
      trackersByNumber: { 4130: tracker(4130, SHOPOPS_WO) },
    });
    expect((await runReconcileOnce({ deps: unknownState.deps })).closed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 7: keyword-close PR carrying NO WO stem is still discovered
// Regression: searchMergedPullRequests used to query only `WO- in:title/body`,
// so a `Fixes #N` PR with no WO stem anywhere was never returned and its tracker
// never closed, despite the keyword-close path being correct downstream.
// ---------------------------------------------------------------------------

function keywordOnlySearchOctokit(): OctokitLike {
  // A merged bdc-xo PR whose body is a bare same-repo close, no WO- text at all.
  const target = searchItem(4326, 'bdc-xo', true);
  return {
    search: {
      issuesAndPullRequests: async (input: Record<string, unknown>) => {
        const q = String(input.q ?? '');
        // The WO- queries must NOT surface this PR -- it carries no WO stem.
        if (q.includes('WO- in:title') || q.includes('WO- in:body')) {
          return { data: { total_count: 0, incomplete_results: false, items: [] } };
        }
        // The tracker-repo scan is the only query that finds the keyword-close PR.
        if (q.includes(`repo:${ORG}/bdc-xo`)) {
          return { data: { total_count: 1, incomplete_results: false, items: [target] } };
        }
        return { data: { total_count: 0, incomplete_results: false, items: [] } };
      },
    },
    pulls: {
      listFiles: async () => ({ data: [{ filename: 'src/real-code.ts' }] }),
      get: async (input: Record<string, unknown>) => {
        if (Number(input.pull_number) !== 4326) throw new Error('unexpected pulls.get');
        return {
          data: {
            title: 'fix a bug',
            body: 'Fixes #4999',
            html_url: `https://github.com/${ORG}/bdc-xo/pull/4326`,
            state: 'closed' as const,
            merged: true,
            merge_commit_sha: 'abc1234',
            merged_at: '2026-11-01T18:23:09Z',
            base: { ref: 'main' },
          },
        };
      },
    },
    issues: {
      createComment: async () => undefined,
      addLabels: async () => undefined,
      update: async () => undefined,
    },
  } as unknown as OctokitLike;
}

test('Test 7: a keyword-close PR with no WO stem is discovered via the tracker-repo scan', async () => {
  const octokit = keywordOnlySearchOctokit();

  // Direct: searchMergedPullRequests surfaces the PR even though the WO- queries
  // (which it also issues) return nothing for it.
  const prs = await searchMergedPullRequests(octokit, { org: ORG, since: '2026-10-26' });
  expect(prs.map(p => `${p.owner}/${p.repo}#${p.number}`)).toContain(`${ORG}/bdc-xo#4326`);
  // It genuinely carries no WO stem, proving it was NOT found via a WO- query.
  expect(prs.some(p => /WO-/.test(`${p.title}\n${p.body ?? ''}`))).toBe(false);
});

test('Test 7 (mark path): the no-stem keyword PR marks its tracker merged exactly once', async () => {
  const octokit = keywordOnlySearchOctokit();
  const WO_4999 = 'WO-XO-NO-STEM-CLOSE-01';
  const state = harness({
    prs: [],
    searchMergedPullRequests: async input => searchMergedPullRequests(octokit, input),
    trackersByNumber: { 4999: tracker(4999, WO_4999) },
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expectMarkedOnce(state, WO_4999);
});

// ---------------------------------------------------------------------------
// Test 8: a reference glued to trailing text is NOT a valid close
// Regression: the closing-ref regex lacked a trailing boundary, so
// `thinmansoftware/bdc-xo#4130draft` parsed as tracker #4130 and could close it.
// ---------------------------------------------------------------------------

test('Test 8: a number glued to trailing text does not parse as a tracker ref', () => {
  // Cross-repo form with trailing letters -- rejected entirely.
  expect(
    extractClosingKeywordTrackerRefs(`Closes ${ORG}/bdc-xo#4130draft`, ORG, 'shopops')
  ).toEqual([]);
  // Same-repo form with trailing letters -- rejected entirely.
  expect(extractClosingKeywordTrackerRefs('Fixes #4130x', ORG, 'bdc-xo')).toEqual([]);
  // A trailing sentence period IS a real boundary and still resolves.
  expect(extractClosingKeywordTrackerRefs(`Closes ${ORG}/bdc-xo#4130.`, ORG, 'shopops')).toEqual([
    4130,
  ]);
  // Plain, well-formed reference still resolves (guards against over-tightening).
  expect(extractClosingKeywordTrackerRefs('Fixes #4130', ORG, 'bdc-xo')).toEqual([4130]);
});

// ---------------------------------------------------------------------------
// Test 9: the 7-day lookback floor rescans even when the cursor is newer
// Regression guard for resolveSearchSince: a cursor inside the floor window must
// still widen the search back to the floor. Observes the `since` sent to search.
// ---------------------------------------------------------------------------

test('Test 9: a cursor newer than the 7-day floor still rescans back to the floor', async () => {
  let observedSince = '';
  const state = harness({
    prs: [],
    searchMergedPullRequests: async input => {
      observedSince = input.since;
      return [];
    },
  });
  // Cursor one day before `now` (2026-11-02T12:00:00Z) -- well inside the 7-day floor.
  state.deps.readCursor = async () => '2026-11-01T09:00:00Z';

  await runReconcileOnce({ deps: state.deps });

  // Floor = now - 7 days = 2026-10-26. Without the floor, `since` would be the
  // newer cursor date (2026-11-01) and the pre-cursor merge window would be missed.
  expect(observedSince).toBe('2026-10-26');
});

// ---------------------------------------------------------------------------
// Test 10: pre_tracker_merge_never_closes (bdc-xo #4344 shape)
// PR 4326 merged 2026-11-02T20:15:40Z naming WO-XO-T3-CONTROL-HOST-SKELETON-01;
// tracker 4344 was created 2026-11-03T01:51:06Z and closed two minutes later.
// ---------------------------------------------------------------------------

const WO_4344 = 'WO-XO-T3-CONTROL-HOST-SKELETON-01';

function tracker4344(): ReconcileTrackerIssue {
  return { ...tracker(4344, WO_4344), createdAt: '2026-11-03T01:51:06Z' };
}

function pr4326(body: string): ReconcileMergedPullRequest {
  return mergedPr({
    owner: ORG,
    repo: 'bdc-xo',
    number: 4326,
    htmlUrl: `https://github.com/${ORG}/bdc-xo/pull/4326`,
    baseRef: 'main',
    mergedAt: '2026-11-02T20:15:40Z',
    body,
  });
}

test('Test 10: a PR merged before the tracker existed never closes it, even by name', async () => {
  const state = harness({
    prs: [pr4326(`T3 control host scripts for ${WO_4344}.\n\nWO: ${WO_4344}`)],
    trackersByNumber: { 4344: tracker4344() },
    trackersByStem: { [WO_4344]: tracker4344() },
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expect(state.closes).toEqual([]);
  expect(state.labels).toEqual([]);
  expect(state.comments).toEqual([]);
  expect(state.actions.filter(a => a.action === RECONCILE_ACTION)).toHaveLength(0);
  expect(state.actions.filter(a => a.action === RECONCILE_MERGED_ACTION)).toHaveLength(0);
});

test('Test 10 (keyword edited in after merge): a pre-tracker merge with `Closes #4344` still closes nothing', async () => {
  const state = harness({
    prs: [pr4326(`Closes #4344\n\nWO: ${WO_4344}`)],
    trackersByNumber: { 4344: tracker4344() },
    trackersByStem: { [WO_4344]: tracker4344() },
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expect(state.closes).toEqual([]);
  expect(state.labels).toEqual([]);
  expect(state.comments).toEqual([]);
  expect(state.warnings).toContain('overseer.reconcile.pr_merged_before_tracker_created_left_open');
});

test('Test 10 (control): the same keyword merged AFTER the tracker existed marks it merged once', async () => {
  const pr = { ...pr4326(`Closes #4344\n\nWO: ${WO_4344}`), mergedAt: '2026-11-03T02:30:00Z' };
  const state = harness({
    prs: [pr],
    trackersByNumber: { 4344: tracker4344() },
    trackersByStem: { [WO_4344]: tracker4344() },
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expectMarkedOnce(state, WO_4344);
});

// ---------------------------------------------------------------------------
// Holder: same-repo `Fixes #N` holds the tracker while the PR is open
// (Overseer review finding on PR 1432 at 4f57e792).
// ---------------------------------------------------------------------------

const WO_HOLD = 'WO-XO-HASH-REF-01';

function openPr(repo: string, number: number, body: string): ReconcileOpenPullRequest {
  return {
    owner: ORG,
    repo,
    number,
    title: 'second stage',
    body,
    htmlUrl: `https://github.com/${ORG}/${repo}/pull/${number}`,
  };
}

test('Holder: an open bdc-xo PR with only `Fixes #4999` holds tracker 4999', () => {
  const holders = openPullRequestsHoldingTracker({
    stem: WO_HOLD,
    mergedPr: { owner: ORG, repo: 'bdc-xo', number: 4326 },
    tracker: tracker(4999, WO_HOLD),
    openPullRequests: [openPr('bdc-xo', 4400, 'Fixes #4999')],
  });
  expect(holders.map(h => h.number)).toEqual([4400]);
});

test('Holder (other repo): an open shopops PR with `Fixes #4999` means shopops 4999 and does not hold', () => {
  const holders = openPullRequestsHoldingTracker({
    stem: WO_HOLD,
    mergedPr: { owner: ORG, repo: 'bdc-xo', number: 4326 },
    tracker: tracker(4999, WO_HOLD),
    openPullRequests: [openPr('shopops', 4400, 'Fixes #4999')],
  });
  expect(holders).toEqual([]);
});

test('Holder (mark path): a merged `Fixes #4999` does not mark while another open `Fixes #4999` PR holds it', async () => {
  const state = harness({
    prs: [
      mergedPr({
        owner: ORG,
        repo: 'bdc-xo',
        number: 4326,
        htmlUrl: `https://github.com/${ORG}/bdc-xo/pull/4326`,
        baseRef: 'main',
        body: 'Fixes #4999',
      }),
    ],
    trackersByNumber: { 4999: tracker(4999, WO_HOLD) },
    openPullRequests: [openPr('bdc-xo', 4400, 'Fixes #4999')],
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expect(state.closes).toEqual([]);
  expect(state.labels).toEqual([]);
});

test('Holder (discovery): the open-PR search also queries the tracker repo for the bare number', async () => {
  const queries: string[] = [];
  const octokit = {
    search: {
      issuesAndPullRequests: async (input: Record<string, unknown>) => {
        const q = String(input.q ?? '');
        queries.push(q);
        const items = q.startsWith(`repo:${ORG}/bdc-xo `)
          ? [
              {
                number: 4400,
                title: 'second stage',
                body: 'Fixes #4999',
                state: 'open',
                pull_request: {},
                repository_url: `https://api.github.com/repos/${ORG}/bdc-xo`,
                html_url: `https://github.com/${ORG}/bdc-xo/pull/4400`,
              },
            ]
          : [];
        return { data: { total_count: items.length, incomplete_results: false, items } };
      },
    },
  } as unknown as OctokitLike;

  const found = await searchOpenPullRequestsReferencingTracker(octokit, {
    issue: tracker(4999, WO_HOLD),
    stem: WO_HOLD,
  });

  expect(queries).toContain(`repo:${ORG}/bdc-xo is:pr is:open 4999`);
  expect(found.map(pr => pr.number)).toEqual([4400]);
});

// ---------------------------------------------------------------------------
// Test 11: LIVE-PROOF closes a status:merged tracker (amendment A1.3)
// ---------------------------------------------------------------------------

function comment(author: string, body: string, n: number): ReconcileTrackerComment {
  return {
    author,
    body,
    htmlUrl: `https://github.com/${ORG}/bdc-xo/issues/4130#issuecomment-${n}`,
    createdAt: `2026-11-03T0${n}:00:00Z`,
  };
}

const MERGED_NOTE = `${MERGED_MARKER}\nOverseer reconcile: ${SHOPOPS_WO} merged, not done.`;

function proofState(comments: ReconcileTrackerComment[], closeAlreadyRecorded = false) {
  return harness({
    prs: [],
    awaitingProof: [tracker(4130, SHOPOPS_WO)],
    commentsByIssue: { 4130: comments },
    closeAlreadyRecorded,
  });
}

test('Test 11: LIVE-PROOF from the XO after the merged note closes the tracker once', async () => {
  const state = proofState([
    comment('thinman-overseer[bot]', MERGED_NOTE, 1),
    comment(
      'bluedevilcollectibles',
      'Deployed.\nLIVE-PROOF https://example.test/run/1 4130 status ok',
      2
    ),
  ]);

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(1);
  expect(state.closes).toEqual([4130]);
  expect(state.labels).toEqual(['wo:done']);
  expect(state.comments[0]).toContain('issuecomment-2');
  expect(state.actions).toMatchObject([
    {
      prRef: `${ORG}/bdc-xo#4130`,
      woId: SHOPOPS_WO,
      class: 'live_proof',
      action: RECONCILE_ACTION,
    },
  ]);
});

test('Test 11 (not allowed): LIVE-PROOF from another login does nothing', async () => {
  const state = proofState([
    comment('thinman-overseer[bot]', MERGED_NOTE, 1),
    comment('random-user', 'LIVE-PROOF https://example.test/run/1', 2),
  ]);
  expect((await runReconcileOnce({ deps: state.deps })).closed).toBe(0);
  expect(state.closes).toEqual([]);
});

test('Test 11 (no evidence): a bare LIVE-PROOF does nothing', async () => {
  const state = proofState([
    comment('thinman-overseer[bot]', MERGED_NOTE, 1),
    comment('bluedevilcollectibles', 'LIVE-PROOF', 2),
    comment('bluedevilcollectibles', 'LIVE-PROOF    ', 3),
  ]);
  expect((await runReconcileOnce({ deps: state.deps })).closed).toBe(0);
  expect(state.closes).toEqual([]);
});

test('Test 11 (before the merge): a LIVE-PROOF older than the merged note does not count', async () => {
  const state = proofState([
    comment('bluedevilcollectibles', 'LIVE-PROOF https://example.test/old', 1),
    comment('thinman-overseer[bot]', MERGED_NOTE, 2),
  ]);
  expect((await runReconcileOnce({ deps: state.deps })).closed).toBe(0);
});

test('Test 11 (reopen): a tracker already closed once on LIVE-PROOF is not closed again', async () => {
  const state = proofState(
    [
      comment('thinman-overseer[bot]', MERGED_NOTE, 1),
      comment('bluedevilcollectibles', 'LIVE-PROOF https://example.test/run/1', 2),
    ],
    true
  );
  expect((await runReconcileOnce({ deps: state.deps })).closed).toBe(0);
  expect(state.closes).toEqual([]);
});

test('Test 11 (authors): OVERSEER_LIVE_PROOF_AUTHORS overrides the default list', () => {
  expect(liveProofAuthors({})).toEqual(['bluedevilcollectibles']);
  expect(liveProofAuthors({ OVERSEER_LIVE_PROOF_AUTHORS: ' Builder-Bot , xo ' })).toEqual([
    'builder-bot',
    'xo',
  ]);
  const proof = findLiveProof(
    [comment('bot', MERGED_NOTE, 1), comment('Builder-Bot', 'LIVE-PROOF ok 1/1', 2)],
    liveProofAuthors({ OVERSEER_LIVE_PROOF_AUTHORS: 'builder-bot' })
  );
  expect(proof?.evidence).toBe('ok 1/1');
});

// ---------------------------------------------------------------------------
// Test 12: a name-only PR leaves the tracker untouched (amendment A1.4)
// ---------------------------------------------------------------------------

test('Test 12: a merged PR that only names the WO and its tracker number marks nothing', async () => {
  const state = harness({
    prs: [
      mergedPr({
        baseRef: 'staging',
        body: `Work for ${SHOPOPS_WO} (tracker issue 4130).`,
      }),
    ],
    trackersByNumber: { 4130: tracker(4130, SHOPOPS_WO) },
    trackersByStem: { [SHOPOPS_WO]: tracker(4130, SHOPOPS_WO) },
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expect(state.closes).toEqual([]);
  expect(state.labels).toEqual([]);
  expect(state.comments).toEqual([]);
  expect(state.removed).toEqual([]);
});

// ---------------------------------------------------------------------------
// Test 13: a native GitHub close on a default-branch keyword merge is reopened
// and marked merged (amendment A2.1)
// ---------------------------------------------------------------------------

const WO_NATIVE = 'WO-XO-NATIVE-CLOSE-01';

function nativeCloseState(closeSha: string | null) {
  const reopened: number[] = [];
  const state = harness({
    prs: [
      mergedPr({
        owner: ORG,
        repo: 'bdc-xo',
        number: 4400,
        htmlUrl: `https://github.com/${ORG}/bdc-xo/pull/4400`,
        baseRef: 'main',
        mergeCommitSha: 'feedface',
        body: 'Fixes #4999',
      }),
    ],
    trackersByNumber: { 4999: tracker(4999, WO_NATIVE, 'closed') },
  });
  state.deps.wasClosedByPullRequestMerge = async input =>
    closeSha !== null && closeSha === input.pr.mergeCommitSha;
  state.deps.reopenTrackerIssue = async input => {
    reopened.push(input.issue.number);
  };
  return { state, reopened };
}

test('Test 13: a bdc-xo main merge with `Fixes #4999` that GitHub closed is reopened and marked merged', async () => {
  const { state, reopened } = nativeCloseState('feedface');

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expect(reopened).toEqual([4999]);
  expectMarkedOnce(state, WO_NATIVE);
  expect(state.comments[0]).toContain(
    'reopened: DONE = tested live (John 2026-10-15); close with LIVE-PROOF'
  );
});

test('Test 13 (other closer): a tracker closed by someone else stays closed and unmarked', async () => {
  for (const sha of [null, 'cafebabe']) {
    const { state, reopened } = nativeCloseState(sha);
    await runReconcileOnce({ deps: state.deps });
    expect(reopened).toEqual([]);
    expect(state.labels).toEqual([]);
    expect(state.comments).toEqual([]);
  }
});

test('Test 13 (once): a recorded mark means a later human close is never reopened again', async () => {
  const { state, reopened } = nativeCloseState('feedface');
  state.deps.hasMergedBeenNoted = async () => true;
  await runReconcileOnce({ deps: state.deps });
  expect(reopened).toEqual([]);
  expect(state.labels).toEqual([]);
});

// ---------------------------------------------------------------------------
// Test 14: a LIVE-PROOF close re-checks open-PR holders (amendment A2.2)
// ---------------------------------------------------------------------------

function holderProofState(lookup: ReconcileDeps['listOpenPullRequestsReferencingTracker']) {
  const state = proofState([
    comment('thinman-overseer[bot]', MERGED_NOTE, 1),
    comment('bluedevilcollectibles', 'LIVE-PROOF https://example.test/run/1', 2),
  ]);
  state.deps.listOpenPullRequestsReferencingTracker = lookup;
  return state;
}

test('Test 14: LIVE-PROOF does not close while an open PR still holds the WO', async () => {
  const state = holderProofState(async () => [openPr('shopops', 990, `Closes ${ORG}/bdc-xo#4130`)]);
  expect((await runReconcileOnce({ deps: state.deps })).closed).toBe(0);
  expect(state.closes).toEqual([]);
  expect(state.warnings).toContain('overseer.reconcile.live_proof_open_prs_hold_tracker_open');
});

test('Test 14 (lookup fails): LIVE-PROOF leaves the tracker open', async () => {
  const state = holderProofState(async () => {
    throw new Error('search 502');
  });
  expect((await runReconcileOnce({ deps: state.deps })).closed).toBe(0);
  expect(state.closes).toEqual([]);
  expect(state.warnings).toContain('overseer.reconcile.live_proof_holder_lookup_failed_left_open');
});

test('Test 14 (no holder): LIVE-PROOF closes once', async () => {
  const state = holderProofState(async () => [openPr('shopops', 991, 'unrelated work')]);
  expect((await runReconcileOnce({ deps: state.deps })).closed).toBe(1);
  expect(state.closes).toEqual([4130]);
});
