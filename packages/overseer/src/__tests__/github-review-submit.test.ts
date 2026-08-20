/**
 * WO-HARNESS-OVERSEER-REVIEW-ROUTE-01 -- widened review capability.
 *
 * XO decision 1 (2026-08-17): add a general submitPullRequestReview supporting
 * APPROVE and REQUEST_CHANGES, require a non-empty evidence body for
 * REQUEST_CHANGES, and RETAIN approvePullRequest as a compatibility wrapper so
 * the WO-HARNESS-OVERSEER-APP-AUTH-01 contract and its tests remain valid.
 *
 * Network-free: a structurally-typed fake Octokit, never a real client.
 */
import { describe, expect, test } from 'bun:test';
import {
  createRealApprovePullRequest,
  createRealSubmitPullRequestReview,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';

const HEAD_SHA = 'a'.repeat(40);
const REF = { owner: 'thinmansoftware', repo: 'bdc-harness', number: 673, commitId: HEAD_SHA };

function fakeOctokit(
  createReview: NonNullable<RealGitHubOctokitLike['pulls']['createReview']>
): RealGitHubOctokitLike {
  return {
    pulls: {
      createReview,
      // The compatibility wrapper (createRealApprovePullRequest) fetches the
      // live head via pulls.get before approving, since PullRequestRef alone
      // carries no head SHA and commit_id is now required.
      get: async () => ({ data: { head: { sha: HEAD_SHA } } }),
    },
  } as unknown as RealGitHubOctokitLike;
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

describe('createRealSubmitPullRequestReview', () => {
  test('submits APPROVE and reports success', async () => {
    const calls: unknown[] = [];
    const submit = createRealSubmitPullRequestReview(
      fakeOctokit(async input => {
        calls.push(input);
        return { data: { id: 1, state: 'APPROVED' } };
      })
    );
    expect(await submit({ ...REF, event: 'APPROVE' })).toEqual({ submitted: true });
    expect(calls[0]).toMatchObject({ event: 'APPROVE', pull_number: 673, commit_id: HEAD_SHA });
  });

  test('submits REQUEST_CHANGES with the evidence body', async () => {
    const calls: { event?: string; body?: string }[] = [];
    const submit = createRealSubmitPullRequestReview(
      fakeOctokit(async input => {
        calls.push(input as { event?: string; body?: string });
        return { data: { id: 2, state: 'CHANGES_REQUESTED' } };
      })
    );
    const result = await submit({
      ...REF,
      event: 'REQUEST_CHANGES',
      body: 'Stop condition 3 fails.',
    });
    expect(result).toEqual({ submitted: true });
    expect(calls[0]?.event).toBe('REQUEST_CHANGES');
    expect(calls[0]?.body).toBe('Stop condition 3 fails.');
    expect((calls[0] as unknown as { commit_id?: string })?.commit_id).toBe(HEAD_SHA);
  });

  test('a review always binds to the exact head evaluated, not the live head', async () => {
    const calls: { commit_id?: string }[] = [];
    const submit = createRealSubmitPullRequestReview(
      fakeOctokit(async input => {
        calls.push(input as { commit_id?: string });
        return { data: { id: 99, state: 'APPROVED' } };
      })
    );
    const OTHER_HEAD = 'b'.repeat(40);
    await submit({ ...REF, event: 'APPROVE', commitId: OTHER_HEAD });
    expect(calls[0]?.commit_id).toBe(OTHER_HEAD);
    expect(calls[0]?.commit_id).not.toBe(HEAD_SHA);
  });

  test('refuses REQUEST_CHANGES with an empty body BEFORE calling GitHub', async () => {
    let called = false;
    const submit = createRealSubmitPullRequestReview(
      fakeOctokit(async () => {
        called = true;
        return { data: { id: 3, state: 'CHANGES_REQUESTED' } };
      })
    );
    const result = await submit({ ...REF, event: 'REQUEST_CHANGES', body: '   ' });
    expect(result).toEqual({
      submitted: false,
      message: 'github_review_missing_evidence_body',
    });
    expect(called).toBe(false);
  });

  test('APPROVE does not require a body', async () => {
    const submit = createRealSubmitPullRequestReview(
      fakeOctokit(async () => ({ data: { id: 4, state: 'APPROVED' } }))
    );
    expect(await submit({ ...REF, event: 'APPROVE' })).toEqual({ submitted: true });
  });

  test('an unexpected returned state is reported, not assumed successful', async () => {
    const submit = createRealSubmitPullRequestReview(
      fakeOctokit(async () => ({ data: { id: 5, state: 'PENDING' } }))
    );
    expect(await submit({ ...REF, event: 'APPROVE' })).toEqual({
      submitted: false,
      message: 'github_review_unexpected_state_PENDING',
    });
  });

  test('self-approval 422 maps to the stable custody code', async () => {
    const submit = createRealSubmitPullRequestReview(
      fakeOctokit(async () => {
        throw httpError(422, 'Can not approve your own pull request');
      })
    );
    expect(await submit({ ...REF, event: 'APPROVE' })).toEqual({
      submitted: false,
      message: 'github_review_self_approval_rejected',
    });
  });

  test('other 422s map to unprocessable', async () => {
    const submit = createRealSubmitPullRequestReview(
      fakeOctokit(async () => {
        throw httpError(422, 'Validation failed');
      })
    );
    expect(await submit({ ...REF, event: 'APPROVE' })).toEqual({
      submitted: false,
      message: 'github_review_unprocessable',
    });
  });

  test('transport errors map to ambiguous rather than a false negative', async () => {
    const submit = createRealSubmitPullRequestReview(
      fakeOctokit(async () => {
        throw httpError(503, 'upstream unavailable');
      })
    );
    expect(await submit({ ...REF, event: 'APPROVE' })).toEqual({
      submitted: false,
      message: 'github_review_transport_ambiguous',
    });
  });

  test('throws loudly when the review API is absent', async () => {
    const submit = createRealSubmitPullRequestReview({
      pulls: {},
    } as unknown as RealGitHubOctokitLike);
    await expect(submit({ ...REF, event: 'APPROVE' })).rejects.toThrow(
      'overseer_real_adapter_missing_review_api'
    );
  });
});

describe('createRealApprovePullRequest compatibility wrapper', () => {
  test('still returns the original { approved: true } shape', async () => {
    const approve = createRealApprovePullRequest(
      fakeOctokit(async () => ({ data: { id: 6, state: 'APPROVED' } }))
    );
    expect(await approve(REF)).toEqual({ approved: true });
  });

  test('still returns the original self-approval code', async () => {
    const approve = createRealApprovePullRequest(
      fakeOctokit(async () => {
        throw httpError(422, 'Can not approve your own pull request');
      })
    );
    expect(await approve(REF)).toEqual({
      approved: false,
      message: 'github_review_self_approval_rejected',
    });
  });

  test('only ever sends APPROVE', async () => {
    const events: string[] = [];
    const approve = createRealApprovePullRequest(
      fakeOctokit(async input => {
        events.push(input.event);
        return { data: { id: 7, state: 'APPROVED' } };
      })
    );
    await approve(REF);
    expect(events).toEqual(['APPROVE']);
  });
});
