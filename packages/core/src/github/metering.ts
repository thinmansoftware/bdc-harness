import { getDatabase } from '../db/connection';
import type { IDatabase } from '../db/adapters/types';
import type { GitHubService } from './service-identity';

export interface GitHubApiObservation {
  service: GitHubService;
  poolId: string;
  resource: string;
  status: number;
  limit?: number;
  remaining?: number;
  reset?: number;
  rateLimited?: boolean;
  permissionFallback?: boolean;
  observedAt?: number;
  /** Secondary-limit retry deadline, distinct from the quota reset header. */
  backoffUntil?: number;
}

interface UsageAggregate {
  hourBucket: string;
  service: GitHubService;
  poolId: string;
  resource: string;
  calls: number;
  rateLimited: number;
  permissionFallbacks: number;
}

const usage = new Map<string, UsageAggregate>();
const poolState = new Map<string, GitHubApiObservation>();
const backoff = new Map<string, number>();
let lastFlushAt = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<void> | null = null;

function finiteHeader(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function observationFromResponse(
  service: GitHubService,
  poolId: string,
  response: Response,
  extra: Pick<GitHubApiObservation, 'permissionFallback'> = {}
): GitHubApiObservation {
  const remaining = finiteHeader(response.headers.get('x-ratelimit-remaining'));
  const reset = finiteHeader(response.headers.get('x-ratelimit-reset'));
  const retryAfter = response.headers.get('retry-after');
  const retrySeconds = finiteHeader(retryAfter);
  const retryDate = retryAfter ? Date.parse(retryAfter) : NaN;
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 && (remaining === 0 || response.headers.has('retry-after')));
  return {
    service,
    poolId,
    resource: response.headers.get('x-ratelimit-resource') || 'core',
    status: response.status,
    limit: finiteHeader(response.headers.get('x-ratelimit-limit')),
    remaining,
    reset,
    rateLimited,
    ...(rateLimited
      ? {
          backoffUntil:
            retrySeconds !== undefined && retrySeconds >= 0
              ? Date.now() + retrySeconds * 1000
              : Number.isFinite(retryDate)
                ? retryDate
                : reset
                  ? reset * 1000
                  : Date.now() + 60_000,
        }
      : {}),
    permissionFallback: extra.permissionFallback,
  };
}

export function recordGitHubApiCall(observation: GitHubApiObservation): void {
  const observedAt = observation.observedAt ?? Date.now();
  const hourBucket = new Date(Math.floor(observedAt / 3_600_000) * 3_600_000).toISOString();
  const key = [hourBucket, observation.service, observation.poolId, observation.resource].join('|');
  const row = usage.get(key) ?? {
    hourBucket,
    service: observation.service,
    poolId: observation.poolId,
    resource: observation.resource,
    calls: 0,
    rateLimited: 0,
    permissionFallbacks: 0,
  };
  row.calls += 1;
  row.rateLimited += observation.rateLimited ? 1 : 0;
  row.permissionFallbacks += observation.permissionFallback ? 1 : 0;
  usage.set(key, row);
  if (
    observation.limit !== undefined ||
    observation.remaining !== undefined ||
    observation.reset !== undefined
  ) {
    poolState.set(`${observation.poolId}|${observation.resource}`, {
      ...observation,
      observedAt,
    });
  }
  if (observation.rateLimited) {
    const until =
      observation.backoffUntil ??
      (observation.reset ? observation.reset * 1000 : observedAt + 60_000);
    backoff.set(`${observation.poolId}|${observation.resource}`, until);
    // Durable gate in the existing resource-keyed table. Keep measured quota
    // remaining/reset untouched, including secondary limits with quota left.
    poolState.set(`${observation.poolId}|backoff:${observation.resource}`, {
      ...observation,
      resource: `backoff:${observation.resource}`,
      limit: undefined,
      remaining: 0,
      reset: until / 1000,
      observedAt,
    });
  }
  scheduleFlush();
}

