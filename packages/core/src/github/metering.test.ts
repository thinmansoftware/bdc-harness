import { beforeEach, describe, expect, it } from 'bun:test';
import type { IDatabase, QueryResult } from '../db/adapters/types';
import {
  assertGitHubPoolAvailable,
  flushGitHubApiMeter,
  recordGitHubApiCall,
  resetGitHubApiMeterForTests,
} from './metering';

describe('Test 3 and Test 6: pool isolation and batched metering', () => {
  beforeEach(resetGitHubApiMeterForTests);

  it('isolates backoff by pool and resource', () => {
    recordGitHubApiCall({
      service: 'taskmaster',
      poolId: 'app-y',
      resource: 'core',
      status: 403,
      rateLimited: true,
      reset: Math.floor(Date.now() / 1000) + 60,
    });
    expect(() => assertGitHubPoolAvailable('app-y', 'core')).toThrow('app-y/core');
    expect(() => assertGitHubPoolAvailable('app-x', 'core')).not.toThrow();
    expect(() => assertGitHubPoolAvailable('app-y', 'search')).not.toThrow();
  });

  it('flushes aggregates and independent resource state without HTTP', async () => {
    const writes: { sql: string; params?: unknown[] }[] = [];
    const query = async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
      writes.push({ sql, params });
      return { rows: [], rowCount: 1 };
    };
    const db = {
      dialect: 'postgres',
      query,
      withTransaction: async <T>(fn: Parameters<IDatabase['withTransaction']>[0]) => fn(query),
      close: async () => undefined,
    } as IDatabase;
    for (let i = 0; i < 10; i += 1)
      recordGitHubApiCall({
        service: i < 5 ? 'taskmaster' : 'overseer',
        poolId: i < 5 ? 'app-y' : 'app-x',
        resource: i === 9 ? 'search' : 'core',
        status: i < 2 ? 403 : 200,
        rateLimited: i < 2,
        limit: 15000,
        remaining: 14000 - i,
        reset: 123,
        observedAt: 1_700_000_000_000 + i,
      });
    await flushGitHubApiMeter(db);
    expect(writes.filter(write => write.sql.includes('github_api_usage'))).toHaveLength(3);
    expect(writes.filter(write => write.sql.includes('github_api_pool_state'))).toHaveLength(3);
    expect(JSON.stringify(writes)).not.toContain('token');
  });
});
