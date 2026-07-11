import { describe, expect, test } from 'bun:test';
import { reconcileRun } from '../index.ts';

describe('reconcileRun', () => {
  test('routes rate limits to the retry budget action', () => {
    const action = reconcileRun({
      runId: 'run-1',
      failureClass: 'rate_limit_exceeded',
      attempt: 1,
      hasCommittedDiff: false,
      hasUnstagedDiff: false,
    });
    expect(action.kind).toBe('rate_limit');
  });

  test('routes failed work with a diff to salvage', () => {
    const action = reconcileRun({
      runId: 'run-1',
      failureClass: 'unknown',
      attempt: 1,
      hasCommittedDiff: false,
      hasUnstagedDiff: true,
    });
    expect(action.kind).toBe('salvage');
    expect(action.status).toBe('planned');
  });
});
