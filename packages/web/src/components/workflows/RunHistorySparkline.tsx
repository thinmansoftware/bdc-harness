/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: per-workflow recent-outcome strip.
 *
 * "Fired 5x, died HERE 5x" anchor -- when a WO has been re-fired and keeps
 * landing in the same red box, the operator should see the trend without
 * digging through the dashboard. Mounted in NodePeekPanel so it appears
 * alongside the in-context node detail (the node face is already crowded
 * with status / cost / iteration / failureClass).
 *
 * Returns null when fewer than 2 historical runs exist (one run is just
 * noise; the trend needs at least two).
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';

import type { DashboardRunResponse } from '@/lib/api';
import { listDashboardRuns } from '@/lib/api';
import { ensureUtc, formatDurationMs } from '@/lib/format';
import { cn } from '@/lib/utils';

const SPARKLINE_LIMIT = 10;
const POLL_MS = 30_000;

interface RunHistorySparklineProps {
  workflowName: string;
}

function statusDotColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-success';
    case 'failed':
      return 'bg-error';
    case 'cancelled':
      return 'bg-text-tertiary';
    case 'running':
    case 'pending':
      return 'bg-accent-bright animate-pulse';
    case 'paused':
      return 'bg-warning';
    default:
      return 'bg-text-tertiary';
  }
}

function runElapsedMs(run: DashboardRunResponse): number {
  const start = new Date(ensureUtc(run.started_at)).getTime();
  if (!Number.isFinite(start)) return 0;
  if (run.completed_at) {
    const end = new Date(ensureUtc(run.completed_at)).getTime();
    if (Number.isFinite(end) && end >= start) return end - start;
  }
  return Math.max(0, Date.now() - start);
}

export function RunHistorySparkline({
  workflowName,
}: RunHistorySparklineProps): React.ReactElement | null {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['runHistorySparkline', workflowName],
    queryFn: () => listDashboardRuns({ search: workflowName, limit: SPARKLINE_LIMIT }),
    refetchInterval: POLL_MS,
    staleTime: 0,
  });

  const recentRuns = useMemo(() => {
    const all = data?.runs ?? [];
    // Server returns newest first; tighten to runs that actually match the
    // workflow_name (search is broad) and clip to SPARKLINE_LIMIT.
    return all.filter(r => r.workflow_name === workflowName).slice(0, SPARKLINE_LIMIT);
  }, [data?.runs, workflowName]);

  if (recentRuns.length < 2) return null;

  const failedCount = recentRuns.filter(r => r.status === 'failed').length;

  return (
    <section className="px-3 py-2 border-b border-border" data-testid="run-history-sparkline">
      <h3 className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1 flex items-center gap-2">
        <span>Recent runs</span>
        <span className="text-text-secondary normal-case tracking-normal">
          {String(failedCount)}/{String(recentRuns.length)} failed
        </span>
      </h3>
      <div className="flex items-center gap-1">
        {recentRuns.map(run => (
          <button
            key={run.id}
            type="button"
            onClick={(): void => {
              navigate(`/workflows/runs/${run.id}`);
            }}
            className={cn(
              'h-2.5 w-2.5 rounded-full shrink-0 cursor-pointer transition-transform hover:scale-150',
              statusDotColor(run.status)
            )}
            title={`${run.status} - ${formatDurationMs(runElapsedMs(run))}${run.codebase_name ? ` - ${run.codebase_name}` : ''}`}
            data-testid="run-history-dot"
          />
        ))}
      </div>
    </section>
  );
}
