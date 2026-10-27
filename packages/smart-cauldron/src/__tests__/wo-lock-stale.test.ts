import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireWoLock, reconcileStaleWoLocks, type WoLockRecord } from '../wo-lock.js';
import type { RunStatusReader } from '../wo-lock-liveness.js';

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.SMART_CAULDRON_WO_LOCK_MAX_AGE_MS;
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeOutDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wo-lock-stale-'));
  tempDirs.push(dir);
  return dir;
}

async function createLock(
  outDir: string,
  woId: string,
  project: string,
  cascadeId: string,
  ageMs: number,
  status: 'running' | 'released' = 'running'
): Promise<{ path: string; record: WoLockRecord }> {
  const acquired = await acquireWoLock(woId, project, cascadeId, outDir);
  const timestamp = new Date(Date.now() - ageMs).toISOString();
  const record: WoLockRecord = {
    ...acquired.record,
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await writeFile(acquired.path, JSON.stringify(record, null, 2) + '\n');
  return { path: acquired.path, record };
}

async function createCascadeRecord(
  outDir: string,
  cascadeId: string,
  runId: string
): Promise<void> {
  const dir = join(outDir, `record-${cascadeId}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'cascade-record.json'),
    JSON.stringify({ cascadeId, attempts: [{ runId }] }, null, 2) + '\n'
  );
}

const statusReader =
  (status: string): RunStatusReader =>
  async () => ({ status });

describe('stale WO locks', () => {
  test('dead cascade is taken over after grace', async () => {
    const outDir = await makeOutDir();
    await createLock(outDir, 'WO-T', 'proj', 'C-OLD', 600_000);
    await createCascadeRecord(outDir, 'C-OLD', 'R1');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      const result = await acquireWoLock('WO-T', 'proj', 'C-NEW', outDir, {
        runStatusReader: statusReader('escalated'),
      });
      expect(result.acquired).toBe(true);
      expect(result.record.cascadeId).toBe('C-NEW');
      expect(result.record.takenOverFrom).toBe('C-OLD');
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('reason=no-live-run');
    } finally {
      console.log = originalLog;
    }
  });

  test('live statuses are not stolen', async () => {
    for (const status of ['running', 'paused', 'pending']) {
      const outDir = await makeOutDir();
      const lock = await createLock(outDir, 'WO-T', `proj-${status}`, 'C-OLD', 600_000);
      await createCascadeRecord(outDir, 'C-OLD', 'R1');
      const before = await readFile(lock.path, 'utf8');
      const result = await acquireWoLock('WO-T', `proj-${status}`, 'C-NEW', outDir, {
        runStatusReader: statusReader(status),
      });
      expect(result.acquired).toBe(false);
      expect(result.record.cascadeId).toBe('C-OLD');
      expect(await readFile(lock.path, 'utf8')).toBe(before);
    }
  });

  test('maximum age takes over without a successful liveness read', async () => {
    const outDir = await makeOutDir();
    process.env.SMART_CAULDRON_WO_LOCK_MAX_AGE_MS = '1000';
    await createLock(outDir, 'WO-T', 'proj', 'C-OLD', 2_000);
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      const result = await acquireWoLock('WO-T', 'proj', 'C-NEW', outDir, {
        runStatusReader: async () => {
          throw new Error('network failure');
        },
      });
      expect(result.acquired).toBe(true);
      expect(logs[0]).toContain('reason=max-age');
    } finally {
      console.log = originalLog;
    }
  });

  test('unknown status fails closed below maximum age', async () => {
    const outDir = await makeOutDir();
    await createLock(outDir, 'WO-T', 'proj', 'C-OLD', 600_000);
    await createCascadeRecord(outDir, 'C-OLD', 'R1');
    const result = await acquireWoLock('WO-T', 'proj', 'C-NEW', outDir, {
      runStatusReader: async () => {
        throw new Error('network failure');
      },
    });
    expect(result.acquired).toBe(false);
  });

  test('grace window protects a lock without a cascade record', async () => {
    const outDir = await makeOutDir();
    await createLock(outDir, 'WO-T', 'proj', 'C-OLD', 30_000);
    const result = await acquireWoLock('WO-T', 'proj', 'C-NEW', outDir);
    expect(result.acquired).toBe(false);
  });

  test('startup reconciliation releases only a dead running lock', async () => {
    const outDir = await makeOutDir();
    const dead = await createLock(outDir, 'WO-A', 'proj', 'C-DEAD', 600_000);
    const live = await createLock(outDir, 'WO-B', 'proj', 'C-LIVE', 600_000);
    const released = await createLock(outDir, 'WO-C', 'proj', 'C-DONE', 600_000, 'released');
    await createCascadeRecord(outDir, 'C-DEAD', 'R-DEAD');
    await createCascadeRecord(outDir, 'C-LIVE', 'R-LIVE');
    await writeFile(`${dead.path}.bak-stale-x`, '{}\n');
    await writeFile(join(outDir, 'wo-locks', 'ignored.tmp'), '{}\n');

    const result = await reconcileStaleWoLocks(outDir, {
      runStatusReader: async runId => ({ status: runId === 'R-DEAD' ? 'failed' : 'running' }),
    });
    expect(result).toEqual({ scanned: 3, released: 1, keptLive: 1, keptUnknown: 0 });
    expect(JSON.parse(await readFile(dead.path, 'utf8')).status).toBe('released');
    expect(JSON.parse(await readFile(live.path, 'utf8')).status).toBe('running');
    expect(JSON.parse(await readFile(released.path, 'utf8')).status).toBe('released');
  });

  test('takeover writes a backup containing the old record', async () => {
    const outDir = await makeOutDir();
    const lock = await createLock(outDir, 'WO-T', 'proj', 'C-OLD-LONG', 600_000);
    await createCascadeRecord(outDir, 'C-OLD-LONG', 'R1');
    await acquireWoLock('WO-T', 'proj', 'C-NEW', outDir, {
      runStatusReader: statusReader('failed'),
    });
    const backup = JSON.parse(await readFile(`${lock.path}.bak-stale-C-OLD-LO`, 'utf8'));
    expect(backup.cascadeId).toBe('C-OLD-LONG');
  });
});
