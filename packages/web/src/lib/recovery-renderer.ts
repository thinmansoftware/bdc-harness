/**
 * recovery-renderer.ts -- dashboard / UI mapping for run RECOVERY status.
 *
 * WO-HARNESS-RUN-RECOVERY-DUAL-TRUTH-01 (M-26 two-axis display): recovery is a
 * SECOND, INDEPENDENT axis rendered ALONGSIDE the execution status. Execution
 * truth is never hidden -- there is no single "RECOVERED" badge that replaces
 * the execution status. This module mirrors status-renderer.ts and maps a run's
 * RunOutcome to a recovery label + Tailwind color tokens.
 *
 * Single source of truth for:
 *   - recoveryState -> Tailwind color class (dot / badge)
 *   - RunOutcome    -> human recovery label (or null when omitted)
 */
import type { RunOutcome } from './api';

/** Recovery-axis state values understood by the dashboard. */
export type RenderableRecoveryState = string;

/** Dot / chip color classes for recovery indicators. */
export const RECOVERY_DOT_COLORS: Record<string, string> = {
  not_needed: 'bg-text-tertiary',
  recoverable: 'bg-warning',
  recovering: 'bg-primary',
  recovered: 'bg-success',
  abandoned_by_operator: 'bg-text-tertiary',
};

/** Badge (bg + text) classes for recovery pills. */
export const RECOVERY_BADGE_CLASSES: Record<string, string> = {
  not_needed: 'bg-surface-elevated text-text-tertiary',
  recoverable: 'bg-warning/10 text-warning',
  recovering: 'bg-primary/10 text-primary',
  recovered: 'bg-success/10 text-success',
  abandoned_by_operator: 'bg-surface-elevated text-text-tertiary',
};

/**
 * Human-readable recovery label for a run's outcome.
 *
 * Mapping (M-26):
 *   - recoveryState === 'not_needed'            -> null (omit)
 *   - recoverable + pr_ready + validated passed -> "PR Ready (Validated)"
 *   - recoverable (otherwise)                   -> "Recoverable"
 *   - recovering                                -> "Recovering"
 *   - recovered                                 -> "Recovered"
 *   - abandoned_by_operator                     -> "Abandoned"
 *
 * Returns null when the recovery axis should render nothing (not_needed or a
 * missing outcome).
 */
export function getRecoveryLabel(outcome: RunOutcome | null | undefined): string | null {
  if (!outcome) return null;
  switch (outcome.recoveryState) {
    case 'not_needed':
      return null;
    case 'recoverable':
      if (outcome.deliverableState === 'pr_ready' && outcome.validationState === 'passed') {
        return 'PR Ready (Validated)';
      }
      return 'Recoverable';
    case 'recovering':
      return 'Recovering';
    case 'recovered':
      return 'Recovered';
    case 'abandoned_by_operator':
      return 'Abandoned';
    default:
      return null;
  }
}

/**
 * Return the Tailwind class for a recovery-dot color. Unknown states fall back
 * to tertiary grey.
 */
export function getRecoveryDotColor(recoveryState: RenderableRecoveryState): string {
  return RECOVERY_DOT_COLORS[recoveryState] ?? 'bg-text-tertiary';
}

/**
 * Return the badge classes for a recovery pill. Unknown states fall back to a
 * muted surface style.
 */
export function getRecoveryBadgeClasses(recoveryState: RenderableRecoveryState): string {
  return RECOVERY_BADGE_CLASSES[recoveryState] ?? 'bg-surface-elevated text-text-tertiary';
}
