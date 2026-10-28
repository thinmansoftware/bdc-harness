import { describe, expect, test } from 'bun:test';
import { createRealSubmitPullRequestReview } from '../adapters/github-real-deps';

describe('sandbox approval response qualification', () => {
  test('retains the actual GitHub review identity', async () => {
    const submit = createRealSubmitPullRequestReview({
      pulls: {
        createReview: async () => ({
          data: {
            id: 42,
            html_url: 'https://github.test/review/42',
            commit_id: 'a'.repeat(40),
            state: 'APPROVED',
          },
        }),
      },
    } as never);
    const result = await submit({
      owner: 'o',
      repo: 'r',
      number: 1,
      event: 'APPROVE',
      commitId: 'a'.repeat(40),
    });
    expect(result.review).toEqual({
      id: 42,
      url: 'https://github.test/review/42',
      commitSha: 'a'.repeat(40),
      state: 'APPROVED',
    });
  });
  test('does not fabricate identity when GitHub omits it', async () => {
    const submit = createRealSubmitPullRequestReview({
      pulls: { createReview: async () => ({ data: { state: 'APPROVED' } }) },
    } as never);
    expect(
      (
        await submit({
          owner: 'o',
          repo: 'r',
          number: 1,
          event: 'APPROVE',
          commitId: 'a'.repeat(40),
        })
      ).review
    ).toBeUndefined();
  });
});
