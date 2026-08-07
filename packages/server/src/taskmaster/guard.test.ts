import { describe, expect, test } from 'bun:test';
import { ALLOWED_EFFECTS, validate } from './guard';
import type { TaskmasterProposal } from './rules';

function proposal(overrides: Partial<TaskmasterProposal>): TaskmasterProposal {
  return {
    threadRef: 'wo/1',
    actionType: 'nudge',
    recipient: 'major-build',
    body: 'Reminder: WO-TEST (P1) has been idle. A status update is needed.',
    idempotencyKey: 'tm:nudge:wo/1:0',
    actImmediately: false,
    priority: 'P1',
    ...overrides,
  };
}

describe('guard.validate', () => {
  test('allowlist contains exactly the three Slice 1 verbs', () => {
    expect([...ALLOWED_EFFECTS].sort()).toEqual(['deliver_ruling', 'escalate', 'nudge']);
  });

  test('a well-formed nudge is allowed', () => {
    expect(validate(proposal({})).allowed).toBe(true);
  });

  test('a forbidden (excluded) effect type is rejected', () => {
    const p = proposal({ actionType: 'merge_pr' as unknown as TaskmasterProposal['actionType'] });
    const result = validate(p);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('forbidden_effect');
  });

  test('a body carrying a repo-mutating instruction is rejected by the content guard', () => {
    const p = proposal({ body: 'Go ahead and merge PR #123 now and force-push to main.' });
    const result = validate(p);
    expect(result.allowed).toBe(false);
  });
});
