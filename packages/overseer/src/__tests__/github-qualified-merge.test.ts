import { describe, expect, mock, test } from 'bun:test';
import { createGitHubQualifiedMergeAdapter } from '../adapters/github-qualified-merge.ts';
import {
  createRealFindPullRequest,
  createRealMergePullRequest,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';
import type { QualifiedMergeAdapterRequestV2 } from '../actions/merge-ready.ts';

const request: QualifiedMergeAdapterRequestV2 = {
  schema_version: 'overseer-qualified-merge-adapter-request-v2',
  permit_id: 'permit-1',
  proposal_id: 'proposal-1',
  execution_id: 'execution-1',
  repository: 'thinmansoftware/bdc-harness',
  target_kind: 'pull_request',
  target_key: 'thinmansoftware/bdc-harness#pull_request:42',
  target_digest: '1'.repeat(64),
  pr_number: 42,
  head_sha: 'a'.repeat(40),
  base_branch: 'dev',
  base_sha: 'b'.repeat(40),
  snapshot_id: 'snapshot-1',
  action_kind: 'MERGE',
  policy_digest: '2'.repeat(64),
  verifier_registry_digest: '3'.repeat(64),
  fusion_receipt_digest: '4'.repeat(64),
  fusion_evidence_digest: '5'.repeat(64),
  permit_event_digest: '6'.repeat(64),
  reservation_event_digest: '7'.repeat(64),
};

describe('GitHub qualified merge adapter', () => {
  test('dispatches pulls.merge with the exact qualified head SHA', async () => {
    const merge = mock(async () => ({ data: { merged: true, sha: request.head_sha } }));
    const result = await createGitHubQualifiedMergeAdapter({ pulls: { merge } }).attemptMerge(
      request
    );
    expect(merge).toHaveBeenCalledWith({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      pull_number: 42,
      sha: request.head_sha,
    });
    expect(result.status).toBe('succeeded');
  });

  test('treats 409 and 422 as definitive no-effect failures', async () => {
    for (const status of [409, 422]) {
      const adapter = createGitHubQualifiedMergeAdapter({
        pulls: { merge: async () => Promise.reject({ status }) },
      });
      await expect(adapter.attemptMerge(request)).resolves.toMatchObject({
        status: 'failed',
        reason: `github_merge_rejected_${status}`,
      });
    }
  });

  test('treats transport failure after dispatch as indeterminate', async () => {
    const adapter = createGitHubQualifiedMergeAdapter({
      pulls: { merge: async () => Promise.reject(new Error('socket closed')) },
    });
    await expect(adapter.attemptMerge(request)).resolves.toMatchObject({
      status: 'indeterminate',
      reason: 'github_merge_transport_ambiguous',
    });
  });
});

function createOctokitMock(overrides: Partial<RealGitHubOctokitLike> = {}): RealGitHubOctokitLike {
  return {
    pulls: {
      list: async () => ({ data: [] }),
      get: async () => ({
        data: {
          number: 42,
          title: 'WO-42 real merge',
          state: 'open',
          mergeable: true,
          html_url: 'https://github.test/pull/42',
          changed_files: 3,
          head: { sha: 'a'.repeat(40) },
        },
      }),
      merge: async () => ({ data: { merged: true, sha: 'a'.repeat(40) } }),
      ...overrides.pulls,
    },
    search: {
      issuesAndPullRequests: async () => ({ data: { items: [] } }),
      ...overrides.search,
    },
    checks: {
      listForRef: async () => ({ data: { check_runs: [] } }),
      ...overrides.checks,
    },
  };
}

describe('real GitHub deps', () => {
  test('finds a pull request by head branch and summarizes check runs', async () => {
    const list = mock(async () => ({
      data: [
        {
          number: 42,
          title: 'WO-42 real merge',
          state: 'open',
          html_url: 'https://github.test/pull/42',
          head: { sha: 'a'.repeat(40) },
        },
      ],
    }));
    const search = mock(async () => ({ data: { items: [] } }));
    const octokit = createOctokitMock({
      pulls: { ...createOctokitMock().pulls, list },
      search: { issuesAndPullRequests: search },
      checks: {
        listForRef: async () => ({
          data: {
            check_runs: [
              { status: 'completed', conclusion: 'success' },
              { status: 'completed', conclusion: 'neutral' },
              { status: 'completed', conclusion: 'failure' },
              { status: 'in_progress', conclusion: null },
            ],
          },
        }),
      },
    });

    const result = await createRealFindPullRequest(octokit)({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      headBranch: 'fix/wo-42',
      woId: 'WO-42',
    });

    expect(list).toHaveBeenCalledWith({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      head: 'thinmansoftware:fix/wo-42',
      state: 'all',
      per_page: 5,
    });
    expect(search).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      exists: true,
      state: 'open',
      checks: { total: 4, passed: 2, failed: 1, pending: 1 },
      pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 42 },
    });
  });

  test('falls back to WO-ID search when the head branch has no pull request', async () => {
    const search = mock(async () => ({
      data: { items: [{ number: 77, pull_request: {} }] },
    }));
    const get = mock(async () => ({
      data: {
        number: 77,
        title: 'WO-FALLBACK-77',
        state: 'open',
        mergeable: true,
        html_url: 'https://github.test/pull/77',
        changed_files: 1,
        head: { sha: 'b'.repeat(40) },
      },
    }));
    const octokit = createOctokitMock({
      pulls: { ...createOctokitMock().pulls, get },
      search: { issuesAndPullRequests: search },
    });

    const result = await createRealFindPullRequest(octokit)({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      headBranch: 'fix/missing-head',
      woId: 'WO-FALLBACK-77',
    });

    expect(search).toHaveBeenCalledWith({
      q: 'repo:thinmansoftware/bdc-harness is:pr "WO-FALLBACK-77"',
      per_page: 5,
    });
    expect(get).toHaveBeenCalledWith({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      pull_number: 77,
    });
    expect(result.pr?.number).toBe(77);
  });

  test('returns missing evidence when no pull request matches', async () => {
    const result = await createRealFindPullRequest(createOctokitMock())({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      headBranch: 'fix/not-found',
      woId: 'WO-NOT-FOUND',
    });

    expect(result).toEqual({
      exists: false,
      state: 'missing',
      checks: { total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: null,
      lookupFailed: false,
    });
  });

  // A genuine "this PR does not exist" and "the lookup itself broke" used to collapse
  // into the same MISSING_EVIDENCE shape, so the watcher reported "no PR" for API
  // failures too. Both still keep the merge door shut (exists: false); they must be
  // distinguishable in the evidence so the reason string can tell the truth.
  test('distinguishes a failed lookup from a genuine missing pull request', async () => {
    const octokit = createOctokitMock({
      pulls: {
        ...createOctokitMock().pulls,
        list: async () => {
          throw new Error('secondary rate limit');
        },
      },
    });

    const result = await createRealFindPullRequest(octokit)({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      headBranch: 'fix/api-down',
      woId: 'WO-API-DOWN',
    });

    expect(result.exists).toBe(false);
    expect(result.lookupFailed).toBe(true);
    expect(result.state).toBe('lookup_failed');
  });

  test('merges with the current pull request head SHA', async () => {
    const merge = mock(async () => ({ data: { merged: true, sha: 'a'.repeat(40) } }));
    const result = await createRealMergePullRequest(
      createOctokitMock({ pulls: { ...createOctokitMock().pulls, merge } })
    )({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      number: 42,
      commitTitle: 'Overseer merge WO-42',
    });

    expect(merge).toHaveBeenCalledWith({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      pull_number: 42,
      sha: 'a'.repeat(40),
      merge_method: 'squash',
    });
    expect(result).toEqual({
      merged: true,
      message: 'Overseer merge WO-42',
      sha: 'a'.repeat(40),
    });
  });

  test('maps 409 and 422 merge rejections', async () => {
    for (const status of [409, 422]) {
      const octokit = createOctokitMock({
        pulls: {
          ...createOctokitMock().pulls,
          merge: async () => Promise.reject({ status }),
        },
      });
      await expect(
        createRealMergePullRequest(octokit)({
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          number: 42,
        })
      ).resolves.toEqual({ merged: false, message: `github_merge_rejected_${status}` });
    }
  });

  test('maps other merge errors as transport ambiguous', async () => {
    const octokit = createOctokitMock({
      pulls: {
        ...createOctokitMock().pulls,
        merge: async () => Promise.reject(new Error('socket closed')),
      },
    });
    await expect(
      createRealMergePullRequest(octokit)({
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        number: 42,
      })
    ).resolves.toEqual({
      merged: false,
      message: 'github_merge_transport_ambiguous',
    });
  });
});
