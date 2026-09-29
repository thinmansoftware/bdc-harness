/**
 * Reconcile must NOT close a WO tracker while another open PR still holds it.
 *
 * Anchor: bdc-harness #1051. shopops#760 merged and reconcile closed bdc-xo#2581
 * while stage B PRs #762 and #763 were still open.
 */

import { expect, mock, test } from 'bun:test';
import {
  openPullRequestsHoldingTracker,
  RECONCILE_ACTION,
  RECONCILE_HOLD_OPEN_ACTION,
  runReconcileOnce,
  searchOpenPullRequestsReferencingTracker,
  type OctokitLike,
  type ReconcileActionRecord,
  type ReconcileDeps,
  type ReconcileMergedPullRequest,
  type ReconcileOpenPullRequest,
  type ReconcileTrackerIssue,
} from '../reconcile';

const stem = 'WO-HARNESS-RECONCILE-OPEN-PR-GUARD-01';

function mergedPullRequest(): ReconcileMergedPullRequest {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    number: 404,
    title: 'BDC feature Work Order implementation',
    body: `WO: ${stem}`,
    htmlUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/404',
    state: 'closed',
    merged: true,
    mergeCommitSha: 'abc123merge',
    mergedAt: '2026-09-29T12:00:00Z',
  };
}

function trackerIssue(): ReconcileTrackerIssue {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-xo',
    number: 1044,
    title: stem,
    state: 'open',
  };
}

function openPullRequest(
  overrides: Partial<ReconcileOpenPullRequest> = {}
): ReconcileOpenPullRequest {
  return {
    owner: 'thinmansoftware',
    repo: 'shopops',
    number: 762,
    title: 'Stage B',
    body: `WO: ${stem}`,
    htmlUrl: 'https://github.com/thinmansoftware/shopops/pull/762',
    ...overrides,
  };
}

