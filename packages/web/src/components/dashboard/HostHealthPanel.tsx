import type { HostMetricsResponse, DiskMetric, CpuMetric, MemMetric } from '@/lib/api';

/**
 * HostHealthPanel surfaces the host disk/cpu/mem snapshot written by the
 * host-side collector (separate WO WO-INFRA-HOST-METRICS-COLLECTOR-01 in
 * bdc-xo). Three render branches:
 *   - undefined or status='no-data': "awaiting collector" placeholder
 *     (collector not yet deployed; not a crash).
 *   - stale === true: render last-known meters with a STALE badge so an
 *     operator knows the data is older than 10 minutes.
 *   - fresh: render DiskMeter / CpuMeter / MemMeter live.
 */
export function HostHealthPanel({
  data,
}: {
  data: HostMetricsResponse | undefined;
}): React.ReactElement {
  if (!data || data.status === 'no-data') {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 text-sm text-text-tertiary">
        Host metrics: awaiting collector
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-text-primary">Host health</h3>
        <div className="flex items-center gap-2">
          {data.stale && (
            <span
              className="rounded-full border border-warning bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning"
              title={
                data.collectedAt
                  ? `Last collected ${data.collectedAt} (>10 min ago)`
                  : 'Collector timestamp missing'
              }
            >
              STALE
            </span>
          )}
          {data.collectedAt && (
            <span className="text-xs text-text-tertiary">
              {new Date(data.collectedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <DiskMeter disk={data.disk} />
        <CpuMeter cpu={data.cpu} />
        <MemMeter mem={data.mem} />
      </div>
    </div>
  );
}

function Meter({
  label,
  pct,
  detail,
}: {
  label: string;
  pct: number | null;
  detail?: string;
}): React.ReactElement {
  if (pct === null) {
    return (
      <div className="rounded-md border border-border bg-surface-elevated p-3">
        <div className="text-xs font-medium text-text-secondary">{label}</div>
        <div className="mt-1 text-xs text-text-tertiary">no data</div>
      </div>
    );
  }
  const clamped = Math.max(0, Math.min(100, pct));
  // Bar color tracks pressure: green under 70, yellow 70-90, red 90+.
  const barColor = clamped >= 90 ? 'bg-danger' : clamped >= 70 ? 'bg-warning' : 'bg-success';
  return (
    <div className="rounded-md border border-border bg-surface-elevated p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-text-secondary">{label}</div>
        <div className="text-xs font-medium text-text-primary">{clamped.toFixed(1)}%</div>
      </div>
      <div className="mt-1 h-2 w-full rounded-full bg-border/40">
        <div
          className={'h-full rounded-full ' + barColor}
          style={{ width: clamped.toFixed(1) + '%' }}
        />
      </div>
      {detail && <div className="mt-1 text-xs text-text-tertiary">{detail}</div>}
    </div>
  );
}

function DiskMeter({ disk }: { disk: DiskMetric | null }): React.ReactElement {
  const detail =
    disk !== null ? `${disk.used_gb.toFixed(1)} / ${disk.total_gb.toFixed(1)} GB` : undefined;
  return <Meter label="Disk" pct={disk?.pct ?? null} detail={detail} />;
}

function CpuMeter({ cpu }: { cpu: CpuMetric | null }): React.ReactElement {
  return <Meter label="CPU" pct={cpu?.pct ?? null} />;
}

function MemMeter({ mem }: { mem: MemMetric | null }): React.ReactElement {
  const detail =
    mem !== null ? `${mem.used_gb.toFixed(1)} / ${mem.total_gb.toFixed(1)} GB` : undefined;
  return <Meter label="Memory" pct={mem?.pct ?? null} detail={detail} />;
}
