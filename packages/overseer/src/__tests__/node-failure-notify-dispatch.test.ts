import { describe, expect, test } from 'bun:test';
import { buildNodeFailureDispatchBody, isNodeFailureBlocker } from '../node-failure-notify.ts';

const base = {
  runId: 'run-1',
  workflowName: 'wf',
  nodeId: 'commit-and-push-retry',
  errorClass: 'commit_hook_lint_failure' as const,
  decision: 'escalate' as const,
  attempt: 2,
  error: 'husky failed',
  log: { error() {} },
};

describe('overseer-node-failure Dispatch contract', () => {
  test('attempt two is a blocker and notification body carries routing context', () => {
    expect(isNodeFailureBlocker(base)).toBe(true);
    expect(buildNodeFailureDispatchBody(base)).toContain('Attempt: 2');
    expect('overseer-node-failure:run-1:commit-and-push-retry').toContain('overseer-node-failure');
    expect('overseer-node-failure-blocker:run-1:commit-and-push-retry').toContain(
      'overseer-node-failure'
    );
  });
});
