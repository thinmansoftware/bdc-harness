import { Badge } from '@/components/ui/badge';
import type { TaskmasterRegisterMetaResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

function relativeTime(value: string | null): string {
  if (value === null) return 'never rebuilt';
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'rebuilt just now';
  if (minutes < 60) return `rebuilt ${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `rebuilt ${String(hours)}h ago`;
  return `rebuilt ${String(Math.floor(hours / 24))}d ago`;
}

const freshnessClasses = {
  FRESH: 'bg-green-500/15 text-green-400 border-green-500/30',
  STALE: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  PARTIAL: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  UNAVAILABLE: 'bg-red-500/15 text-red-400 border-red-500/30',
} as const;

export function FreshnessBanner({
  meta,
}: {
  meta: TaskmasterRegisterMetaResponse;
}): React.ReactElement {
  const unavailable = meta.freshness.includes('UNAVAILABLE');
  const detail = unavailable
    ? 'Register has never been built.'
    : meta.freshness.includes('PARTIAL')
      ? `${String(meta.partial_count)} of ${String(meta.row_count)} items not yet enriched.`
      : meta.freshness.includes('STALE')
        ? 'Data may be out of date.'
        : 'Register data is current.';

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        {meta.freshness.map(state => (
          <Badge key={state} variant="outline" className={freshnessClasses[state]}>
            {state}
          </Badge>
        ))}
        <Badge variant="outline">{meta.pause_state}</Badge>
        <span className="text-xs text-text-secondary">{relativeTime(meta.rebuilt_at)}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-secondary">
        <span>{detail}</span>
        <span>{String(meta.row_count)} items</span>
        <span
          className={cn(meta.unaddressed_xo > 0 && 'font-medium text-amber-400')}
        >{`${String(meta.unaddressed_xo)} unaddressed XO messages`}</span>
      </div>
    </section>
  );
}
