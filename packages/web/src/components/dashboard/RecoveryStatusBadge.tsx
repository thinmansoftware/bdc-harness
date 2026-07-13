/**
 * RecoveryStatusBadge -- the single shared recovery-axis badge
 * (WO-HARNESS-RUN-RECOVERY-DUAL-TRUTH-01, Section 5 permits exactly one).
 *
 * This is a SECOND, INDEPENDENT indicator rendered ALONGSIDE the execution
 * status badge. It never replaces or hides the execution status. Renders
 * nothing when the recovery axis has no label (recoveryState === 'not_needed'
 * or a missing outcome).
 *
 * Consumed by WorkflowRunCard, WorkflowHistoryTable, and WorkflowExecution.
 */
import type { RunOutcome } from '@/lib/api';
import { cn } from '@/lib/utils';
import { getRecoveryBadgeClasses, getRecoveryLabel } from '@/lib/recovery-renderer';

interface RecoveryStatusBadgeProps {
  outcome: RunOutcome | null | undefined;
  className?: string;
}

export function RecoveryStatusBadge({
  outcome,
  className,
}: RecoveryStatusBadgeProps): React.ReactElement | null {
  const label = getRecoveryLabel(outcome);
  if (label === null || !outcome) return null;

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        getRecoveryBadgeClasses(outcome.recoveryState),
        className
      )}
      title={`Recovery: ${label}`}
    >
      {label}
    </span>
  );
}
