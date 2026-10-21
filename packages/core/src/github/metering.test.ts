import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { IDatabase, QueryResult } from '../db/adapters/types';
import {
  assertGitHubPoolAvailable,
  assertPersistedGitHubPoolAvailable,
  flushGitHubApiMeter,
  recordGitHubApiCall,
  resetGitHubApiMeterForTests,
  observationFromResponse,
  GitHubPoolBackoffError,
  serializeGitHubQuotaError,
  parseGitHubQuotaError,
} from './metering';
import { SqliteAdapter } from '../db/adapters/sqlite';

afterEach(resetGitHubApiMeterForTests);

it('serializes only allowlisted quota fields and rejects malformed or expired records', () => {
  const now = Date.now();
  const error = new GitHubPoolBackoffError('user-pat', 'core', now + 120_000);
  Object.assign(error, { token: 'synthetic-secret', body: 'synthetic-provider-body' });
  const line = serializeGitHubQuotaError(error, now)!;
  expect(line).not.toContain('synthetic');
  expect(parseGitHubQuotaError(line + '\n', now)).toEqual({
    version: 1,
    kind: 'pool_backoff',
    poolId: 'user-pat',
    resource: 'core',
    retryAtMs: now + 120_000,
  });
  const record = JSON.parse(line.split(':').slice(1).join(':'));
  const prefix = 'ARCHON_GITHUB_QUOTA_V1:';
  for (const value of [
    line + '\n' + line,
    'embedded ' + line,
    prefix + '{',
    prefix + JSON.stringify({ ...record, version: 2 }),
    prefix + JSON.stringify({ ...record, kind: 'quota_reset' }),
    prefix + JSON.stringify({ ...record, token: 'synthetic-secret' }),
    prefix + JSON.stringify({ ...record, resource: 'untrusted-header' }),
    prefix + JSON.stringify({ ...record, poolId: 'app-1-2\nsecret' }),
    prefix + JSON.stringify({ ...record, retryAtMs: now }),
    prefix + JSON.stringify({ ...record, retryAtMs: '123' }),
    prefix + JSON.stringify({ ...record, retryAtMs: Infinity }),
    prefix + JSON.stringify({ ...record, retryAtMs: now + 1.5 }),
    prefix + JSON.stringify({ ...record, retryAtMs: Number.MAX_SAFE_INTEGER + 1 }),
    line.replace('"version":1', '"version":1,"version":1'),
    line.replace('"poolId":', '"poolId": "user-pat", "poolId":'),
    undefined,
    Buffer.from(line),
  ])
    expect(parseGitHubQuotaError(value, now)).toBeUndefined();
  expect(
    parseGitHubQuotaError('runtime warning\n' + line + '\nmore runtime warnings', now)
  ).toEqual(parseGitHubQuotaError(line, now));
  for (const poolId of ['user-pat', 'merge-manager-pat', 'app-123-456']) {
    for (const resource of ['core', 'graphql', 'search', 'cli']) {
      expect(
        parseGitHubQuotaError(
          serializeGitHubQuotaError(
            new GitHubPoolBackoffError(poolId, resource, now + 120_000),
            now
          ),
          now
        )
      ).toMatchObject({ poolId, resource });
    }
  }
  expect(serializeGitHubQuotaError(new Error('synthetic-secret'), now)).toBeUndefined();
  expect(
    serializeGitHubQuotaError(new GitHubPoolBackoffError('invalid', 'core', now + 1), now)
  ).toBeUndefined();
  expect(
    serializeGitHubQuotaError(new GitHubPoolBackoffError('user-pat', 'core', now), now)
  ).toBeUndefined();
});

it('preserves typed backoff fields and messages across a fresh process cache', async () => {
  const db = new SqliteAdapter(':memory:');
  const retryAtMs = Math.floor(Date.now() / 1000) * 1000 + 120_000;
  try {
    recordGitHubApiCall({
      service: 'smart_cauldron',
      poolId: 'app-1-2',
      resource: 'core',
      status: 429,
      rateLimited: true,
      backoffUntil: retryAtMs,
    });
    let cached: unknown;
    try {
      assertGitHubPoolAvailable('app-1-2');
    } catch (error) {
      cached = error;
    }
    await flushGitHubApiMeter(db);
    resetGitHubApiMeterForTests();
    let persisted: unknown;
    try {
      await assertPersistedGitHubPoolAvailable('app-1-2', ['core'], db);
    } catch (error) {
      persisted = error;
    }
    for (const error of [cached, persisted]) {
      expect(error).toMatchObject({
        name: 'GitHubPoolBackoffError',
        poolId: 'app-1-2',
        resource: 'core',
        retryAtMs,
        message: `github_pool_backoff:app-1-2/core:${retryAtMs}`,
      });
    }
  } finally {
    await db.close();
  }
});

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
