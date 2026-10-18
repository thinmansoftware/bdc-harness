import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { removeTempDirWithRetry } from '../test/temp-dir';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import { clearOperatorSetting, getOperatorSetting, setOperatorSetting } from './operator-settings';

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

describe('operator settings (sqlite)', () => {
  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    currentHome = join(
      import.meta.dir,
      `.test-operator-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

  test('get of a missing key is null', async () => {
    expect(await getOperatorSetting('fuelglass.seat_cutoff_percent')).toBeNull();
  });

  test('set then get returns value, updated_by, reason, and an ISO updated_at', async () => {
    await setOperatorSetting('fuelglass.seat_cutoff_percent', '95', 'operator-token', 'quota fix');
    const row = await getOperatorSetting('fuelglass.seat_cutoff_percent');
    expect(row).not.toBeNull();
    expect(row?.setting_key).toBe('fuelglass.seat_cutoff_percent');
    expect(row?.setting_value).toBe('95');
    expect(row?.updated_by).toBe('operator-token');
    expect(row?.reason).toBe('quota fix');
    expect(row?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(row?.updated_at ?? '').toISOString()).toBe(row?.updated_at);
  });

  test('a second set of the same key leaves one row', async () => {
    await setOperatorSetting('fuelglass.seat_cutoff_percent', '95', 'operator-token', 'first');
    await setOperatorSetting('fuelglass.seat_cutoff_percent', '80', 'operator-token', 'second');
    const rows = await getDatabase().query<{ setting_key: string; setting_value: string }>(
      'SELECT setting_key, setting_value FROM operator_settings'
    );
    expect(rows.rows).toEqual([
      { setting_key: 'fuelglass.seat_cutoff_percent', setting_value: '80' },
    ]);
    const row = await getOperatorSetting('fuelglass.seat_cutoff_percent');
    expect(row?.reason).toBe('second');
    expect(row?.updated_by).toBe('operator-token');
  });

  test('clear removes the row and clearing a missing key does not throw', async () => {
    await setOperatorSetting('fuelglass.seat_cutoff_percent', '95', 'operator-token', null);
    await clearOperatorSetting('fuelglass.seat_cutoff_percent');
    expect(await getOperatorSetting('fuelglass.seat_cutoff_percent')).toBeNull();
    await expect(clearOperatorSetting('fuelglass.seat_cutoff_percent')).resolves.toBeUndefined();
  });
});
