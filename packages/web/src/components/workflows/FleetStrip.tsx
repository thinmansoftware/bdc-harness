/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 — FleetStrip.
 *
 * Horizontal bar above the run-detail graph showing all live runs across all
 * repos, with a RED co-fire alarm when >=2 live runs share a codebase (the
 * 2026-06-02 "running 2x" anchor) and a CostBurnMeter for the session.
 *
 * Data source: `/api/dashboard/runs` (listDashboardRuns) polled every 5s.
 * DashboardRunResponse does NOT currently carry a per-run `cost_usd`
 * field — see lib/fleet-cost.ts for the degradation path (count+elapsed).
 *
 * Layout: tight strip; auto-hides when no live runs.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router';

import { listDashboardRuns, type DashboardRunResponse } from '@/lib/api';
import type { WorkflowRunStatus } from '@/lib/types';
import { computeCostMeter, groupRunsByCodebase, type CostMeterRun } from '@/lib/fleet-cost';
import { formatDurationMs } from '@/lib/format';

const POLL_MS = 5000;
// Statuses that count as "live" for the fleet view. The API does not accept
// comma-separated status values (Ambiguity #4) so we make one call per status
// and merge client-side.
const LIVE_STATUSES: readonly WorkflowRunStatus[] = ['running', 'pending', 'paused'];

function elapsedFor(run: DashboardRunResponse, now: number): number {
  const start = new Date(run.started_at).getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, now - start);
}

function statusDotClass(status: WorkflowRunStatus): string {
  switch (status) {
    case 'running':
      return 'bg-accent-bright animate-pulse';
    case 'paused':
      return 'bg-warning';
    case 'pending':
      return 'bg-accent';
    default:
      return 'bg-text-tertiary';
  }
}

interface RunChipProps {
  run: DashboardRunResponse;
  now: number;
  onClick: () => void;
}

function RunChip({ run, now, onClick }: RunChipProps): React.ReactElement {
  const label = run.codebase_name ?? 'unbound';
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] hover:bg-surface-elevated transition-colors"
      data-testid="fleet-run-chip"
      title={`${run.workflow_name} on ${label} (${run.status})`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDotClass(run.status)}`} />
      <span className="font-mono text-text-primary truncate max-w-[120px]">
        {run.workflow_name}
      </span>
      <span className="text-text-tertiary">·</span>
      <span className="text-text-tertiary truncate max-w-[100px]">{label}</span>
      <span className="text-text-tertiary tabular-nums">
        {formatDurationMs(elapsedFor(run, now))}
      </span>
    </button>
  );
}

interface CoFireBadgeProps {
  key_: string;
  runs: readonly DashboardRunResponse[];
}

function CoFireBadge({ key_, runs }: CoFireBadgeProps): React.ReactElement {
  const ids = runs.map(r => r.id.slice(0, 8)).join(' / ');
  return (
    <span
      role="alert"
      data-testid="fleet-cofire-badge"
      className="flex items-center gap-1 rounded-md border border-error bg-error/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-error"
      title={`CO-FIRE: ${String(runs.length)} runs on ${key_}: ${ids}`}
    >
      <AlertTriangle className="h-3 w-3" />
      <span>CO-FIRE: {key_}</span>
      <span className="text-error/80 font-mono normal-case">x{String(runs.length)}</span>
    </span>
  );
}

export function FleetStrip(): React.ReactElement | null {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<DashboardRunResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const results = await Promise.all(
          LIVE_STATUSES.map(status => listDashboardRuns({ status, limit: 50 }))
        );
        if (cancelled) return;
        // Merge by run id (a paused run could appear in two statuses during a
        // transition window; de-dupe on id).
        const byId = new Map<string, DashboardRunResponse>();
        for (const result of results) {
          for (const r of result.runs) byId.set(r.id, r);
        }
        setRuns(Array.from(byId.values()));
      } catch (err) {
        // Non-fatal: log + leave previous fleet visible. FleetStrip never
        // crashes the parent graph.
        console.warn('[FleetStrip] poll failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void poll();
    intervalRef.current = setInterval((): void => {
      void poll();
    }, POLL_MS);
    const tickInterval = setInterval((): void => {
      setNow(Date.now());
    }, 1000);
    return (): void => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      clearInterval(tickInterval);
    };
  }, []);

  const groups = useMemo(() => groupRunsByCodebase(runs), [runs]);
  const coFireGroups = useMemo(
    () => Array.from(groups.entries()).filter(([, list]) => list.length >= 2),
    [groups]
  );

  const meterRuns: CostMeterRun[] = useMemo(
    () => runs.map(r => ({ started_at: r.started_at })),
    [runs]
  );
  const meter = useMemo(() => computeCostMeter(meterRuns, now), [meterRuns, now]);

  if (loading && runs.length === 0) {
    return (
      <div
        className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-[10px] text-text-tertiary"
        data-testid="fleet-strip-loading"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Fleet: loading...</span>
      </div>
    );
  }

  if (runs.length === 0) return null;

  return (
    <div
      className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 overflow-x-auto"
      data-testid="fleet-strip"
    >
      <span className="text-[10px] uppercase tracking-wide text-text-tertiary font-semibold shrink-0">
        Fleet
      </span>
      <div className="flex items-center gap-1.5 shrink-0">
        {coFireGroups.map(([key, list]) => (
          <CoFireBadge key={`cofire-${key}`} key_={key} runs={list} />
        ))}
      </div>
      <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
        {runs.map(r => (
          <RunChip
            key={r.id}
            run={r}
            now={now}
            onClick={(): void => {
              navigate(`/workflows/runs/${r.id}`);
            }}
          />
        ))}
      </div>
      <div
        className="shrink-0 flex items-center gap-1 rounded-md bg-surface-elevated px-2 py-0.5 text-[10px] font-mono text-text-secondary"
        data-testid="fleet-cost-meter"
        title={
          meter.isEstimate
            ? 'CostBurnMeter: cost_usd not yet surfaced in DashboardRunResponse - showing run count + elapsed (fast-follow WO)'
            : 'CostBurnMeter: total cost / elapsed across live runs'
        }
      >
        <span>{meter.displayValue}</span>
        {meter.isEstimate && <span className="text-text-tertiary">est</span>}
      </div>
    </div>
  );
}
