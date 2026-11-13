/**
 * WO-HARNESS-MERGE-GATES-01, Test 3: merge_choke_point_refuses_fresh_hold_draft_and_fallback.
 * createRealMergePullRequest is the one function every merge path calls; it re-checks the FRESH
 * pulls.get response, so a label added after the evidence was assembled still stops the merge and a
 * response lacking labels or the draft field is refused, never assumed clean.
 */
import { describe, expect, mock, test } from 'bun:test';
import { createRealMergePullRequest, type RealGitHubOctokitLike } from './github-real-deps.ts';

const HEAD = 'a'.repeat(40);
const INPUT = {
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  number: 42,
  mergeMethod: 'squash' as const,
  expectedHeadSha: HEAD,
};

function octokitReturning(data: Record<string, unknown>) {
  const merge = mock(async () => ({ data: { merged: true, sha: 'f'.repeat(40) } }));
  const octokit = {
    pulls: {
      get: async () => ({
        data: {
          number: 42,
          title: 'Ordinary change',
          state: 'open',
          html_url: 'https://github.test/pull/42',
          head: { sha: HEAD },
          ...data,
        },
      }),
      merge,
    },
  } as unknown as RealGitHubOctokitLike;
  return { octokit, merge };
}

describe('Test 3: merge_choke_point_refuses_fresh_hold_draft_and_fallback', () => {
  const refused: { name: string; data: Record<string, unknown>; message: string }[] = [
    {
      name: 'merge-hold label',
      data: { labels: [{ name: 'merge-hold' }], draft: false },
      message: 'merge_hold_label',
    },
    {
      name: 'differently spelled hold label',
      data: { labels: [{ name: 'Merge-Hold' }], draft: false },
      message: 'merge_hold_label',
    },
    { name: 'draft', data: { labels: [], draft: true }, message: 'pr_is_draft' },
    {
      name: 'FALLBACK title',
      data: {
        labels: [],
        draft: false,
        title: 'FALLBACK: opus-repaired build needs human review',
      },
      message: 'fallback_pr_title',
    },
    { name: 'no labels property', data: { draft: false }, message: 'pr_labels_unknown' },
    { name: 'no draft property', data: { labels: [] }, message: 'pr_draft_unknown' },
  ];

  for (const item of refused) {
    test(`refuses: ${item.name}`, async () => {
      const { octokit, merge } = octokitReturning(item.data);
      const result = await createRealMergePullRequest(octokit)(INPUT);
      expect(result).toEqual({ merged: false, message: item.message });
      expect(merge).not.toHaveBeenCalled();
    });
  }

  test('a clean PR merges exactly once (squash, expected head sha)', async () => {
    const { octokit, merge } = octokitReturning({ labels: [], draft: false });
    const result = await createRealMergePullRequest(octokit)(INPUT);
    expect(result.merged).toBe(true);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge.mock.calls[0]?.[0]).toMatchObject({
      sha: HEAD,
      merge_method: 'squash',
      pull_number: 42,
    });
  });

  test('a PR that was clean when the evidence was assembled but carries merge-hold NOW is refused', async () => {
    // The caller's evidence (older) said no labels; the fresh response says merge-hold.
    const { octokit, merge } = octokitReturning({ labels: [{ name: 'merge-hold' }], draft: false });
    const result = await createRealMergePullRequest(octokit)(INPUT);
    expect(result.merged).toBe(false);
    expect(merge).not.toHaveBeenCalled();
  });

  test('a moved head is still reported as head_moved, before any hold check', async () => {
    const { octokit, merge } = octokitReturning({
      labels: [{ name: 'merge-hold' }],
      draft: false,
      head: { sha: 'b'.repeat(40) },
    });
    const result = await createRealMergePullRequest(octokit)(INPUT);
    expect(result.message).toBe(`head_moved:${'b'.repeat(40)}`);
    expect(merge).not.toHaveBeenCalled();
  });
});
