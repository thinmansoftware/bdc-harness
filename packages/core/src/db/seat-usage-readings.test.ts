import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { removeTempDirWithRetry } from '../test/temp-dir';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import { getLatestSeatUsageReading, upsertSeatUsageReading } from './seat-usage-readings';

let currentDbPath = '';
let currentHome = '';
const oldArchonHome = process.env.ARCHON_HOME;
const oldDatabaseUrl = process.env.DATABASE_URL;

function cleanupDb(path: string): void {
  if (!path) return;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // File may not exist.
    }
  }
}

describe('seat usage readings (sqlite)', () => {
  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    currentHome = join(
      import.meta.dir,
      `.test-seat-usage-readings-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    currentDbPath = join(currentHome, 'archon.db');
    process.env.ARCHON_HOME = currentHome;
    delete process.env.DATABASE_URL;
    getDatabase();
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    cleanupDb(currentDbPath);
    if (currentHome) removeTempDirWithRetry(currentHome);
    if (oldArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = oldArchonHome;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
  });

  test('cursor upserts leave one row and the second observed_at survives reopen', async () => {
    await upsertSeatUsageReading({
      seat: 'cursor',
      used_percent: 10,
      remaining_percent: 90,
      resets_at: '2026-11-13T16:33:08.000Z',
      observed_at: '2026-10-27T12:00:00.000Z',
      source: 'desktop-fuelglass',
    });
    await upsertSeatUsageReading({
      seat: 'cursor',
      used_percent: 35.28,
      remaining_percent: 64.72,
      resets_at: '2026-11-13T16:33:08.000Z',
      observed_at: '2026-10-27T13:05:11.000Z',
      source: 'desktop-fuelglass',
    });

    const rows = await getDatabase().query<{ seat: string; observed_at: string }>(
      'SELECT seat, observed_at FROM seat_usage_readings'
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.seat).toBe('cursor');

    const latest = await getLatestSeatUsageReading('cursor');
    expect(latest?.observed_at).toBe('2026-10-27T13:05:11.000Z');
    expect(latest?.used_percent).toBe(35.28);
    expect(latest?.remaining_percent).toBe(64.72);
    expect(latest?.source).toBe('desktop-fuelglass');
    expect(latest?.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    await closeDatabase();
    resetDatabase();
    const reopened = await getLatestSeatUsageReading('cursor');
    expect(reopened).toEqual(latest);
    expect(await getLatestSeatUsageReading('claude')).toBeNull();
  });
});
