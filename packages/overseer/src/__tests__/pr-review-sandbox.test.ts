import { describe, expect, test } from 'bun:test';
import {
  runAndSubmitReview,
  type ReviewExecutionProof,
  type ReviewWorkItem,
  type SubmitDeps,
} from '../pr-review-submit';

const head = 'a'.repeat(40);
const context = {
  requestId: 'request-1',
  workerId: 'worker-1',
  fencingToken: 7,
  owner: 'o',
  repo: 'r',
  prNumber: 1,
  headSha: head,
  checkoutPath: '/tmp/checkout',
  reviewerIdentity: 'bot',
  rung: 'pr-review',
  checkPlan: [['bun', 'test']] as const,
};
const proof: ReviewExecutionProof = {
  requestId: 'request-1',
  headSha: head,
  treeSha: 'b'.repeat(40),
  cwd: '/tmp/checkout',
  nativePolicy: 'codex_legacy_landlock',
  nativeVersion: '0.153.3',
  runtimeUid: 1001,
  inspectionObserved: true,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:01.000Z',
  checks: [
    {
      argv: ['bun', 'test'],
      cwd: '/tmp/checkout',
      exitCode: 0,
      outputDigest: 'sha256:ok',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
    },
  ],
};
const work: ReviewWorkItem = {
  correlationId: 'c',
  messageId: 'request-1',
  owner: 'o',
  repo: 'r',
  prNumber: 1,
  headSha: head,
  author: 'author',
  executionContext: context,
};

function deps(executionProof?: ReviewExecutionProof): {
  value: SubmitDeps;
  posts: string[];
  receipts: string[];
} {
  const posts: string[] = [];
  const receipts: string[] = [];
  return {
    posts,
    receipts,
    value: {
      reviewerIdentity: 'bot',
      runReviewer: async () => ({
        approved: true,
        summary: 'ok',
        reviewedHeadSha: head,
        executionProof,
      }),
      currentHeadSha: async () => head,
      hasCustody: async () => true,
      recordExecutionProof: async ({ proof }) => {
        receipts.push(`proof:${proof.requestId}`);
      },
      submitReview: async input => {
        posts.push(input.event);
        return input.event === 'APPROVE'
          ? {
              submitted: true,
              review: {
                id: 9,
                url: 'https://example.invalid/9',
                commitSha: head,
                state: 'APPROVED',
              },
            }
          : { submitted: true };
      },
      recordReceipt: async input => {
        receipts.push(input.disposition);
      },
    },
  };
}

describe('sandbox-qualified submit', () => {
  test('durable exact-head proof permits one approval with response identity', async () => {
    const d = deps(proof);
    const result = await runAndSubmitReview(work, d.value);
    expect(result.disposition).toBe('approved');
    expect(d.posts).toEqual(['APPROVE']);
    expect(result.githubReview?.id).toBe(9);
    expect(d.receipts).toEqual(['proof:request-1', 'approved']);
  });
  test('model approval without supervisor proof becomes review_incomplete comment', async () => {
    const d = deps();
    const result = await runAndSubmitReview(work, d.value);
    expect(result.disposition).toBe('review_incomplete');
    expect(d.posts).toEqual(['COMMENT']);
    expect(result.summary?.startsWith('Review incomplete:')).toBe(true);
  });
});
