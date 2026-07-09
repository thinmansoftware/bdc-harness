/**
 * status-renderer.ts -- dashboard / UI mapping for workflow run statuses.
 *
 * WO-HARNESS-ESCALATED-RUN-STATUS-01: map terminal status 'escalated' to
 * YELLOW with label "Escalated", distinct from 'failed' (RED).
 *
 * Single source of truth for:
 *   - status -> Tailwind color class (dot / badge)
 *   - status -> human label
 *   - status terminal-ness (for display filters)
 */

/** Run-level workflow statuses the dashboard understands. */
export type RenderableRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'escalated'
  | 'cancelled'
  | string;

/** Dot / chip color classes for status indicators. */
export const STATUS_DOT_COLORS: Record<string, string> = {
  completed: 'bg-success',
  failed: 'bg-destructive',
  // Escalated = gate-rejection ladder uplift -- YELLOW, not red.
  escalated: 'bg-warning',
  cancelled: 'bg-text-tertiary',
  running: 'bg-primary',
  paused: 'bg-warning',
  pending: 'bg-text-tertiary',
};

/** Badge (bg + text) classes for status pills. */
export const STATUS_BADGE_CLASSES: Record<string, string> = {
  running: 'bg-primary/10 text-primary',
  paused: 'bg-warning/10 text-warning',
  pending: 'bg-surface-elevated text-text-secondary',
  completed: 'bg-success/10 text-success',
  failed: 'bg-destructive/10 text-destructive',
  escalated: 'bg-warning/10 text-warning',
  cancelled: 'bg-surface-elevated text-text-tertiary',
};

/** Human-readable labels. */
export const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  escalated: 'Escalated',
  cancelled: 'Cancelled',
};

/**
 * Return the Tailwind class for a status-dot color. Unknown statuses fall
 * back to tertiary grey.
 */
export function getStatusDotColor(status: RenderableRunStatus): string {
  return STATUS_DOT_COLORS[status] ?? 'bg-text-tertiary';
}

/**
 * Return the badge classes for a status pill.
 */
export function getStatusBadgeClasses(status: RenderableRunStatus): string {
  return STATUS_BADGE_CLASSES[status] ?? 'bg-surface-elevated text-text-secondary';
}

/**
 * Human label for a status. Unknown statuses are title-cased from the raw value.
 */
export function getStatusLabel(status: RenderableRunStatus): string {
  if (STATUS_LABELS[status]) return STATUS_LABELS[status];
  if (!status) return 'Unknown';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * True when the status is a finished (terminal) state. Escalated is terminal
 * and distinct from failed.
 */
export function isTerminalRunStatus(status: RenderableRunStatus | undefined): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'escalated' ||
    status === 'cancelled'
  );
}

/**
 * True when the status should appear in the dashboard History pane.
 */
export function isHistoryRunStatus(status: RenderableRunStatus | undefined): boolean {
  return isTerminalRunStatus(status);
}
