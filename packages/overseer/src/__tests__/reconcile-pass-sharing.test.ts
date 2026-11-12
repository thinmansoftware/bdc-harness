// bdc-xo#5571 part 3: one open-PR list per repository per reconcile pass, and a per-pass call count.
// After PR 1578 the reconcile-spelling `{o}/{r}/pulls` rose from 866 to 1,580 calls an hour: the supersede
// pass listed the repository's OPEN pull requests once per merged pull request. These cases pin the
// sharing and the counts that let the next reading PROVE which reader owns which calls.
import { describe, expect, test } from 'bun:test';
import {
  RECONCILE_SUPERSEDE_ACTION,
  listOpenMergedTrackers,
  runReconcileOnce,
  type OctokitLike,
  type ReconcileDeps,
  type ReconcileRepoOpenPullRequest,
} from '../reconcile';
import { fakeDeps, mergedPr } from './reconcile.test';

function openPr(
  number: number,
  body: string,
  repo = 'bdc-harness',
  headRefName = `archon/task-${number}`
): ReconcileRepoOpenPullRequest {
  return {
    number,
    body,
    headRefName,
    isDraft: false,
    headRepository: { owner: 'thinmansoftware', repo },
    createdAt: '2026-07-17T11:00:00Z',
  };
}

function sharingDeps(input: {
  merged: ReturnType<typeof mergedPr>[];
  opens: Record<string, ReconcileRepoOpenPullRequest[]>;
  listError?: (call: number) => boolean;
}) {
  const deps = fakeDeps({ prs: input.merged });
  const listed: string[] = [];
  const closes: Array<{ repo: string; number: number; comment: string }> = [];
  const logs: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];
  let calls = 0;
  deps.listOpenPullRequestsInRepo = async request => {
    calls += 1;
    listed.push(`${request.owner}/${request.repo}`);
    if (input.listError?.(calls)) throw new Error('list failed');
    return input.opens[request.repo] ?? [];
  };
  deps.closePullRequest = async request => {
    closes.push({ repo: request.repo, number: request.number, comment: request.comment });
  };
  deps.hasSupersedeBeenRecorded = async ({ prRef, woId }) =>
    deps.actions.some(
      action =>
        action.action === RECONCILE_SUPERSEDE_ACTION &&
        action.prRef === prRef &&
        action.woId === woId
    );
  deps.log = {
    warn: (fields, message) => {
      logs.push({ level: 'warn', message, fields: fields as Record<string, unknown> });
    },
    info: (fields, message) => {
      logs.push({ level: 'info', message, fields: fields as Record<string, unknown> });
    },
  };
  return Object.assign(deps, { listed, closes, logs });
}

const countsOf = (logs: Array<{ message: string; fields: Record<string, unknown> }>) => {
  const line = logs.filter(entry => entry.message === 'overseer.reconcile.call_counts');
  expect(line).toHaveLength(1);
  return line[0]?.fields.counts as Record<string, number>;
};

describe('reconcile pass: one open-PR list per repository', () => {
  test('two merged PRs in one repository read the open-PR list once and still close each sibling', async () => {
    const deps = sharingDeps({
      merged: [
        mergedPr({ number: 201, body: 'WO: WO-AAA-01\n', baseRef: 'dev' }),
        mergedPr({ number: 202, body: 'WO: WO-BBB-01\n', baseRef: 'dev' }),
      ],
      opens: {
        'bdc-harness': [openPr(301, 'WO: WO-AAA-01\n'), openPr(302, 'WO: WO-BBB-01\n')],
      },
    });

    await runReconcileOnce({ deps });

    expect(deps.listed).toEqual(['thinmansoftware/bdc-harness']);
    expect(deps.closes.map(close => [close.number, close.comment]).sort()).toEqual([
      [301, 'Superseded by #201'],
      [302, 'Superseded by #202'],
    ]);
    const counts = countsOf(deps.logs);
    expect(counts['open_pr_list:reads']).toBe(1);
    expect(counts['open_pr_list:cache_hits']).toBe(1);
    // The dependency itself was asked twice (once per merged PR); only the first reached GitHub.
    expect(counts['calls:listOpenPullRequestsInRepo']).toBe(2);
    expect(counts['calls:searchMergedPullRequests']).toBe(1);
  });

  test('a sibling closed by the first merged PR is not matched and commented on again by the second', async () => {
    const deps = sharingDeps({
      merged: [
        mergedPr({ number: 201, body: 'WO: WO-AAA-01\n', baseRef: 'dev' }),
        mergedPr({ number: 202, body: 'WO: WO-BBB-01\n', baseRef: 'dev' }),
      ],
      // 301 names BOTH work orders: before the sharing, the first close removed it from the second list.
      opens: { 'bdc-harness': [openPr(301, 'WO: WO-AAA-01\nWO: WO-BBB-01\n')] },
    });

    await runReconcileOnce({ deps });

    expect(deps.closes.map(close => close.number)).toEqual([301]);
    expect(deps.listed).toHaveLength(1);
  });

  test('different repositories are listed separately', async () => {
    const deps = sharingDeps({
      merged: [
        mergedPr({ number: 201, body: 'WO: WO-AAA-01\n', baseRef: 'dev' }),
        mergedPr({
          number: 202,
          repo: 'bdc-xo',
          body: 'WO: WO-BBB-01\n',
          baseRef: 'main',
          htmlUrl: 'https://github.com/thinmansoftware/bdc-xo/pull/202',
        }),
      ],
      opens: {},
    });

    await runReconcileOnce({ deps });

    expect(deps.listed.sort()).toEqual(['thinmansoftware/bdc-harness', 'thinmansoftware/bdc-xo']);
    const counts = countsOf(deps.logs);
    expect(counts['open_pr_list:reads']).toBe(2);
    expect(counts['open_pr_list:cache_hits'] ?? 0).toBe(0);
  });

  test('a failed list is not cached: the next merged PR of the repository reads it again', async () => {
    const deps = sharingDeps({
      merged: [
        mergedPr({ number: 201, body: 'WO: WO-AAA-01\n', baseRef: 'dev' }),
        mergedPr({ number: 202, body: 'WO: WO-BBB-01\n', baseRef: 'dev' }),
      ],
      opens: { 'bdc-harness': [openPr(302, 'WO: WO-BBB-01\n')] },
      listError: call => call === 1,
    });

    await runReconcileOnce({ deps });

    expect(deps.listed).toHaveLength(2);
    expect(deps.closes.map(close => close.number)).toEqual([302]);
    expect(
      deps.logs.some(entry => entry.message === 'overseer.reconcile.supersede_list_failed')
    ).toBe(true);
  });

  test('GitHub pages are counted by reader inside the pass', async () => {
    const deps = sharingDeps({
      merged: [mergedPr({ number: 201, body: 'WO: WO-AAA-01\n', baseRef: 'dev' })],
      opens: {},
    });
    const octokit = {
      issues: { listForRepo: async () => ({ data: [] }) },
    } as unknown as OctokitLike;
    const inner: NonNullable<ReconcileDeps['listOpenPullRequestsInRepo']> = async () => {
      await listOpenMergedTrackers(octokit);
      return [];
    };
    deps.listOpenPullRequestsInRepo = inner;

    await runReconcileOnce({ deps });

    expect(countsOf(deps.logs)['pages:merged_trackers']).toBe(1);
  });
});
