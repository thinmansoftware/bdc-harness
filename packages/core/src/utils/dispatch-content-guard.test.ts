import { describe, expect, test } from 'bun:test';
import { assessDispatchMessageBody } from './dispatch-content-guard';

describe('assessDispatchMessageBody', () => {
  test('rejects repo-mutating agent_message content', () => {
    const result = assessDispatchMessageBody(
      'agent_message',
      'Please commit this change, push the branch, and deploy it to production.'
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('repo_mutating_agent_message_rejected');
  });

  test('allows benign agent_message content', () => {
    const result = assessDispatchMessageBody(
      'agent_message',
      'Please review this proposal and summarize the main risks.'
    );

    expect(result.allowed).toBe(true);
  });

  test('allows explicit non-mutating task types', () => {
    const result = assessDispatchMessageBody('run_report', 'Report on the latest CI failure.');

    expect(result.allowed).toBe(true);
  });

  test('rejects repo mutation hidden in a free-form report task', () => {
    expect(
      assessDispatchMessageBody('run_report', 'Push this branch and merge it to dev.')
    ).toEqual({
      allowed: false,
      reason: 'repo_mutating_dispatch_body_rejected',
    });
  });
});
