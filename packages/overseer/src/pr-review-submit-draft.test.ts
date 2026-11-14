/**
 * WO-HARNESS-MERGE-GATES-01 Amendment 1, Test 11: review_submit_refuses_a_draft_at_submit_time.
 *
 * comicstoreos-provisioner PR 112 (2026-11-13): a review queued while the PR was open was executed
 * about 2.5 minutes later and APPROVED the PR while it was a draft. The only draft check on the review
 * path was at ingest, on the webhook payload. runAndSubmitReview now re-reads the draft state after
 * both head gates and before any submit.
 */
import { describe, expect, test } from 'bun:test';
import { runAndSubmitReview, type ReviewWorkItem, type SubmitDeps } from './pr-review-submit.ts';
import { createRealSubmitDeps } from './pr-review-wiring.ts';
import type { RealGitHubOctokitLike } from './adapters/github-real-deps.ts';

const REVIEWER = 'thinman-overseer[bot]';
const HEAD = 'b93d4334df25f73d82c791f10f13429ec5b6beca';

const WORK: ReviewWorkItem = {
  correlationId: `pr-review:thinmansoftware/comicstoreos-provisioner#112@${HEAD}`,
  messageId: 'msg-112',
  owner: 'thinmansoftware',
  repo: 'comicstoreos-provisioner',
  prNumber: 112,
  headSha: HEAD,
  author: 'bluedevilcollectibles',
};

function makeDeps(isDraft: SubmitDeps['isDraft']) {
  const submitted: Parameters<SubmitDeps['submitReview']>[0][] = [];
  const receipts: Parameters<SubmitDeps['recordReceipt']>[0][] = [];
  const deps: SubmitDeps = {
    reviewerIdentity: REVIEWER,
    runReviewer: async () => ({
      approved: true,
      summary: 'Both required checks passed.',
      reviewedHeadSha: HEAD,
    }),
    submitReview: async input => {
      submitted.push(input);
      return { submitted: true };
    },
    currentHeadSha: async () => HEAD,
    isDraft,
    recordReceipt: async input => {
      receipts.push(input);
    },
  };
  return { deps, submitted, receipts };
}

describe('Test 11: review_submit_refuses_a_draft_at_submit_time', () => {
  test('a PR that is a draft at submit time gets NO review; the disposition is pr_is_draft', async () => {
    // Queued while open; drafted before submit.
    const { deps, submitted, receipts } = makeDeps(async () => true);
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(submitted).toHaveLength(0);
    expect(outcome.disposition).toBe('pr_is_draft');
    expect(outcome.reason).toBe('pr_is_draft_at_submit');
    expect(receipts[0]?.disposition).toBe('pr_is_draft');
  });

  test('a PR that is not a draft gets exactly one APPROVE, as before', async () => {
    const { deps, submitted } = makeDeps(async () => false);
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('approved');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.event).toBe('APPROVE');
    expect(submitted[0]?.commitId).toBe(HEAD);
  });

  test('a failed draft read submits nothing and is a non-terminal deferral', async () => {
    const { deps, submitted } = makeDeps(async () => {
      throw new Error('socket hang up');
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(submitted).toHaveLength(0);
    expect(outcome.disposition).toBe('pr_is_draft');
    expect(outcome.reason).toStartWith('draft_recheck_failed:');
  });

  test('the real wiring provides isDraft, reads pulls.get, and fails closed on a missing draft field', async () => {
    let draftField: unknown = true;
    const octokit = {
      pulls: {
        get: async () => ({
          data: {
            number: 112,
            head: { sha: HEAD },
            ...(draftField === undefined ? {} : { draft: draftField }),
          },
        }),
      },
    } as unknown as RealGitHubOctokitLike;
    const wired = createRealSubmitDeps(REVIEWER, { octokit, patOctokit: null });
    expect(typeof wired.isDraft).toBe('function');
    const ref = { owner: WORK.owner, repo: WORK.repo, prNumber: WORK.prNumber };
    expect(await wired.isDraft?.(ref)).toBe(true);
    draftField = false;
    expect(await wired.isDraft?.(ref)).toBe(false);
    draftField = undefined;
    await expect(wired.isDraft?.(ref)).rejects.toThrow('pr_draft_unknown');
  });
});
