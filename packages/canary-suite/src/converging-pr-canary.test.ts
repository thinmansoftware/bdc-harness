import { describe, expect, test } from 'bun:test';
import type { PriorReviewWork } from '@archon/overseer/pr-review-ingest';
import { MAX_REREVIEW_ATTEMPTS_ENV } from '@archon/overseer/pr-review-ingest';
import { runConvergingPrCanary } from './converging-pr-canary';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);

function work(overrides: Partial<PriorReviewWork>): PriorReviewWork {
  return {
    messageId: 'review-1',
    headSha: HEAD_A,
    status: 'done',
    verdict: 'changes_requested',
    verdictId: 'verdict-1',
    isAutoRereview: false,
    headCiGreen: false,
    ...overrides,
  };
}

function convergingPrior(): PriorReviewWork[] {
  return [
    work({
      messageId: 'auto-2',
      headSha: HEAD_C,
      isAutoRereview: true,
      headCiGreen: true,
    }),
    work({
      messageId: 'auto-1',
      headSha: HEAD_B,
      isAutoRereview: true,
      headCiGreen: true,
    }),
    work({ messageId: 'initial', headSha: HEAD_A }),
  ];
}

const subject = {
  id: 'gh:thinmansoftware/bdc-harness#806',
  prior: convergingPrior(),
  currentHead: HEAD_C,
  currentHeadCiGreen: true,
};

describe('C1 converging-PR canary', () => {
  test('GREEN: a converging PR stays under the default consecutive budget', async () => {
    const result = await runConvergingPrCanary({ subjects: [subject], env: {} });
    expect(result.verdict).toBe('passed');
    expect(result.reasonCodes).toEqual([]);
  });

  test('RED: OVERSEER_MAX_REREVIEW_ATTEMPTS=1 exhausts a converging PR', async () => {
    const result = await runConvergingPrCanary({
      subjects: [subject],
      env: { [MAX_REREVIEW_ATTEMPTS_ENV]: '1' },
    });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes).toContain('c1_budget_exhausted_on_converging_pr');
  });
});
