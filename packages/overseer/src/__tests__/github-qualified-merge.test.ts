import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'path';
import { closeDatabase, resetDatabase } from '@archon/core/db';
import { createAuthenticatedMessage } from '@archon/core/db/dispatch';
import { PR_REVIEW_LOG_RECIPIENT } from '@archon/core/db/dispatch-routing';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { createGitHubQualifiedMergeAdapter } from '../adapters/github-qualified-merge.ts';
import { REVIEW_SENDER, reviewSubjectKey } from '../pr-review-wiring.ts';
import {
  createRealGitHubClientDeps,
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
            // findPullRequest now keeps only the latest attempt per check name
            // and app, so each run carries its own name and id, as GitHub's do.
            // A stale earlier attempt of "lint" must not count.
            check_runs: [
              { id: 1, name: 'lint', status: 'completed', conclusion: 'failure' },
              { id: 2, name: 'build', status: 'completed', conclusion: 'success' },
              { id: 3, name: 'docs', status: 'completed', conclusion: 'neutral' },
              { id: 4, name: 'unit', status: 'completed', conclusion: 'failure' },
              { id: 5, name: 'e2e', status: 'in_progress', conclusion: null },
              { id: 6, name: 'lint', status: 'completed', conclusion: 'success' },
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
    expect(list).toHaveBeenCalledWith({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      state: 'open',
      per_page: 100,
      page: 1,
      sort: 'created',
      direction: 'asc',
    });
    expect(result).toMatchObject({
      exists: true,
      state: 'open',
      checks: { total: 5, passed: 3, failed: 1, pending: 1 },
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
        body: null,
        state: 'open',
        mergeable: true,
        html_url: 'https://github.test/pull/77',
        changed_files: 1,
        head: { sha: 'b'.repeat(40), ref: 'fix/fallback' },
      },
    }));
    const octokit = createOctokitMock({
      pulls: {
        ...createOctokitMock().pulls,
        get,
        list: async request => ({ data: request.head ? [] : [(await get()).data] }),
      },
      search: { issuesAndPullRequests: search },
    });

    const result = await createRealFindPullRequest(octokit)({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      headBranch: 'fix/missing-head',
      woId: 'WO-FALLBACK-77',
    });

    expect(search).not.toHaveBeenCalled();
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

  test('merges with the expected head SHA, not a substituted refetch', async () => {
    const merge = mock(async () => ({ data: { merged: true, sha: 'a'.repeat(40) } }));
    const result = await createRealMergePullRequest(
      createOctokitMock({ pulls: { ...createOctokitMock().pulls, merge } })
    )({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      number: 42,
      commitTitle: 'Overseer merge WO-42',
      expectedHeadSha: 'a'.repeat(40),
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
      mergeSha: 'a'.repeat(40),
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
          expectedHeadSha: 'a'.repeat(40),
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
        expectedHeadSha: 'a'.repeat(40),
      })
    ).resolves.toEqual({
      merged: false,
      message: 'github_merge_transport_ambiguous',
    });
  });

  test('does not merge when the refetched head differs from expectedHeadSha', async () => {
    const live = 'c'.repeat(40);
    const merge = mock(async () => ({ data: { merged: true, sha: live } }));
    const octokit = createOctokitMock({
      pulls: {
        ...createOctokitMock().pulls,
        get: async () => ({
          data: {
            number: 42,
            title: 'WO-42 real merge',
            state: 'open',
            mergeable: true,
            html_url: 'https://github.test/pull/42',
            changed_files: 3,
            head: { sha: live },
          },
        }),
        merge,
      },
    });
    await expect(
      createRealMergePullRequest(octokit)({
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        number: 42,
        expectedHeadSha: 'a'.repeat(40),
      })
    ).resolves.toEqual({ merged: false, message: `head_moved:${live}` });
    expect(merge).not.toHaveBeenCalled();
  });

  test('maps 405 merge precondition rejection to the API message', async () => {
    const octokit = createOctokitMock({
      pulls: {
        ...createOctokitMock().pulls,
        merge: async () =>
          Promise.reject(
            Object.assign(new Error('Pull Request is not mergeable'), { status: 405 })
          ),
      },
    });
    await expect(
      createRealMergePullRequest(octokit)({
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        number: 42,
        expectedHeadSha: 'a'.repeat(40),
      })
    ).resolves.toEqual({
      merged: false,
      message: 'Pull Request is not mergeable',
    });
  });
});

