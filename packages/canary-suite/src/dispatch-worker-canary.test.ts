import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { chmod, mkdtemp, readFile, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DISPATCH_WORKER_HEARTBEAT_THRESHOLD_MS,
  runDispatchWorkerHeartbeatCheck,
} from './dispatch-worker-canary';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const WORKER = 'dispatch-worker-ASUS-ROG-DSK-2T';
const iso = (offsetMs: number): string => new Date(NOW - offsetMs).toISOString();

let dir = '';
let dbPath = '';

function makeDb(rows: [string, unknown][], path = dbPath): void {
  const db = new Database(path, { create: true });
  db.run(
    'CREATE TABLE agent_dispatch_workers (worker_id TEXT PRIMARY KEY, status TEXT, last_heartbeat_at)'
  );
  const insert = db.prepare(
    'INSERT INTO agent_dispatch_workers (worker_id, status, last_heartbeat_at) VALUES (?, ?, ?)'
  );
  for (const [id, hb] of rows) insert.run(id, 'available', hb as string | null);
  insert.finalize();
  db.close();
}

async function hash(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dispatch-canary-'));
  dbPath = join(dir, 'archon.db');
});

// Windows can hold a just-closed SQLite file for a moment; retry the cleanup.
async function removeDir(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

afterEach(async () => {
  await removeDir(dir);
});

describe('dispatch worker heartbeat freshness (selected source only)', () => {
  test.each([
    [599_000, 'passed'],
    [600_000, 'passed'],
    [601_000, 'failed'],
  ] as const)('age %d ms is %s (600000 ms is fresh, one more is stale)', async (age, verdict) => {
    makeDb([[WORKER, iso(age)]]);
    const r = await runDispatchWorkerHeartbeatCheck({
      dbPath,
      workerId: WORKER,
      now: () => NOW,
    });
    expect(r.verdict).toBe(verdict);
    expect(r.evidence.age_ms).toBe(age);
    expect(r.evidence.threshold_ms).toBe(DISPATCH_WORKER_HEARTBEAT_THRESHOLD_MS);
    if (verdict === 'failed') expect(r.reasonCodes).toEqual(['dispatch_worker_heartbeat_stale']);
  });

  test('time is compared numerically: same-day ISO data hours old is stale', async () => {
    // 00:00 and 12:00 on the same date compare as "equal prefixes" to a naive string compare
    makeDb([[WORKER, '2026-11-09T00:00:00.000Z']]);
    const r = await runDispatchWorkerHeartbeatCheck({ dbPath, workerId: WORKER, now: () => NOW });
    expect(r.verdict).toBe('failed');
    expect(r.reasonCodes).toEqual(['dispatch_worker_heartbeat_stale']);
    expect(r.evidence.age_ms).toBe(12 * 3600 * 1000);
  });

  test('a UTC offset is honored, not read as local time', async () => {
    // 07:55:00-05:00 is 12:55:00Z, which is 55 minutes AFTER now: a future timestamp
    makeDb([[WORKER, '2026-11-09T07:55:00-05:00']]);
    const r = await runDispatchWorkerHeartbeatCheck({ dbPath, workerId: WORKER, now: () => NOW });
    expect(r.verdict).toBe('failed');
    expect(r.reasonCodes).toEqual(['heartbeat_timestamp_in_future']);
  });

  test.each([
    ['empty string', ''],
    ['not a date', 'not-a-date'],
    ['null', null],
    ['a number', 1762689600],
    ['a bare SQLite datetime (no zone)', '2026-11-09 11:59:00'],
    ['a date with no time', '2026-11-09'],
  ])('%s never passes: it fails as an invalid timestamp', async (_label, value) => {
    makeDb([[WORKER, value]]);
    const r = await runDispatchWorkerHeartbeatCheck({ dbPath, workerId: WORKER, now: () => NOW });
    expect(r.verdict).toBe('failed');
    expect(r.reasonCodes).toEqual(['heartbeat_timestamp_invalid']);
  });

  test('a future timestamp fails closed', async () => {
    makeDb([[WORKER, iso(-1_000)]]);
    const r = await runDispatchWorkerHeartbeatCheck({ dbPath, workerId: WORKER, now: () => NOW });
    expect(r.verdict).toBe('failed');
    expect(r.reasonCodes).toEqual(['heartbeat_timestamp_in_future']);
  });

  test("another worker's fresh row never satisfies the selected worker", async () => {
    makeDb([
      ['dispatch-worker-OTHER', iso(1_000)],
      [WORKER, iso(3_600_000)],
    ]);
    const stale = await runDispatchWorkerHeartbeatCheck({
      dbPath,
      workerId: WORKER,
      now: () => NOW,
    });
    expect(stale.verdict).toBe('failed');
    expect(stale.evidence.age_ms).toBe(3_600_000);
    const missing = await runDispatchWorkerHeartbeatCheck({
      dbPath,
      workerId: 'dispatch-worker-NOT-THERE',
      now: () => NOW,
    });
    expect(missing.verdict).toBe('failed');
    expect(missing.reasonCodes).toEqual(['dispatch_worker_not_found']);
  });

  test('a missing database is blocked, never passed, and is not created by checking', async () => {
    const missingPath = join(dir, 'nope', 'archon.db');
    const r = await runDispatchWorkerHeartbeatCheck({
      dbPath: missingPath,
      workerId: WORKER,
      now: () => NOW,
    });
    expect(r.verdict).toBe('blocked');
    expect(r.reasonCodes).toEqual(['dispatch_worker_db_unreachable']);
    expect(existsSync(missingPath)).toBe(false);
    expect(existsSync(join(dir, 'nope'))).toBe(false);
  });

  test('a database without the worker table is blocked, never passed', async () => {
    const db = new Database(dbPath, { create: true });
    db.run('CREATE TABLE something_else (id INTEGER)');
    db.close();
    const r = await runDispatchWorkerHeartbeatCheck({ dbPath, workerId: WORKER, now: () => NOW });
    expect(r.verdict).toBe('blocked');
    expect(r.reasonCodes).toEqual(['dispatch_worker_db_unreachable']);
  });

  test('an injected database that throws is blocked, never passed', async () => {
    const r = await runDispatchWorkerHeartbeatCheck({
      workerId: WORKER,
      now: () => NOW,
      db: {
        query: () => {
          throw new Error('disk I/O error');
        },
      },
    });
    expect(r.verdict).toBe('blocked');
  });

  test('checking mutates nothing: the file bytes and mtime are unchanged, and a write-protected file still works', async () => {
    makeDb([[WORKER, iso(1_000)]]);
    await chmod(dbPath, 0o444);
    const before = { hash: await hash(dbPath), mtime: (await stat(dbPath)).mtimeMs };
    const r = await runDispatchWorkerHeartbeatCheck({ dbPath, workerId: WORKER, now: () => NOW });
    expect(r.verdict).toBe('passed');
    expect(await hash(dbPath)).toBe(before.hash);
    expect((await stat(dbPath)).mtimeMs).toBe(before.mtime);
    // no journal or wal sidecar appeared next to a read-only open
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-journal`)).toBe(false);
    await chmod(dbPath, 0o644);
  });

  test('a fresh row in ANY sqlite file passes the source check but never claims runtime health', async () => {
    // an unrelated, freshly made file: it must say what it did NOT assess
    makeDb([[WORKER, iso(500)]]);
    const r = await runDispatchWorkerHeartbeatCheck({ dbPath, workerId: WORKER, now: () => NOW });
    expect(r.verdict).toBe('passed');
    expect(r.evidence.assessment_scope).toBe('selected_source_heartbeat_freshness');
    expect(r.evidence.runtime_health).toBe('not_assessed');
    expect(r.evidenceRefs).toContain('runtime_health=not_assessed');
    expect(r.evidenceRefs).toContain('assessment_scope=selected_source_heartbeat_freshness');
    // every verdict carries the same scope, including failures
    const failed = await runDispatchWorkerHeartbeatCheck({
      dbPath,
      workerId: 'dispatch-worker-NOT-THERE',
      now: () => NOW,
    });
    expect(failed.evidence.runtime_health).toBe('not_assessed');
  });
});
