import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IDatabase, QueryResult } from '../db/adapters/types';
import {
  assertGitHubPoolAvailable,
  assertPersistedGitHubPoolAvailable,
  flushGitHubApiMeter,
  ingestLaneGitHubMeterSpool,
  recordGitHubApiCall,
  resetGitHubApiMeterForTests,
  observationFromResponse,
  writeLaneMeterObservation,
} from './metering';
import { resolveServiceGitHubAuth } from './service-identity';
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

describe('lane meter spool', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'lane-meter-spool-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('stamps server run_nodes identity and ignores lane service and pool id', async () => {
    const identity = resolveServiceGitHubAuth('run_nodes');
    const db = new SqliteAdapter(':memory:');
    try {
      writeLaneMeterObservation(
        {
          service: 'smart_cauldron',
          poolId: 'lane-selected-pool',
          resource: 'graphql',
          status: 201,
        },
        directory
      );
      const written = readdirSync(directory);
      expect(written).toHaveLength(1);
      const body = JSON.parse(readFileSync(join(directory, written[0] ?? ''), 'utf8')) as {
        service?: string;
        poolId?: string;
      };
      expect(body.service).toBeUndefined();
      expect(body.poolId).toBeUndefined();
      writeFileSync(
        join(directory, '4-5-abcd.json'),
        JSON.stringify({
          v: 1,
          service: 'overseer',
          poolId: 'lane-selected-pool',
          resource: 'core',
          status: 200,
          calls: 99999,
        })
      );
      writeFileSync(
        join(directory, 'not-a-spool-name.json'),
        JSON.stringify({ v: 1, resource: 'core', status: 200 })
      );
      const secret = join(directory, 'secret');
      if (process.platform !== 'win32') {
        writeFileSync(secret, 'SECRET-BYTES', { mode: 0o600 });
        symlinkSync(secret, join(directory, '9-9-abc.json'));
      }

      const ingested = await ingestLaneGitHubMeterSpool(db, directory);
      expect(ingested).toBe(2);
      const usage = await db.query<{
        service: string;
        pool_id: string;
        resource: string;
        calls: number;
      }>('SELECT service, pool_id, resource, calls FROM github_api_usage');
      expect(usage.rows.every(row => row.service === 'run_nodes')).toBe(true);
      expect(usage.rows.every(row => row.pool_id === identity.poolId)).toBe(true);
      expect(usage.rows.some(row => row.pool_id === 'lane-selected-pool')).toBe(false);
      expect(usage.rows.some(row => row.service === 'overseer')).toBe(false);
      expect(usage.rows.reduce((sum, row) => sum + row.calls, 0)).toBe(2);
      if (process.platform !== 'win32') {
        expect(readFileSync(secret, 'utf8')).toBe('SECRET-BYTES');
        expect(existsSync(join(directory, '9-9-abc.json'))).toBe(false);
      }
      expect(existsSync(join(directory, 'not-a-spool-name.json'))).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('does not follow a symlink used as the spool directory', async () => {
    if (process.platform === 'win32') return;
    const outside = mkdtempSync(join(tmpdir(), 'lane-meter-outside-'));
    const link = join(directory, 'linked-spool');
    const db = new SqliteAdapter(':memory:');
    try {
      writeFileSync(
        join(outside, '1-2-abc.json'),
        JSON.stringify({
          v: 1,
          service: 'overseer',
          poolId: 'lane-selected-pool',
          resource: 'core',
          status: 200,
        })
      );
      symlinkSync(outside, link);
      expect(await ingestLaneGitHubMeterSpool(db, link)).toBe(0);
      const usage = await db.query<{ calls: number }>('SELECT calls FROM github_api_usage');
      expect(usage.rows).toEqual([]);
      expect(existsSync(join(outside, '1-2-abc.json'))).toBe(true);
    } finally {
      await db.close();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps spool files when the database write fails and retries them once', async () => {
    const db = new SqliteAdapter(':memory:');
    const name = '11-22-abc.json';
    writeFileSync(join(directory, name), JSON.stringify({ v: 1, resource: 'core', status: 200 }));
    const failing = {
      query: db.query.bind(db),
      withTransaction: async () => {
        throw new Error('database_unavailable');
      },
    } as IDatabase;
    let refused: unknown;
    try {
      await ingestLaneGitHubMeterSpool(failing, directory);
    } catch (error) {
      refused = error;
    }
    expect(String(refused)).toContain('database_unavailable');
    expect(existsSync(join(directory, name))).toBe(true);
    expect(await ingestLaneGitHubMeterSpool(db, directory)).toBe(1);
    expect(existsSync(join(directory, name))).toBe(false);
    expect(await ingestLaneGitHubMeterSpool(db, directory)).toBe(0);
    const usage = await db.query<{ calls: number }>('SELECT calls FROM github_api_usage');
    expect(usage.rows).toEqual([{ calls: 1 }]);
    await db.close();
  });

  it('serializes overlapping ingests so one spool file is counted once', async () => {
    writeFileSync(
      join(directory, '7-8-def.json'),
      JSON.stringify({ v: 1, resource: 'cli', status: 0 })
    );
    let release: (() => void) | undefined;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    let transactions = 0;
    const inserts: string[] = [];
    const query = async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
      if (sql.includes('github_api_usage')) inserts.push(String(params?.[1]));
      return { rows: [], rowCount: 1 };
    };
    const db = {
      query,
      withTransaction: async (fn: Parameters<IDatabase['withTransaction']>[0]) => {
        transactions += 1;
        entered?.();
        if (transactions === 1) await blocked;
        return fn(query);
      },
    } as IDatabase;
    const first = ingestLaneGitHubMeterSpool(db, directory);
    const second = ingestLaneGitHubMeterSpool(db, directory);
    await started;
    expect(transactions).toBe(1);
    release?.();
    expect(await first).toBe(1);
    expect(await second).toBe(0);
    expect(transactions).toBe(1);
    expect(inserts).toEqual(['run_nodes']);
  });
});
