/**
 * WO-HARNESS-OVERSEER-NODE-FAILURE-REPAIR-AND-ESCALATION-01
 *
 * decide() behaviour for commit_hook_lint_failure: escalate-and-repair-once on
 * the first occurrence, escalate-as-blocker on the second. The pre-WO baseline
 * assertions for unknown and the other classes live in overseer.test.ts and are
 * not touched; the unknown case is re-asserted here to pin "still escalates".
 */
import { describe, expect, test } from 'bun:test';
import { decide } from './decide.ts';

describe('decide -- commit_hook_lint_failure (WO node-failure-repair)', () => {
  test('1 attempt 1 escalates, repairable once, not a blocker', () => {
    const result = decide({ errorClass: 'commit_hook_lint_failure', attempt: 1 });
    expect(result.decision).toBe('escalate');
    expect(result.repairableOnce).toBe(true);
    expect(result.blocker).toBe(false);
  });

  test('1 attempt 2 escalates as a blocker (repair pass did not clear it)', () => {
    const result = decide({ errorClass: 'commit_hook_lint_failure', attempt: 2 });
    expect(result.decision).toBe('escalate');
    expect(result.blocker).toBe(true);
    expect(result.repairableOnce).toBe(false);
  });

  test('1 attempt 3+ remains a blocker (never re-opens the repair path)', () => {
    const result = decide({ errorClass: 'commit_hook_lint_failure', attempt: 3 });
    expect(result.decision).toBe('escalate');
    expect(result.blocker).toBe(true);
  });

  test('3 unknown class still escalates with no blocker/repair markers', () => {
    const result = decide({ errorClass: 'unknown', attempt: 1 });
    expect(result.decision).toBe('escalate');
    expect(result.blocker).toBeUndefined();
    expect(result.repairableOnce).toBeUndefined();
  });
});
