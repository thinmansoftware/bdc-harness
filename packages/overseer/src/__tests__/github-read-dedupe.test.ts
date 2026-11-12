/**
 * WO-HARNESS-OVERSEER-GITHUB-READ-BUDGET-01 part 2 (bdc-xo#5571): the reconcile pass no longer
 * re-reads the same merged pull request, or its file list, on every run.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  listPullRequestFilePaths,
  resetReconcileReadCaches,
  searchMergedPullRequestsPaged,
  type OctokitLike,
} from '../reconcile';

interface Item {
  number: number;
  updated_at?: string;
}

function fakeOctokit(
  items: () => Item[],
  merged: (number: number) => boolean = () => true
): { octokit: OctokitLike; gets: number[]; filePages: number[] } {
  const gets: number[] = [];
  const filePages: number[] = [];
  const octokit = {
    search: {
      issuesAndPullRequests: async () => ({
        data: {
          items: items().map(item => ({
            number: item.number,
            title: `title ${item.number}`,
            body: null,
            state: 'closed',
            pull_request: {},
            repository_url: 'https://api.github.com/repos/thinmansoftware/bdc-harness',
            ...(item.updated_at ? { updated_at: item.updated_at } : {}),
          })),
        },
      }),
    },
    pulls: {
      get: async (input: Record<string, unknown>) => {
        gets.push(input.pull_number as number);
        return {
          data: {
            title: `pr ${String(input.pull_number)}`,
            body: null,
            html_url: `https://github.com/thinmansoftware/bdc-harness/pull/${String(input.pull_number)}`,
            state: 'closed' as const,
            merged: merged(input.pull_number as number),
            merge_commit_sha: `merge${String(input.pull_number)}`,
            merged_at: '2026-11-12T00:00:00Z',
            base: { ref: 'dev' },
          },
        };
      },
      listFiles: async (input: Record<string, unknown>) => {
        filePages.push(input.page as number);
        return { data: Array.from({ length: 2 }, (_, i) => ({ filename: `f${i}.ts` })) };
      },
    },
    issues: {},
  } as unknown as OctokitLike;
  return { octokit, gets, filePages };
}

const run = (octokit: OctokitLike) =>
  searchMergedPullRequestsPaged(octokit, { org: 'thinmansoftware', since: '2026-11-05' });

beforeEach(() => resetReconcileReadCaches());

describe('merged pull request reads across reconcile runs', () => {
  test('4: three merged pull requests are read once across two runs', async () => {
    const items = [
      { number: 1, updated_at: '2026-11-12T00:00:00Z' },
      { number: 2, updated_at: '2026-11-12T00:01:00Z' },
      { number: 3, updated_at: '2026-11-12T00:02:00Z' },
    ];
    const { octokit, gets } = fakeOctokit(() => items);
    const first = await run(octokit);
    const second = await run(octokit);
    expect(gets.sort()).toEqual([1, 2, 3]);
    expect(first.items.length).toBe(3);
    expect(second.items).toEqual(first.items);
    expect(second.items.map(i => i.mergeCommitSha)).toEqual(['merge1', 'merge2', 'merge3']);
  });

  test('5: a pull request GitHub says changed is read again; the others are not', async () => {
    let items: Item[] = [
      { number: 1, updated_at: '2026-11-12T00:00:00Z' },
      { number: 2, updated_at: '2026-11-12T00:01:00Z' },
    ];
    const { octokit, gets } = fakeOctokit(() => items);
    await run(octokit);
    items = [
      { number: 1, updated_at: '2026-11-12T00:00:00Z' },
      { number: 2, updated_at: '2026-11-12T03:30:00Z' },
    ];
    await run(octokit);
    expect(gets).toEqual([1, 2, 2]);
  });

  test('5b: nothing is served from the cache without an updated_at, or for an unmerged pull request', async () => {
    const noStamp = fakeOctokit(() => [{ number: 7 }]);
    await run(noStamp.octokit);
    await run(noStamp.octokit);
    expect(noStamp.gets).toEqual([7, 7]);

    resetReconcileReadCaches();
    const unmerged = fakeOctokit(
      () => [{ number: 8, updated_at: '2026-11-12T00:00:00Z' }],
      () => false
    );
    await run(unmerged.octokit);
    await run(unmerged.octokit);
    expect(unmerged.gets).toEqual([8, 8]);
  });

  test('the returned objects are copies: a caller changing one cannot change the next run', async () => {
    const items = [{ number: 1, updated_at: '2026-11-12T00:00:00Z' }];
    const { octokit } = fakeOctokit(() => items);
    const first = await run(octokit);
    (first.items[0] as { title: string }).title = 'changed by a caller';
    const second = await run(octokit);
    expect(second.items[0]?.title).toBe('pr 1');
  });
});

describe('merged pull request file lists across reconcile runs', () => {
  const pr = { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1 };

  test('a file list is read once per merge commit', async () => {
    const { octokit, filePages } = fakeOctokit(() => []);
    const a = await listPullRequestFilePaths(octokit, { ...pr, mergeCommitSha: 'abc' });
    const b = await listPullRequestFilePaths(octokit, { ...pr, mergeCommitSha: 'abc' });
    expect(a).toEqual({ items: ['f0.ts', 'f1.ts'], truncated: false });
    expect(b).toEqual(a);
    expect(filePages.length).toBe(1);
    await listPullRequestFilePaths(octokit, { ...pr, mergeCommitSha: 'def' });
    expect(filePages.length).toBe(2);
  });

  test('a pull request with no merge commit is never cached', async () => {
    const { octokit, filePages } = fakeOctokit(() => []);
    await listPullRequestFilePaths(octokit, pr);
    await listPullRequestFilePaths(octokit, { ...pr, mergeCommitSha: null });
    expect(filePages.length).toBe(2);
  });

  test('a truncated read is never cached', async () => {
    const calls: number[] = [];
    const octokit = {
      pulls: {
        listFiles: async (input: Record<string, unknown>) => {
          calls.push(input.page as number);
          return { data: Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts` })) };
        },
      },
    } as unknown as OctokitLike;
    const first = await listPullRequestFilePaths(octokit, { ...pr, mergeCommitSha: 'abc' });
    expect(first.truncated).toBe(true);
    const afterFirst = calls.length;
    await listPullRequestFilePaths(octokit, { ...pr, mergeCommitSha: 'abc' });
    expect(calls.length).toBe(afterFirst * 2);
  });
});
