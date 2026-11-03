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
  RECONCILE_ACTION,
  runReconcileOnce,
  searchMergedPullRequests,
  type OctokitLike,
  type ReconcileActionRecord,
  type ReconcileDeps,
  type ReconcileMergedPullRequest,
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
}

interface HarnessState {
  deps: ReconcileDeps;
  comments: string[];
  labels: string[];
  closes: number[];
  actions: ReconcileActionRecord[];
  warnings: string[];
  infos: string[];
}

function harness(options: HarnessOptions): HarnessState {
  const comments: string[] = [];
  const labels: string[] = [];
  const closes: number[] = [];
  const actions: ReconcileActionRecord[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const byNumber = options.trackersByNumber ?? {};
  const byStem = options.trackersByStem ?? {};
  const deps: ReconcileDeps = {
    readCursor: async () => null,
    now: () => new Date('2026-11-02T12:00:00Z'),
    searchMergedPullRequests: options.searchMergedPullRequests ?? (async () => options.prs),
    findTrackerIssueByNumber: async (number: number) => byNumber[number] ?? null,
    findTrackerIssueByStem: async (stem: string) => byStem[stem] ?? null,
    listPullRequestFiles: async () => options.files ?? ['src/real-code.ts'],
    listOpenPullRequestsReferencingTracker: async () => [],
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
    insertAction: async record => {
      actions.push(record);
    },
    log: {
      warn: (_fields, message) => warnings.push(message),
      info: (_fields, message) => infos.push(message),
    },
  };
  return { deps, comments, labels, closes, actions, warnings, infos };
}

function tracker(
  number: number,
  title: string,
  state: 'open' | 'closed' = 'open'
): ReconcileTrackerIssue {
  return { owner: ORG, repo: 'bdc-xo', number, title, state };
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

test('Test 1: a staging merge with a Closes keyword on page 2 of the search closes the tracker', async () => {
  const octokit = pagedSearchOctokit(searchItem(948, 'shopops', true));
  const state = harness({
    prs: [],
    searchMergedPullRequests: async input => searchMergedPullRequests(octokit, input),
    trackersByNumber: { 4130: tracker(4130, SHOPOPS_WO) },
    trackersByStem: { [SHOPOPS_WO]: tracker(4130, SHOPOPS_WO) },
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(1);
  expect(state.closes).toEqual([4130]);
  expect(state.actions.filter(a => a.action === RECONCILE_ACTION)).toMatchObject([
    { woId: SHOPOPS_WO, class: 'closes_keyword', action: RECONCILE_ACTION },
  ]);
  // No keyword-missing note: the declared WO's tracker (4130) was keyword-closed.
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

test('Test 2: a bdc-xo PR into main with `Fixes #4999` closes 4999 exactly once', async () => {
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

  expect(result.closed).toBe(1);
  expect(state.closes).toEqual([4999]);
  expect(state.actions.filter(a => a.action === RECONCILE_ACTION)).toHaveLength(1);
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

test('Test 6 (close path): the override redirects which branch closes, and an unknown repo closes nothing', async () => {
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
    expect((await runReconcileOnce({ deps: releaseState.deps })).closed).toBe(1);

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
