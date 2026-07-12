/**
 * Recovery-renderer tests for WO-HARNESS-RUN-RECOVERY-DUAL-TRUTH-01 (M-26).
 *
 * Test 7 fixture matrix: recoverable, pr_ready-validated, recovering, recovered,
 * abandoned, not_needed (asserts null/omitted). Recovery is a second,
 * independent axis -- these labels are shown ALONGSIDE the execution status and
 * never replace it.
 */
import { describe, expect, test } from 'bun:test';
import type { RunOutcome } from './api';
import {
  getRecoveryBadgeClasses,
  getRecoveryDotColor,
  getRecoveryLabel,
  RECOVERY_BADGE_CLASSES,
  RECOVERY_DOT_COLORS,
} from './recovery-renderer';

/** Build a RunOutcome fixture with sensible defaults, overridable per case. */
function makeOutcome(overrides: Partial<RunOutcome>): RunOutcome {
  return {
    executionState: 'failed',
    deliverableState: 'none',
    validationState: 'not_run',
    recoveryState: 'not_needed',
    routeState: 'current',
    primaryReason: 'test',
    reasonCodes: [],
    evidenceRefs: [],
    ...overrides,
  };
}

describe('recovery-renderer getRecoveryLabel', () => {
  test('not_needed -> null (omit)', () => {
    expect(getRecoveryLabel(makeOutcome({ recoveryState: 'not_needed' }))).toBeNull();
  });

  test('null / undefined outcome -> null', () => {
    expect(getRecoveryLabel(null)).toBeNull();
    expect(getRecoveryLabel(undefined)).toBeNull();
  });

  test('recoverable + pr_ready + passed -> "PR Ready (Validated)"', () => {
    expect(
      getRecoveryLabel(
        makeOutcome({
          recoveryState: 'recoverable',
          deliverableState: 'pr_ready',
          validationState: 'passed',
        })
      )
    ).toBe('PR Ready (Validated)');
  });

  test('recoverable (otherwise) -> "Recoverable"', () => {
    expect(getRecoveryLabel(makeOutcome({ recoveryState: 'recoverable' }))).toBe('Recoverable');
    // pr_ready but not validated -> still just Recoverable
    expect(
      getRecoveryLabel(
        makeOutcome({
          recoveryState: 'recoverable',
          deliverableState: 'pr_ready',
          validationState: 'not_run',
        })
      )
    ).toBe('Recoverable');
    // validated but not pr_ready -> still just Recoverable
    expect(
      getRecoveryLabel(
        makeOutcome({
          recoveryState: 'recoverable',
          deliverableState: 'pushed',
          validationState: 'passed',
        })
      )
    ).toBe('Recoverable');
  });

  test('recovering -> "Recovering"', () => {
    expect(getRecoveryLabel(makeOutcome({ recoveryState: 'recovering' }))).toBe('Recovering');
  });

  test('recovered -> "Recovered"', () => {
    expect(getRecoveryLabel(makeOutcome({ recoveryState: 'recovered' }))).toBe('Recovered');
  });

  test('abandoned_by_operator -> "Abandoned"', () => {
    expect(getRecoveryLabel(makeOutcome({ recoveryState: 'abandoned_by_operator' }))).toBe(
      'Abandoned'
    );
  });
});

describe('recovery-renderer color tokens', () => {
  test('recovered uses success styling', () => {
    expect(RECOVERY_DOT_COLORS.recovered).toBe('bg-success');
    expect(getRecoveryDotColor('recovered')).toBe('bg-success');
    expect(getRecoveryBadgeClasses('recovered')).toContain('text-success');
  });

  test('recovering uses primary styling', () => {
    expect(RECOVERY_DOT_COLORS.recovering).toBe('bg-primary');
    expect(getRecoveryDotColor('recovering')).toBe('bg-primary');
    expect(getRecoveryBadgeClasses('recovering')).toContain('text-primary');
  });

  test('recoverable uses warning styling', () => {
    expect(RECOVERY_DOT_COLORS.recoverable).toBe('bg-warning');
    expect(getRecoveryBadgeClasses('recoverable')).toContain('text-warning');
  });

  test('abandoned uses muted/tertiary styling', () => {
    expect(getRecoveryDotColor('abandoned_by_operator')).toBe('bg-text-tertiary');
    expect(getRecoveryBadgeClasses('abandoned_by_operator')).toContain('text-text-tertiary');
  });

  test('unknown recovery state falls back to tertiary/muted', () => {
    expect(getRecoveryDotColor('mystery')).toBe('bg-text-tertiary');
    expect(getRecoveryBadgeClasses('mystery')).toBe('bg-surface-elevated text-text-tertiary');
  });

  test('RECOVERY_BADGE_CLASSES covers all recovery states', () => {
    for (const state of [
      'not_needed',
      'recoverable',
      'recovering',
      'recovered',
      'abandoned_by_operator',
    ] as const) {
      expect(RECOVERY_BADGE_CLASSES[state]).toBeDefined();
    }
  });
});