export function assertGitHubPoolAvailable(
  poolId: string,
  resource = 'core',
  now = Date.now()
): void {
  const until = backoff.get(`${poolId}|${resource}`) ?? 0;
  if (until > now) throw new Error(`github_pool_backoff:${poolId}/${resource}:${until}`);
}

/** Read shared state afresh: command drivers do not share the server's Map. */
export async function assertPersistedGitHubPoolAvailable(
  poolId: string,
  resources: readonly string[],
  db: IDatabase = getDatabase(),
  now = Date.now()
): Promise<void> {
  for (const resource of resources) {
    assertGitHubPoolAvailable(poolId, resource, now);
    const result = await db.query<{ remaining: number | null; reset_at: string | null }>(
      'SELECT remaining, reset_at FROM github_api_pool_state WHERE pool_id = $1 AND (resource = $2 OR resource = $3)',
      [poolId, resource, `backoff:${resource}`]
    );
    for (const state of result.rows) {
      const until = state.reset_at ? Date.parse(state.reset_at) : 0;
      if (state.remaining === 0 && until > now) {
        throw new Error(`github_pool_backoff:${poolId}/${resource}:${until}`);
      }
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  const delay = Math.max(0, 60_000 - (Date.now() - lastFlushAt));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushGitHubApiMeter().catch(() => undefined);
  }, delay);
  flushTimer.unref?.();
}

export async function flushGitHubApiMeter(db: IDatabase = getDatabase()): Promise<void> {
  while (flushInFlight) await flushInFlight.catch(() => undefined);
  if (usage.size === 0 && poolState.size === 0) return;
  const operation = flushBatch(db);
  flushInFlight = operation;
  try {
    await operation;
  } finally {
    if (flushInFlight === operation) flushInFlight = null;
  }
}

async function flushBatch(db: IDatabase): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const usageRows = [...usage.values()];
  const stateRows = [...poolState.values()];
  usage.clear();
  poolState.clear();
  try {
    await db.withTransaction(async query => {
      for (const row of usageRows) {
        await query(
          `INSERT INTO github_api_usage (hour_bucket, service, pool_id, resource, calls, rate_limited, permission_fallbacks)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (hour_bucket, service, pool_id, resource) DO UPDATE SET
             calls = github_api_usage.calls + excluded.calls,
             rate_limited = github_api_usage.rate_limited + excluded.rate_limited,
             permission_fallbacks = github_api_usage.permission_fallbacks + excluded.permission_fallbacks`,
          [
            row.hourBucket,
            row.service,
            row.poolId,
            row.resource,
            row.calls,
            row.rateLimited,
            row.permissionFallbacks,
          ]
        );
      }
      for (const row of stateRows) {
        await query(
          `INSERT INTO github_api_pool_state (pool_id, resource, "limit", remaining, reset_at, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (pool_id, resource) DO UPDATE SET
             "limit" = excluded."limit", remaining = excluded.remaining,
             reset_at = excluded.reset_at, observed_at = excluded.observed_at
           WHERE github_api_pool_state.observed_at <= excluded.observed_at`,
          [
            row.poolId,
            row.resource,
            row.limit ?? null,
            row.remaining ?? null,
            row.reset ? new Date(row.reset * 1000).toISOString() : null,
            new Date(row.observedAt ?? Date.now()).toISOString(),
          ]
        );
      }
    });
    lastFlushAt = Date.now();
  } catch (error) {
    for (const row of usageRows) {
      const key = [row.hourBucket, row.service, row.poolId, row.resource].join('|');
      const current = usage.get(key);
      if (current) {
        current.calls += row.calls;
        current.rateLimited += row.rateLimited;
        current.permissionFallbacks += row.permissionFallbacks;
      } else usage.set(key, row);
    }
    for (const row of stateRows) {
      const key = `${row.poolId}|${row.resource}`;
      if ((poolState.get(key)?.observedAt ?? 0) <= (row.observedAt ?? 0)) poolState.set(key, row);
    }
    throw error;
  }
}

export function resetGitHubApiMeterForTests(): void {
  usage.clear();
  poolState.clear();
  backoff.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  lastFlushAt = 0;
}
