/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: FleetStrip — the fleet-wide live-run bar
 * rendered above the Mission Control DAG canvas.
 *
 * Surfaces:
 *   - RunChip per LIVE run (running / pending / paused). Shows workflow name,
 *     bound codebase, elapsed time, per-run cost. Highlighted when its run
 *     id matches the current run.
 *   - CoFireBadge — RED alarm when 2+ live runs share the same codebase. The
 *     anchor wound (2026-06-02): a zombie+keeper co-fire ran for an hour
 *     before John spotted "running 2x".
 *   - CostBurnMeter — running $/min across all live runs plus session total.
 *     Anchor: "$4.83 for 21min — what happened?" with no live cost view.
 *
 * Returns null when there are zero live runs (no chrome on a quiet system).
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Flame } from 'lucide-react';

import type { DashboardRunResponse } from '@/lib/api';
import { listDashboardRuns } from '@/lib/api';
import { ensureUtc, formatDurationMs } from '@/lib/format';
import { formatCostUsd, costColorClass } from '@/lib/cost-utils';
import {
  computeCostBurnRate,
  groupRunsByRepo,
  isLiveStatus,
  NO_CODEBASE_KEY,
} from '@/lib/negan-utils';
import { cn } from '@/lib/utils';

const FLEET_POLL_MS = 5_000;
const FLEET_LIMIT = 50;

interface FleetStripProps {
  /** Currently-focused run id (highlighted in the chip strip). */
  currentRunId?: string;
}

function elapsedFromStartedAt(startedAt: string): number {
  const t = new Date(ensureUtc(startedAt)).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Date.now() - t);
}

function runCostUsd(run: DashboardRunResponse): number {
  const cost = run.metadata?.total_cost_usd;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : 0;
}

function StatusDot({ status }: { status: string }): React.ReactElement {
  const color =
    status === 'running'
      ? 'bg-accent-bright animate-pulse'
      : status === 'paused'
        ? 'bg-warning'
        : 'bg-text-tertiary';
  return <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', color)} />;
}

function RunChip({
  run,
  highlighted,
}: {
  run: DashboardRunResponse;
  highlighted: boolean;
}): React.ReactElement {
  const navigate = useNavigate();
  const elapsed = elapsedFromStartedAt(run.started_at);
  const cost = runCostUsd(run);
  return (
    <button
      type="button"
      onClick={(): void => {
        navigate(`/workflows/runs/${run.id}`);
      }}
      className={cn(
        'flex items-center gap-2 rounded-full border px-2 py-0.5 text-[10px] transition-colors shrink-0',
        highlighted
          ? 'border-accent-bright bg-accent/10 text-accent-bright'
          : 'border-border bg-surface text-text-secondary hover:bg-surface-elevated'
      )}
      title={`${run.workflow_name} (${run.codebase_name ?? 'no codebase'})`}
      data-testid="fleet-run-chip"
    >
      <StatusDot status={run.status} />
      <span className="font-medium truncate max-w-[120px]">{run.workflow_name}</span>
      {run.codebase_name && (
        <>
          <span className="text-text-tertiary">·</span>
          <span className="truncate max-w-[100px] text-text-tertiary">{run.codebase_name}</span>
        </>
      )}
      <span className="text-text-tertiary tabular-nums">{formatDurationMs(elapsed)}</span>
      {cost > 0 && (
        <span className={cn('tabular-nums', costColorClass(cost))}>{formatCostUsd(cost)}</span>
      )}
    </button>
  );
}

function CoFireBadge({
  codebaseName,
  runIds,
}: {
  codebaseName: string;
  runIds: string[];
}): React.ReactElement {
  return (
    <div
      className="flex items-center gap-1.5 rounded-md border border-error/40 bg-error/10 px-2 py-0.5 text-[10px] text-error font-semibold shrink-0"
      role="alert"
      title={`Co-fire on ${codebaseName}: ${runIds.join(', ')}`}
      data-testid="cofire-badge"
    >
      <Flame className="h-3 w-3" />
      <span className="uppercase tracking-wide">Co-fire</span>
      <span className="font-mono normal-case font-medium">{codebaseName}</span>
      <span className="text-error/80 font-mono normal-case font-normal">
        ({String(runIds.length)}x)
      </span>
    </div>
  );
}

function CostBurnMeter({
  liveRuns,
}: {
  liveRuns: readonly DashboardRunResponse[];
}): React.ReactElement | null {
  // Re-compute on every render — cheap (linear in live run count) and Date.now()
  // changes between renders. The parent useQuery refetchInterval drives the
  // re-render cadence; useMemo prevents downstream cost-color flicker when
  // liveRuns identity is stable across renders.
  const { totalCostUsd, ratePerMin } = useMemo(() => computeCostBurnRate(liveRuns), [liveRuns]);
  if (liveRuns.length === 0) return null;
  return (
    <div
      className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 text-[10px] shrink-0"
      data-testid="cost-burn-meter"
    >
      <span className="text-text-tertiary uppercase tracking-wide">$</span>
      <span className={cn('tabular-nums font-semibold', costColorClass(totalCostUsd))}>
        {formatCostUsd(totalCostUsd)}
      </span>
      {ratePerMin !== null && (
        <>
          <span className="text-text-tertiary">·</span>
          <span className="tabular-nums text-text-secondary">{formatCostUsd(ratePerMin)}/min</span>
        </>
      )}
    </div>
  );
}

export function FleetStrip({ currentRunId }: FleetStripProps): React.ReactElement | null {
  const { data, isError } = useQuery({
    queryKey: ['fleetStripRuns'],
    queryFn: () => listDashboardRuns({ limit: FLEET_LIMIT }),
    refetchInterval: FLEET_POLL_MS,
    staleTime: 0,
  });

  const liveRuns = useMemo(
    () => (data?.runs ?? []).filter(r => isLiveStatus(r.status)),
    [data?.runs]
  );

  const coFires = useMemo(() => {
    const groups = groupRunsByRepo(liveRuns);
    const out: { codebaseName: string; runIds: string[] }[] = [];
    for (const [key, runs] of groups) {
      if (key === NO_CODEBASE_KEY) continue;
      if (runs.length < 2) continue;
      out.push({ codebaseName: key, runIds: runs.map(r => r.id) });
    }
    return out;
  }, [liveRuns]);

  if (isError) {
    // Silent: the FleetStrip is a diagnostic surface; a transient fetch error
    // shouldn't block the graph below. Surface a small error pill so the
    // operator knows the fleet view is stale.
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface text-[10px] text-text-tertiary">
        <AlertTriangle className="h-3 w-3 text-warning" />
        <span>Fleet view unavailable</span>
      </div>
    );
  }

  if (liveRuns.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-border bg-surface"
      data-testid="fleet-strip"
    >
      <span className="text-[10px] uppercase tracking-wide text-text-tertiary shrink-0">Fleet</span>
      <span className="text-[10px] text-text-secondary tabular-nums shrink-0">
        {String(liveRuns.length)} live
      </span>
      {coFires.map(cf => (
        <CoFireBadge key={cf.codebaseName} codebaseName={cf.codebaseName} runIds={cf.runIds} />
      ))}
      <CostBurnMeter liveRuns={liveRuns} />
      <div className="flex flex-wrap items-center gap-1.5">
        {liveRuns.map(run => (
          <RunChip key={run.id} run={run} highlighted={run.id === currentRunId} />
        ))}
      </div>
    </div>
  );
}
