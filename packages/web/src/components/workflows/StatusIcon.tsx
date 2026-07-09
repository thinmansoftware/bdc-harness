import { Lock, Pause } from 'lucide-react';
import { getStatusLabel } from '@/lib/status-renderer';

/**
 * Glyph + color mapping for workflow node/run statuses.
 * For run-level color tokens, dashboard surfaces use @/lib/status-renderer
 * (STATUS_DOT_COLORS / getStatusBadgeClasses). This component keeps the light-
 * weight glyph set used by the DAG and progress cards; escalated color is
 * intentionally the same warning token as status-renderer (Codex finding fixed).
 */
export function StatusIcon({ status }: { status: string }): React.ReactElement {
  switch (status) {
    case 'completed':
      return <span className="text-success text-sm">&#x2713;</span>;
    case 'completed_with_warning':
      // WO-170: yellow check -- exit-0 but stdout STATUS=*_failed detected.
      return <span className="text-warning text-sm">&#x2713;</span>;
    case 'running':
      return (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      );
    case 'paused':
      return <Pause className="h-3 w-3 text-warning" />;
    case 'awaiting_approval':
      // WO-MC-SELF-REPAIR-LOOP-VIZ-01: lock glyph distinguishes a paused
      // approval gate from a generic paused/running node at a glance.
      return <Lock className="h-3 w-3 text-warning animate-pulse" />;
    case 'failed':
      return <span className="text-error text-sm">&#x2717;</span>;
    case 'escalated':
      // WO-HARNESS-ESCALATED-RUN-STATUS-01: yellow up-arrow, distinct from failed (red X).
      // Color class "text-warning" mirrors status-renderer STATUS_DOT_COLORS.escalated
      // (bg-warning) so dashboard dots and DAG glyphs share the same semantic token.
      return (
        <span className="text-warning text-sm" title={getStatusLabel('escalated')}>
          &#x25B2;
        </span>
      );
    case 'cancelled':
      return <span className="text-text-secondary text-sm">&#x2715;</span>;
    case 'skipped':
      return <span className="text-text-secondary text-sm">&#x2014;</span>;
    default:
      return <span className="text-text-secondary text-sm">&#x25CB;</span>;
  }
}
