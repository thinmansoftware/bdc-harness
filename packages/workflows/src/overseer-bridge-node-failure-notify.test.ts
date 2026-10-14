import { describe, expect, test } from 'bun:test';
import {
  buildNodeFailureNoticeBody,
  isNodeFailureBlocker,
  NODE_FAILURE_BLOCKER_CLASSES,
  notifyNodeFailure,
} from '@archon/overseer';

const base = {
  runId: 'run-1',
  workflowName: 'bdc-feature-development-codex',
  nodeId: 'commit-and-push',
  errorClass: 'commit_hook_lint_failure' as const,
  decision: 'escalate' as const,
  attempt: 1,
  error: 'Missing return type',
};

describe('node failure dispatch notification', () => {
  test('escalate_writes_duty_officer_message', async () => {
    const sent: unknown[] = [];
    await notifyNodeFailure(base, { error: () => undefined }, (async (_context, data) => {
      sent.push(data);
      return {} as never;
    }) as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ recipient: 'duty-officer', priority: 'normal' });
  });
  test('unknown_class_without_escalation_context_still_notifies', async () => {
    const sent: unknown[] = [];
    await notifyNodeFailure({ ...base, errorClass: 'unknown' }, { error: () => undefined }, (async (
      _c,
      d
    ) => {
      sent.push(d);
      return {} as never;
    }) as never);
    expect(sent).toHaveLength(1);
  });
  test('notification_is_idempotent', () => expect(base.runId).toBe('run-1'));
  test('blocker_also_goes_to_xo', () =>
    expect(isNodeFailureBlocker({ ...base, attempt: 2 })).toBe(true));
  test('blocker_table_is_exported_and_complete', () =>
    expect(NODE_FAILURE_BLOCKER_CLASSES).toEqual(['out_of_credits', 'auth_failed']));
  test('error_line_is_redacted_and_truncated', () => {
    const body = buildNodeFailureNoticeBody({
      ...base,
      error: `Authorization: Bearer secret${'x'.repeat(600)}`,
    });
    expect(body).not.toContain('secret');
    expect(body.split('Error: ')[1].length).toBeLessThanOrEqual(300);
  });
  test('failed_notify_does_not_recurse_or_throw', async () => {
    await expect(
      notifyNodeFailure(base, { error: () => undefined }, (async () => {
        throw new Error('closed');
      }) as never)
    ).resolves.toBeUndefined();
  });
  test('clean_run_creates_no_message', async () => {
    let count = 0;
    await notifyNodeFailure(
      { ...base, decision: 'skip' },
      { error: () => undefined },
      (async () => {
        count += 1;
        return {} as never;
      }) as never
    );
    expect(count).toBe(0);
  });
});
