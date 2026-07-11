import { describe, expect, test } from 'bun:test';
import {
  planMergeReadyAction,
  planRateLimitAction,
  planRefireAction,
  planSalvageAction,
} from '../index.ts';

describe('overseer action planners', () => {
  test('merge-ready blocks when GitHub reports non-mergeable', () => {
    const action = planMergeReadyAction({
      runId: 'run-1',
      prUrl: 'https://github.test/pr/1',
      mergeable: 'CONFLICTING',
      checksPassing: true,
      manifestValid: true,
    });
    expect(action.kind).toBe('merge_ready');
    expect(action.status).toBe('blocked');
    expect(action.evidence.find(item => item.key === 'mergeable')?.value).toBe('CONFLICTING');
  });

  test('salvage plans only when a committed or unstaged diff exists', () => {
    expect(
      planSalvageAction({
        runId: 'run-1',
        hasCommittedDiff: false,
        hasUnstagedDiff: false,
        failureClass: 'unknown',
      }).status
    ).toBe('blocked');
    expect(
      planSalvageAction({
        runId: 'run-1',
        hasCommittedDiff: true,
        hasUnstagedDiff: false,
        failureClass: 'unknown',
      }).status
    ).toBe('planned');
  });

  test('rate-limit and refire carry rerunnable evidence', () => {
    const rateLimit = planRateLimitAction({ runId: 'run-1', attempt: 2 });
    expect(rateLimit.evidence.find(item => item.key === 'wait_ms')?.value).toBe('4000');
    const refire = planRefireAction({
      runId: 'run-1',
      workflow: 'bdc-feature-development',
      dispatchId: 'dispatch-1',
      fencingToken: 9,
    });
    expect(refire.fencingToken).toBe(9);
    expect(refire.evidence.find(item => item.key === 'dispatch_id')?.value).toBe('dispatch-1');
  });
});
