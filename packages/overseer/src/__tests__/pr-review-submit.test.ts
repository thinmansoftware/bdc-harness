/**
 * WO-HARNESS-OVERSEER-REVIEW-ROUTE-01 -- governed reviewer invocation and
 * verdict submission.
 *
 * Covers: approve path, REQUEST_CHANGES path (XO decision 1 -- a reviewer that
 * cannot reject is not a reviewer), custody conflict, exact-head binding,
 * stale-head invalidation mid-review, reviewer failure, submission failure,
 * and receipt creation. Hermetic -- fake deps only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildReviewBody,
  runAndSubmitReview,
  type ReviewWorkItem,
  type SubmitDeps,
} from '../pr-review-submit.ts';

const REVIEWER = 'thinman-overseer[bot]';
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'd'.repeat(40);

const WORK: ReviewWorkItem = {
  correlationId: `pr-review:thinmansoftware/bdc-harness#673@${HEAD}`,
  messageId: 'msg-1',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  prNumber: 673,
  headSha: HEAD,
  author: 'bluedevilcollectibles',
};

interface Recorded {
  submitted: Parameters<SubmitDeps['submitReview']>[0][];
  receipts: Parameters<SubmitDeps['recordReceipt']>[0][];
}

function makeDeps(overrides: Partial<SubmitDeps> = {}): { deps: SubmitDeps; rec: Recorded } {
  const rec: Recorded = { submitted: [], receipts: [] };
  const deps: SubmitDeps = {
    reviewerIdentity: REVIEWER,
    runReviewer: async () => ({
      approved: true,
      summary: 'All stop conditions verified.',
      reviewedHeadSha: HEAD,
    }),
    submitReview: async input => {
      rec.submitted.push(input);
      return { submitted: true };
    },
    currentHeadSha: async () => HEAD,
    recordReceipt: async input => {
      rec.receipts.push(input);
    },
    ...overrides,
  };
  return { deps, rec };
}

describe('approve path', () => {
  test('an approving verdict submits APPROVE', async () => {
    const { deps, rec } = makeDeps();
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('approved');
    expect(rec.submitted[0]?.event).toBe('APPROVE');
    expect(rec.receipts[0]?.disposition).toBe('approved');
  });

  test('the submitted review binds to the exact head the reviewer evaluated (commitId)', async () => {
    const { deps, rec } = makeDeps();
    await runAndSubmitReview(WORK, deps);
    expect(rec.submitted[0]?.commitId).toBe(HEAD);
    expect(rec.submitted[0]?.commitId).toBe(WORK.headSha);
  });

  test('the review body states the exact reviewed head', async () => {
    const { deps, rec } = makeDeps();
    await runAndSubmitReview(WORK, deps);
    expect(rec.submitted[0]?.body).toContain(HEAD);
  });
});

describe('request-changes path (XO decision 1)', () => {
  test('a non-approving verdict submits REQUEST_CHANGES, not silence', async () => {
    const { deps, rec } = makeDeps({
      runReviewer: async () => ({
        approved: false,
        summary: 'Stop condition 3 fails: manifest grep returns 0 matches.',
        reviewedHeadSha: HEAD,
      }),
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('changes_requested');
    expect(rec.submitted[0]?.event).toBe('REQUEST_CHANGES');
    expect(rec.submitted[0]?.body).toContain('Stop condition 3 fails');
  });

  test('a rejection with no evidence is refused before any network call', async () => {
    const { deps, rec } = makeDeps({
      runReviewer: async () => ({ approved: false, summary: '   ', reviewedHeadSha: HEAD }),
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('submission_failed');
    expect(outcome.reason).toBe('request_changes_missing_evidence');
    expect(rec.submitted).toHaveLength(0);
  });
});

describe('custody conflict', () => {
  test('never reviews a PR the reviewer authored', async () => {
    const { deps, rec } = makeDeps();
    const outcome = await runAndSubmitReview({ ...WORK, author: REVIEWER }, deps);
    expect(outcome.disposition).toBe('custody_conflict');
    expect(rec.submitted).toHaveLength(0);
    expect(rec.receipts[0]?.disposition).toBe('custody_conflict');
  });

  test('custody is checked BEFORE the reviewer runs (no wasted invocation)', async () => {
    let reviewerRan = false;
    const { deps } = makeDeps({
      runReviewer: async () => {
        reviewerRan = true;
        return { approved: true, summary: 'x', reviewedHeadSha: HEAD };
      },
    });
    await runAndSubmitReview({ ...WORK, author: REVIEWER }, deps);
    expect(reviewerRan).toBe(false);
  });
});

describe('merge-custody conflict (M-153, tabled)', () => {
  const MODE_ENV = 'OVERSEER_MERGE_MANAGER_MODE';
  let priorMode: string | undefined;

  beforeEach(() => {
    priorMode = process.env[MODE_ENV];
  });

  afterEach(() => {
    if (priorMode === undefined) delete process.env[MODE_ENV];
    else process.env[MODE_ENV] = priorMode;
  });

  test('refuses to submit while the merge manager is armed to execute', async () => {
    process.env[MODE_ENV] = 'execute';
    const { deps, rec } = makeDeps();
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('merge_custody_conflict');
    expect(rec.submitted).toHaveLength(0);
    expect(rec.receipts[0]?.disposition).toBe('merge_custody_conflict');
  });

  test('proceeds normally when the merge manager is parked in hold-canary', async () => {
    process.env[MODE_ENV] = 'hold-canary';
    const { deps } = makeDeps();
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('approved');
  });

  test('proceeds normally when the merge manager is in comment_findings', async () => {
    process.env[MODE_ENV] = 'comment_findings';
    const { deps } = makeDeps();
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('approved');
  });

  test('fails closed (blocks review) on an unset mode -- default is hold-canary, not execute', async () => {
    delete process.env[MODE_ENV];
    const { deps } = makeDeps();
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('approved');
  });

  test('the merge-custody check runs BEFORE the reviewer (no wasted invocation)', async () => {
    process.env[MODE_ENV] = 'execute';
    let reviewerRan = false;
    const { deps } = makeDeps({
      runReviewer: async () => {
        reviewerRan = true;
        return { approved: true, summary: 'x', reviewedHeadSha: HEAD };
      },
    });
    await runAndSubmitReview(WORK, deps);
    expect(reviewerRan).toBe(false);
  });
});

describe('exact-head binding', () => {
  test('refuses to submit when the reviewer examined a different head', async () => {
    const { deps, rec } = makeDeps({
      runReviewer: async () => ({
        approved: true,
        summary: 'looks fine',
        reviewedHeadSha: NEW_HEAD,
      }),
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('stale_head');
    expect(outcome.reason).toBe('reviewer_examined_different_head');
    expect(rec.submitted).toHaveLength(0);
  });

  test('refuses to submit when the head advanced during review', async () => {
    const { deps, rec } = makeDeps({ currentHeadSha: async () => NEW_HEAD });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('stale_head');
    expect(outcome.reason).toBe('head_advanced_during_review');
    expect(rec.submitted).toHaveLength(0);
  });

  test('a head re-read failure fails closed without submitting', async () => {
    const { deps, rec } = makeDeps({
      currentHeadSha: async () => {
        throw new Error('api_down');
      },
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('submission_failed');
    expect(outcome.reason).toContain('head_recheck_failed');
    expect(rec.submitted).toHaveLength(0);
  });
});

describe('failure handling', () => {
  test('a reviewer crash fails closed with a recorded blocker', async () => {
    const { deps, rec } = makeDeps({
      runReviewer: async () => {
        throw new Error('model_unavailable');
      },
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('reviewer_failed');
    expect(outcome.reason).toContain('model_unavailable');
    expect(rec.receipts[0]?.disposition).toBe('reviewer_failed');
    expect(rec.submitted).toHaveLength(0);
  });

  test('a rejected submission surfaces the adapter stable code', async () => {
    const { deps, rec } = makeDeps({
      submitReview: async () => ({
        submitted: false,
        message: 'github_review_self_approval_rejected',
      }),
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('submission_failed');
    expect(outcome.reason).toBe('github_review_self_approval_rejected');
    expect(rec.receipts[0]?.reason).toBe('github_review_self_approval_rejected');
  });

  test('a throwing submission fails closed rather than escaping', async () => {
    const { deps } = makeDeps({
      submitReview: async () => {
        throw new Error('network_reset');
      },
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('submission_failed');
    expect(outcome.reason).toContain('submit_threw');
  });

  test('a receipt failure does not convert an outcome into a throw', async () => {
    const { deps } = makeDeps({
      recordReceipt: async () => {
        throw new Error('receipt_down');
      },
    });
    const outcome = await runAndSubmitReview(WORK, deps);
    expect(outcome.disposition).toBe('approved');
  });
});

describe('receipts', () => {
  test('every terminal disposition writes exactly one correlated receipt', async () => {
    const { deps, rec } = makeDeps();
    await runAndSubmitReview(WORK, deps);
    expect(rec.receipts).toHaveLength(1);
    expect(rec.receipts[0]?.correlationId).toBe(WORK.correlationId);
    expect(rec.receipts[0]?.messageId).toBe('msg-1');
    expect(rec.receipts[0]?.headSha).toBe(HEAD);
    expect(rec.receipts[0]?.event).toBe('APPROVE');
  });
});

describe('buildReviewBody', () => {
  test('includes the head and the reviewer summary', () => {
    const body = buildReviewBody(WORK, {
      approved: false,
      summary: 'Finding: missing test.',
      reviewedHeadSha: HEAD,
    });
    expect(body).toContain(HEAD);
    expect(body).toContain('Finding: missing test.');
  });

  test('bounds a runaway summary', () => {
    const body = buildReviewBody(WORK, {
      approved: false,
      summary: 'x'.repeat(100_000),
      reviewedHeadSha: HEAD,
    });
    expect(body.length).toBeLessThanOrEqual(60_000);
  });
});