function harness(
  input: {
    openPullRequests?: ReconcileOpenPullRequest[];
    omitOpenPrLookup?: boolean;
    openPrLookup?: () => Promise<ReconcileOpenPullRequest[]>;
    holdAlreadyNoted?: boolean;
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
  const deps: ReconcileDeps & {
    comments: string[];
    labels: string[];
    closes: number[];
    actions: ReconcileActionRecord[];
    warnings: string[];
  } = {
    comments,
    labels,
    closes,
    actions,
    warnings,
    readCursor: mock(async () => null),
    now: () => new Date('2026-09-29T12:00:00Z'),
    searchMergedPullRequests: mock(async () => [mergedPullRequest()]),
    findTrackerIssueByStem: mock(async (candidate: string) => {
      if (candidate !== stem) return null;
      return trackerIssue();
    }),
    addTrackerEvidenceComment: mock(async (request: { body: string }) => {
      comments.push(request.body);
    }),
    addTrackerLabel: mock(async (request: { label: string }) => {
      labels.push(request.label);
    }),
    closeTrackerIssue: mock(async (request: { issue: ReconcileTrackerIssue }) => {
      closes.push(request.issue.number);
    }),
    hasSkipBeenNoted: mock(async () => false),
    hasCloseBeenRecorded: mock(async () => false),
    hasHoldBeenNoted: mock(async () => Boolean(input.holdAlreadyNoted)),
    insertAction: mock(async (record: ReconcileActionRecord) => {
      actions.push(record);
    }),
    log: {
      warn(_fields: Record<string, unknown>, message: string): void {
        warnings.push(message);
      },
    },
  };
  if (!input.omitOpenPrLookup) {
    const lookup = input.openPrLookup ?? (async () => input.openPullRequests ?? []);
    deps.listOpenPullRequestsReferencingTracker = mock(lookup);
  }
  return deps;
}

function expectNormalClose(deps: ReturnType<typeof harness>, result: { closed: number }): void {
  expect(result.closed).toBe(1);
  expect(deps.closes).toEqual([1044]);
  expect(deps.labels).toEqual(['wo:done']);
  expect(deps.comments).toHaveLength(1);
  expect(deps.comments[0]).toContain('Overseer reconcile closed tracker');
  expect(deps.actions).toEqual([
    {
      prRef: 'thinmansoftware/bdc-harness#404',
      woId: stem,
      class: 'tracker_reconcile',
      action: RECONCILE_ACTION,
      result: 'https://github.com/thinmansoftware/bdc-harness/pull/404:abc123merge',
    },
  ]);
}

test('open_sibling_pr_keeps_tracker_open_and_notes_once', async () => {
  const holder = openPullRequest();
  const deps = harness({ openPullRequests: [holder] });

  const result = await runReconcileOnce({ deps });

  expect(result.closed).toBe(0);
  expect(deps.closes).toEqual([]);
  expect(deps.labels).toEqual([]);
  expect(deps.comments).toHaveLength(1);
  expect(deps.comments[0]).toContain('stage merged');
  expect(deps.comments[0]).toContain('#762');
  expect(deps.actions).toEqual([
    {
      prRef: 'thinmansoftware/bdc-harness#404',
      woId: stem,
      class: 'tracker_reconcile',
      action: RECONCILE_HOLD_OPEN_ACTION,
      result: 'https://github.com/thinmansoftware/bdc-harness/pull/404:abc123merge',
    },
  ]);
});

test('all_prs_merged_closes_the_tracker_as_before', async () => {
  const deps = harness({ openPullRequests: [] });

  const result = await runReconcileOnce({ deps });

  expectNormalClose(deps, result);
});

test('hold_note_is_deduplicated_across_rescans', async () => {
  const deps = harness({
    openPullRequests: [openPullRequest()],
    holdAlreadyNoted: true,
  });

  const result = await runReconcileOnce({ deps });

  expect(result.closed).toBe(0);
  expect(deps.comments).toEqual([]);
  expect(deps.closes).toEqual([]);
  expect(deps.labels).toEqual([]);
  expect(deps.actions).toEqual([]);
  expect(deps.warnings).toContain('overseer.reconcile.open_prs_hold_tracker_open');
});

test('open_pr_with_a_reconcile_skip_marker_does_not_hold', async () => {
  const deps = harness({
    openPullRequests: [openPullRequest({ body: `Reconcile-Skip: ${stem}` })],
  });

  const result = await runReconcileOnce({ deps });

  expectNormalClose(deps, result);
});

test('open_pr_that_only_mentions_the_stem_in_prose_does_not_hold', async () => {
  const deps = harness({
    openPullRequests: [
      openPullRequest({
        body: `WO: WO-OTHER-01\nThis note mentions ${stem} only as a dependency.`,
      }),
    ],
  });

  const result = await runReconcileOnce({ deps });

  expectNormalClose(deps, result);
});

test('closes_line_with_a_prefixed_owner_does_not_hold_the_tracker', () => {
  const prefixed = openPullRequest({
    title: 'Unrelated stage',
    body: 'Closes evilthinmansoftware/bdc-xo#1044',
  });
  const holders = openPullRequestsHoldingTracker({
    stem,
    mergedPr: mergedPullRequest(),
    tracker: trackerIssue(),
    openPullRequests: [prefixed],
  });
  expect(holders).toEqual([]);
});

test('closes_line_for_a_longer_issue_number_does_not_hold_the_shorter_tracker', () => {
  const longer = openPullRequest({
    title: 'Unrelated stage',
    body: 'Closes thinmansoftware/bdc-xo#10440',
  });
  const holders = openPullRequestsHoldingTracker({
    stem,
    mergedPr: mergedPullRequest(),
    tracker: trackerIssue(),
    openPullRequests: [longer],
  });
  expect(holders).toEqual([]);
});

test('closes_line_still_holds_when_the_exact_token_follows_punctuation', () => {
  const holder = openPullRequest({
    title: 'Stage B follow-up',
    body: 'Closes thinmansoftware/bdc-xo#10440, thinmansoftware/bdc-xo#1044.',
  });
  const holders = openPullRequestsHoldingTracker({
    stem,
    mergedPr: mergedPullRequest(),
    tracker: trackerIssue(),
    openPullRequests: [holder],
  });
  expect(holders).toEqual([holder]);
});

test('open_pr_naming_the_tracker_in_a_closes_line_holds_even_without_the_stem', async () => {
  const holder = openPullRequest({
    title: 'Stage B follow-up',
    body: 'Closes thinmansoftware/bdc-xo#1044',
  });
  const holders = openPullRequestsHoldingTracker({
    stem,
    mergedPr: mergedPullRequest(),
    tracker: trackerIssue(),
    openPullRequests: [holder],
  });
  expect(holders).toEqual([holder]);

  const deps = harness({ openPullRequests: [holder] });
  const result = await runReconcileOnce({ deps });

  expect(result.closed).toBe(0);
  expect(deps.closes).toEqual([]);
  expect(deps.comments).toHaveLength(1);
  expect(deps.comments[0]).toContain('stage merged');
  expect(deps.comments[0]).toContain('#762');
  expect(deps.actions[0]?.action).toBe(RECONCILE_HOLD_OPEN_ACTION);
});

test('lookup_failure_leaves_the_tracker_open', async () => {
  const deps = harness({
    openPrLookup: async () => {
      throw new Error('GitHub 502');
    },
  });

  const result = await runReconcileOnce({ deps });

  expect(result.closed).toBe(0);
  expect(result.skipped).toBe(false);
  expect(deps.closes).toEqual([]);
  expect(deps.labels).toEqual([]);
  expect(deps.comments).toEqual([]);
  expect(deps.actions).toEqual([]);
  expect(deps.warnings).toContain('overseer.reconcile.open_pr_lookup_failed_leaving_tracker_open');
});

test('absent_dep_preserves_prior_behavior', async () => {
  const deps = harness({ omitOpenPrLookup: true });

  const result = await runReconcileOnce({ deps });

  expectNormalClose(deps, result);
});

test('the_merged_pr_itself_is_never_counted_as_a_holder', async () => {
  const merged = mergedPullRequest();
  const deps = harness({
    openPullRequests: [
      openPullRequest({
        owner: merged.owner,
        repo: merged.repo,
        number: merged.number,
        title: merged.title,
        body: merged.body,
        htmlUrl: merged.htmlUrl,
      }),
    ],
  });

  const result = await runReconcileOnce({ deps });

  expectNormalClose(deps, result);
});

function searchItem(number: number) {
  return {
    number,
    title: `PR ${number}`,
    body: null,
    state: 'open',
    pull_request: {},
    repository_url: 'https://api.github.com/repos/thinmansoftware/bdc-harness',
  };
}

function pagedOctokit(
  pages: Record<
    number,
    { items: ReturnType<typeof searchItem>[]; total: number; incomplete?: boolean }
  >
): { octokit: OctokitLike; pagesRequested: number[] } {
  const pagesRequested: number[] = [];
  const octokit = {
    search: {
      issuesAndPullRequests: async (input: Record<string, unknown>) => {
        const page = Number(input.page ?? 1);
        pagesRequested.push(page);
        const entry = pages[page] ?? { items: [], total: 0 };
        return {
          data: {
            total_count: entry.total,
            incomplete_results: entry.incomplete ?? false,
            items: entry.items,
          },
        };
      },
    },
  } as unknown as OctokitLike;
  return { octokit, pagesRequested };
}

const pagedTracker: ReconcileTrackerIssue = {
  owner: 'thinmansoftware',
  repo: 'bdc-xo',
  number: 1044,
  title: stem,
  state: 'open',
};

test('open_pr_search_reads_a_holder_that_appears_beyond_the_first_page', async () => {
  const first = Array.from({ length: 100 }, (_, i) => searchItem(i + 1));
  const { octokit, pagesRequested } = pagedOctokit({
    1: { items: first, total: 101 },
    2: { items: [searchItem(500)], total: 101 },
  });

  const found = await searchOpenPullRequestsReferencingTracker(octokit, {
    issue: pagedTracker,
    stem,
  });

  expect(found.map(p => p.number)).toContain(500);
  expect(found).toHaveLength(101);
  expect(pagesRequested).toContain(2);
});

test('open_pr_search_throws_when_results_are_incomplete', async () => {
  const { octokit } = pagedOctokit({ 1: { items: [searchItem(1)], total: 1, incomplete: true } });
  await expect(
    searchOpenPullRequestsReferencingTracker(octokit, { issue: pagedTracker, stem })
  ).rejects.toThrow('incomplete');
});

test('open_pr_search_throws_when_results_exceed_the_retrievable_limit', async () => {
  const full = Array.from({ length: 100 }, (_, i) => searchItem(i + 1));
  const pages: Record<number, { items: ReturnType<typeof searchItem>[]; total: number }> = {};
  for (let page = 1; page <= 10; page++) pages[page] = { items: full, total: 1500 };
  const { octokit } = pagedOctokit(pages);
  await expect(
    searchOpenPullRequestsReferencingTracker(octokit, { issue: pagedTracker, stem })
  ).rejects.toThrow('exceeds retrievable');
});
