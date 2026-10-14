export interface GitHubApiObservation {
  service: string;
  poolId: string;
  resource: string;
  status: number;
  limit?: number;
  remaining?: number;
  resetAt?: number;
  rateLimited?: boolean;
  permissionFallback?: boolean;
  observedAt?: number;
}
export interface GitHubUsageRow {
  hourBucket: string;
  service: string;
  poolId: string;
  resource: string;
  calls: number;
  rateLimited: number;
  permissionFallbacks: number;
}
export interface GitHubPoolState {
  poolId: string;
  resource: string;
  limit: number;
  remaining: number;
  resetAt: number;
  observedAt: number;
}
export interface GitHubMeterSink {
  flush(usage: GitHubUsageRow[], states: GitHubPoolState[]): Promise<void>;
}
const SAFE_LABEL = /^[a-zA-Z0-9_.-]+$/;
export class GitHubApiMeter {
  private usage = new Map<string, GitHubUsageRow>();
  private states = new Map<string, GitHubPoolState>();
  private lastFlush = 0;
  constructor(
    private readonly sink: GitHubMeterSink,
    private readonly now: () => number = Date.now,
    private readonly flushIntervalMs = 60_000
  ) {}
  record(input: GitHubApiObservation): void {
    if (
      !SAFE_LABEL.test(input.poolId) ||
      !SAFE_LABEL.test(input.resource) ||
      !SAFE_LABEL.test(input.service)
    )
      throw new Error('Unsafe GitHub metering label');
    const observedAt = input.observedAt ?? this.now();
    const hourBucket = new Date(Math.floor(observedAt / 3_600_000) * 3_600_000).toISOString();
    const key = [hourBucket, input.service, input.poolId, input.resource].join('\0');
    const row = this.usage.get(key) ?? {
      hourBucket,
      service: input.service,
      poolId: input.poolId,
      resource: input.resource,
      calls: 0,
      rateLimited: 0,
      permissionFallbacks: 0,
    };
    row.calls++;
    if (input.rateLimited) row.rateLimited++;
    if (input.permissionFallback) row.permissionFallbacks++;
    this.usage.set(key, row);
    if ([input.limit, input.remaining, input.resetAt].every(v => typeof v === 'number'))
      this.states.set(`${input.poolId}\0${input.resource}`, {
        poolId: input.poolId,
        resource: input.resource,
        limit: input.limit!,
        remaining: input.remaining!,
        resetAt: input.resetAt!,
        observedAt,
      });
  }
  async flush(force = false): Promise<boolean> {
    const now = this.now();
    if (!force && now - this.lastFlush < this.flushIntervalMs) return false;
    if (!this.usage.size && !this.states.size) return false;
    const usage = [...this.usage.values()];
    const states = [...this.states.values()];
    await this.sink.flush(usage, states);
    this.usage.clear();
    this.states.clear();
    this.lastFlush = now;
    return true;
  }
}
