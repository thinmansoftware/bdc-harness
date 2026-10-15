import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { IDatabase, QueryResult } from '../db/adapters/types';
import {
  assertGitHubPoolAvailable,
  assertPersistedGitHubPoolAvailable,
  flushGitHubApiMeter,
  recordGitHubApiCall,
  resetGitHubApiMeterForTests,
  observationFromResponse,
} from './metering';
import { SqliteAdapter } from '../db/adapters/sqlite';

afterEach(resetGitHubApiMeterForTests);

it('concurrent flushes retain calls arriving during a transaction exactly once', async () => {
  resetGitHubApiMeterForTests();
  const persisted: number[] = [];
  let release: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => {
    release = resolve;
  });
  let transactions = 0;
  const query = async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
    if (sql.includes('github_api_usage')) persisted.push(Number(params?.[4]));
    return { rows: [], rowCount: 1 };
  };
  const db = {
    query,
    withTransaction: async (fn: Parameters<IDatabase['withTransaction']>[0]) => {
      transactions += 1;
      if (transactions === 1) await blocked;
      return fn(query);
    },
  } as IDatabase;
  const observation = {
    service: 'overseer' as const,
    poolId: 'app',
    resource: 'core',
    status: 200,
  };
  recordGitHubApiCall(observation);
  const first = flushGitHubApiMeter(db);
  recordGitHubApiCall(observation);
  const second = flushGitHubApiMeter(db);
  expect(transactions).toBe(1);
  release?.();
  await Promise.all([first, second]);
  expect(persisted).toEqual([1, 1]);
  expect(transactions).toBe(2);
});

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
    expect(writes.filter(write => write.sql.includes('github_api_pool_state'))).toHaveLength(4);
    expect(JSON.stringify(writes)).not.toContain('token');
  });
});

it('a fresh process sees secondary backoff without corrupting measured quota or blocking other pools', async () => {
  const db = new SqliteAdapter(':memory:');
  try {
    const observation = observationFromResponse(
      'run_nodes',
      'shared-app',
      new Response(null, {
        status: 429,
        headers: {
          'retry-after': '60',
          'x-ratelimit-resource': 'graphql',
          'x-ratelimit-remaining': '99',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      })
    );
    recordGitHubApiCall(observation);
    await flushGitHubApiMeter(db);
    resetGitHubApiMeterForTests();
    const measured = await db.query<{ remaining: number }>(
      'SELECT remaining FROM github_api_pool_state WHERE pool_id = $1 AND resource = $2',
      ['shared-app', 'graphql']
    );
    expect(measured.rows[0]?.remaining).toBe(99);
    let refused: unknown;
    try {
      await assertPersistedGitHubPoolAvailable('shared-app', ['graphql'], db);
    } catch (error) {
      refused = error;
    }
    expect(String(refused)).toContain('github_pool_backoff');
    await assertPersistedGitHubPoolAvailable('different-app', ['graphql'], db);
    await assertPersistedGitHubPoolAvailable('shared-app', ['core'], db);
    await assertPersistedGitHubPoolAvailable(
      'shared-app',
      ['graphql'],
      db,
      observation.backoffUntil! + 1
    );
  } finally {
    await db.close();
  }
});
