import { describe, expect, test } from 'bun:test';
import { recordUnverifiedReviewVerdict } from '../pr-review-wiring.ts';

const input = {
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  prNumber: 42,
  headSha: 'a'.repeat(40),
};

describe('unverified approval recovery', () => {
  test('queues exactly one exact-head re-review with the contract repeat reason', async () => {
    const writes: Record<string, unknown>[] = [];
    await recordUnverifiedReviewVerdict(input, {
      listMessages: async () => [] as never,
      createMessage: async (_authority, message) => {
        writes.push(message);
        return { id: 'retry-1' } as never;
      },
      claimVerdict: async () => ({ claimed: true, verdictId: 'verdict-1', retryCount: 0 }),
      finalizeVerdict: async () => ({}) as never,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      task_type: 'run_review',
      recipient: 'overseer-reviewer',
      repeat_reason: 'unverified_approval_retry',
    });
  });

  test('second same-head result escalates to Duty Officer without another review', async () => {
    const writes: Record<string, unknown>[] = [];
    await recordUnverifiedReviewVerdict(input, {
      listMessages: async () =>
        [
          {
            repeat_reason: 'unverified_approval_retry',
            body: JSON.stringify({ ...input, baseRef: '', author: '', headCiGreen: false }),
          },
        ] as never,
      createMessage: async (_authority, message) => {
        writes.push(message);
        return { id: 'escalation-1' } as never;
      },
      claimVerdict: async () => ({ claimed: false }),
      finalizeVerdict: async () => ({}) as never,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      task_type: 'agent_message',
      recipient: 'duty-officer',
      priority: 'blocker',
    });
  });
});