/**
 * WO-HARNESS-MERGE-MANAGER-POST-REBUILD-STALL-01: the merge gate must read
 * receipts where the submit path writes them. #1390 moved receipts to
 * PR_REVIEW_LOG_RECIPIENT while hasQualifiedReview still read only `operator`,
 * so every PR was review_execution_unqualified and nothing merged.
 */
describe('hasQualifiedReview reads receipts where the submit path writes them', () => {
  const owner = 'thinmansoftware';
  const repo = 'bdc-xo';
  const number = 4269;
  const head = 'c'.repeat(40);
  let home = '';
  const oldHome = process.env.ARCHON_HOME;
  const oldUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(
      import.meta.dir,
      `.test-qualified-receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    if (oldHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = oldHome;
    if (oldUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldUrl;
    removeTempDirWithRetry(home);
  });

  /** Same call shape as the submit-receipt writer in pr-review-wiring.ts. */
  async function writeReceipt(
    recipient: string,
    id: string,
    overrides: { disposition?: string; headSha?: string; proof?: unknown } = {}
  ): Promise<void> {
    const headSha = overrides.headSha ?? head;
    await createAuthenticatedMessage(
      { kind: 'system', sender: REVIEW_SENDER },
      {
        correlation_id: `pr-review:${owner}/${repo}#${number}@${headSha}`,
        idempotency_key: `pr-review-submit-receipt:${id}:${overrides.disposition ?? 'approved'}`,
        task_type: 'run_report',
        recipient,
        subject_key: reviewSubjectKey(owner, repo, number),
        repeat_reason: `review_verdict_receipt:${id}`,
        body: JSON.stringify({
          kind: 'pr_review_submit_receipt',
          owner,
          repo,
          prNumber: number,
          headSha,
          disposition: overrides.disposition ?? 'approved',
          event: 'APPROVE',
          executionProof:
            overrides.proof === undefined
              ? {
                  headSha,
                  inspectionObserved: true,
                  check_plan: 'absent',
                  checks: [],
                  nativePolicy: 'codex_bubblewrap',
                  runtimeUid: 1002,
                }
              : overrides.proof,
          githubReview: { id: 5736844687, commitSha: headSha, state: 'APPROVED' },
        }),
      }
    );
  }

  const qualified = (headSha = head): Promise<boolean> =>
    createRealGitHubClientDeps({} as RealGitHubOctokitLike).hasQualifiedReview!({
      owner,
      repo,
      number,
      headSha,
    });

  test('an approved receipt in the review log qualifies', async () => {
    await writeReceipt(PR_REVIEW_LOG_RECIPIENT, 'log-approved');
    expect(await qualified()).toBe(true);
  });

  test('a pre-cut-off receipt at operator still qualifies', async () => {
    await writeReceipt('operator', 'legacy-approved');
    expect(await qualified()).toBe(true);
  });

  test('the submit writer and the merge gate use the same recipient constant', async () => {
    const writer = await Bun.file(join(import.meta.dir, '..', 'pr-review-wiring.ts')).text();
    const submit = writer.slice(writer.indexOf('pr-review-submit-receipt:'));
    expect(submit.slice(0, 400)).toContain('recipient: PR_REVIEW_LOG_RECIPIENT');
    const reader = await Bun.file(
      join(import.meta.dir, '..', 'adapters', 'github-real-deps.ts')
    ).text();
    const gate = reader.slice(reader.indexOf('hasQualifiedReview: async'));
    expect(gate.slice(0, 1200)).toContain('recipient: PR_REVIEW_LOG_RECIPIENT');
  });

  test('qualification still fails closed in the review log', async () => {
    await writeReceipt(PR_REVIEW_LOG_RECIPIENT, 'changes', { disposition: 'changes_requested' });
    await writeReceipt(PR_REVIEW_LOG_RECIPIENT, 'other-head', { headSha: 'd'.repeat(40) });
    await writeReceipt(PR_REVIEW_LOG_RECIPIENT, 'bad-proof', {
      proof: { headSha: head, inspectionObserved: false, check_plan: 'absent', checks: [] },
    });
    expect(await qualified()).toBe(false);
    expect(await qualified('e'.repeat(40))).toBe(false);
  });
});
