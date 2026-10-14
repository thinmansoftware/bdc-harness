import { getDatabase } from './connection';
import type { IDatabase } from './adapters/types';
import type { GitHubPoolState, GitHubUsageRow } from '../github/metering';

export async function flushGitHubApiMeter(
  usage: GitHubUsageRow[],
  states: GitHubPoolState[],
  db: IDatabase = getDatabase()
): Promise<void> {
  await db.withTransaction(async query => {
    for (const row of usage)
      await query(
        `INSERT INTO github_api_usage (hour_bucket,service,pool_id,resource,calls,rate_limited,permission_fallbacks) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (hour_bucket,service,pool_id,resource) DO UPDATE SET calls=github_api_usage.calls+excluded.calls,rate_limited=github_api_usage.rate_limited+excluded.rate_limited,permission_fallbacks=github_api_usage.permission_fallbacks+excluded.permission_fallbacks`,
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
    for (const state of states)
      await query(
        `INSERT INTO github_api_pool_state (pool_id,resource,"limit",remaining,reset_at,observed_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (pool_id,resource) DO UPDATE SET "limit"=excluded."limit",remaining=excluded.remaining,reset_at=excluded.reset_at,observed_at=excluded.observed_at WHERE excluded.observed_at >= github_api_pool_state.observed_at`,
        [
          state.poolId,
          state.resource,
          state.limit,
          state.remaining,
          new Date(state.resetAt).toISOString(),
          new Date(state.observedAt).toISOString(),
        ]
      );
  });
}

export interface GitHubUsageDigestRow {
  service: string;
  poolId: string;
  averageCallsPerHour: number;
  peakCallsPerHour: number;
}
export async function getGitHubApiDigest(
  db: IDatabase = getDatabase()
): Promise<{
  usage: GitHubUsageDigestRow[];
  pools: GitHubPoolState[];
  memberships: Map<string, string[]>;
}> {
  const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const usageRows = await db.query<{
    service: string;
    pool_id: string;
    avg_calls: number | string;
    peak_calls: number | string;
  }>(
    `SELECT service,pool_id,AVG(calls) avg_calls,MAX(calls) peak_calls FROM github_api_usage WHERE hour_bucket >= $1 GROUP BY service,pool_id ORDER BY service,pool_id`,
    [cutoff]
  );
  const poolRows = await db.query<{
    pool_id: string;
    resource: string;
    limit: number;
    remaining: number;
    reset_at: string;
    observed_at: string;
  }>(
    `SELECT pool_id,resource,"limit",remaining,reset_at,observed_at FROM github_api_pool_state ORDER BY pool_id,resource`
  );
  const memberRows = await db.query<{ pool_id: string; resource: string; service: string }>(
    `SELECT DISTINCT pool_id,resource,service FROM github_api_usage WHERE hour_bucket >= $1 ORDER BY pool_id,resource,service`,
    [cutoff]
  );
  const memberships = new Map<string, string[]>();
  for (const row of memberRows.rows) {
    const key = `${row.pool_id}/${row.resource}`;
    memberships.set(key, [...(memberships.get(key) ?? []), row.service]);
  }
  return {
    usage: usageRows.rows.map(row => ({
      service: row.service,
      poolId: row.pool_id,
      averageCallsPerHour: Number(row.avg_calls),
      peakCallsPerHour: Number(row.peak_calls),
    })),
    pools: poolRows.rows.map(row => ({
      poolId: row.pool_id,
      resource: row.resource,
      limit: Number(row.limit),
      remaining: Number(row.remaining),
      resetAt: Date.parse(row.reset_at),
      observedAt: Date.parse(row.observed_at),
    })),
    memberships,
  };
}
