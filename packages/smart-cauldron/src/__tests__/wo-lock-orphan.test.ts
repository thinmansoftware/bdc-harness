/**
 * wo-lock-orphan.test.ts -- WO-HARNESS-WO-LOCK-RELEASE-ON-CANCEL-01.
 *
 * Killing or cancelling a conductor run used to leave the smart-cauldron file
 * lock at status=running, so the next fire was refused as a duplicate and the
 * API cancel did not release it. These tests pin the two recovery paths:
 *   - stale-lock-reclaimed: a dead or silent owner's lock is taken over on acquire
 *   - cancel-releases-lock: cancelling a run releases the lock that run belongs to
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises';
import { hostname, tmpdir } from 'os';
import { join } from 'path';
import {
  acquireWoLock,
  assessWoLockStaleness,
  markSelfCancelOnWoLock,
  recordRunOnWoLock,
  releaseWoLock,
  releaseWoLocksForRun,
  touchWoLockHeartbeat,
} from '../wo-lock.js';
import type { WoLockRecord } from '../wo-lock.js';

const WO = 'WO-ORPHAN-01';
const PROJECT = 'shopops';
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeOutDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wo-lock-orphan-'));
  tempDirs.push(dir);
  return dir;
}

function lockFile(outDir: string): string {
  const digest = createHash('sha256').update(`${WO}\n${PROJECT}`).digest('hex').slice(0, 24);
  return join(outDir, 'wo-locks', `wo-${digest}.json`);
}

async function readLockFile(outDir: string): Promise<WoLockRecord> {
  return JSON.parse(await readFile(lockFile(outDir), 'utf8')) as WoLockRecord;
}

/** A pid that is not running: spawn a short process, let it exit, reuse its pid. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(['bun', '-e', '0']);
  await proc.exited;
  return proc.pid;
}

/** Write a lock file exactly as a prior (now dead) process would have left it. */
async function plantLock(
  outDir: string,
  overrides: Partial<WoLockRecord> & { cascadeId: string }
): Promise<void> {
  const when = new Date().toISOString();
  const record: WoLockRecord = {
    woId: WO,
    project: PROJECT,
    status: 'running',
    createdAt: when,
    updatedAt: when,
    ...overrides,
  };
  await acquireWoLock(WO, PROJECT, 'seed', outDir); // creates the wo-locks dir
  await writeFile(lockFile(outDir), JSON.stringify(record, null, 2));
}

describe('stale-lock-reclaimed', () => {
  test('lock whose same-host owner pid is dead is reclaimed on the next acquire', async () => {
    const outDir = await makeOutDir();
    await plantLock(outDir, {
      cascadeId: 'dead-cascade',
      pid: await deadPid(),
      host: hostname(),
      heartbeatAt: new Date().toISOString(), // fresh heartbeat: only the pid proves death
    });

    const next = await acquireWoLock(WO, PROJECT, 'new-cascade', outDir);
    expect(next.acquired).toBe(true);
    expect(next.reclaimedFrom).toBe('dead-cascade');
    expect(next.reclaimReason).toContain('is not running');
    expect(next.record.cascadeId).toBe('new-cascade');
    const onDisk = await readLockFile(outDir);
    expect(onDisk.cascadeId).toBe('new-cascade');
    expect(onDisk.status).toBe('running');
  });

  test('lock from another host with no heartbeat inside the stale window is reclaimed', async () => {
    const outDir = await makeOutDir();
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await plantLock(outDir, {
      cascadeId: 'silent-cascade',
      pid: process.pid, // alive here, but a different host so it is never probed
      host: 'some-other-host',
      heartbeatAt: old,
      updatedAt: old,
    });

    const next = await acquireWoLock(WO, PROJECT, 'new-cascade', outDir);
    expect(next.acquired).toBe(true);
    expect(next.reclaimedFrom).toBe('silent-cascade');
    expect(next.reclaimReason).toContain('no heartbeat');
  });

  test('legacy lock (no pid, no heartbeat) older than the stale window is reclaimed', async () => {
    const outDir = await makeOutDir();
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    await plantLock(outDir, { cascadeId: 'legacy-cascade', createdAt: old, updatedAt: old });

    const next = await acquireWoLock(WO, PROJECT, 'new-cascade', outDir);
    expect(next.acquired).toBe(true);
    expect(next.reclaimedFrom).toBe('legacy-cascade');
  });

  test('a live owner (own pid, fresh heartbeat) is NOT reclaimed', async () => {
    const outDir = await makeOutDir();
    const first = await acquireWoLock(WO, PROJECT, 'live-cascade', outDir);
    expect(first.record.pid).toBe(process.pid);
    expect(first.record.host).toBe(hostname());

    const second = await acquireWoLock(WO, PROJECT, 'other-cascade', outDir);
    expect(second.acquired).toBe(false);
    expect(second.reclaimedFrom).toBeUndefined();
    expect(second.record.cascadeId).toBe('live-cascade');
  });

  test('a fresh legacy lock (no pid, recent updatedAt) is NOT reclaimed', async () => {
    const outDir = await makeOutDir();
    await plantLock(outDir, { cascadeId: 'legacy-live' });
    const next = await acquireWoLock(WO, PROJECT, 'new-cascade', outDir);
    expect(next.acquired).toBe(false);
  });

  test('heartbeat touch refreshes the owner and refuses a non-owner', async () => {
    const outDir = await makeOutDir();
    await acquireWoLock(WO, PROJECT, 'live-cascade', outDir);
    const before = await readLockFile(outDir);
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(await touchWoLockHeartbeat(WO, PROJECT, 'live-cascade', outDir)).toBe(true);
    const after = await readLockFile(outDir);
    expect(Date.parse(after.heartbeatAt ?? '')).toBeGreaterThan(
      Date.parse(before.heartbeatAt ?? '')
    );
    expect(await touchWoLockHeartbeat(WO, PROJECT, 'intruder', outDir)).toBe(false);
  });

  test('assessWoLockStaleness: an alive pid on this host with a fresh heartbeat is not stale', () => {
    const now = new Date().toISOString();
    const verdict = assessWoLockStaleness({
      woId: WO,
      project: PROJECT,
      cascadeId: 'c',
      status: 'running',
      createdAt: now,
      updatedAt: now,
      pid: process.pid,
      host: hostname(),
      heartbeatAt: now,
    });
    expect(verdict.stale).toBe(false);
  });
});

describe('cancel-releases-lock', () => {
  test('cancelling a run releases the lock that run belongs to, and the next fire acquires', async () => {
    const outDir = await makeOutDir();
    await acquireWoLock(WO, PROJECT, 'cascade-a', outDir);
    await recordRunOnWoLock(WO, PROJECT, 'cascade-a', 'run-111', outDir);

    // Without the cancel the lock still refuses the next fire.
    const refused = await acquireWoLock(WO, PROJECT, 'cascade-b', outDir);
    expect(refused.acquired).toBe(false);

    const released = await releaseWoLocksForRun('run-111', outDir);
    expect(released).toEqual([WO]);
    expect((await readLockFile(outDir)).status).toBe('released');

    const next = await acquireWoLock(WO, PROJECT, 'cascade-b', outDir);
    expect(next.acquired).toBe(true);
    expect(next.record.cascadeId).toBe('cascade-b');
  });

  test('cancelling an unrelated run releases nothing', async () => {
    const outDir = await makeOutDir();
    await acquireWoLock(WO, PROJECT, 'cascade-a', outDir);
    await recordRunOnWoLock(WO, PROJECT, 'cascade-a', 'run-111', outDir);
    expect(await releaseWoLocksForRun('run-999', outDir)).toEqual([]);
    const still = await acquireWoLock(WO, PROJECT, 'cascade-b', outDir);
    expect(still.acquired).toBe(false);
  });

  test('a run the owner marked as its own stall-cancel does not release the lock', async () => {
    const outDir = await makeOutDir();
    await acquireWoLock(WO, PROJECT, 'cascade-a', outDir);
    await recordRunOnWoLock(WO, PROJECT, 'cascade-a', 'run-111', outDir);
    await markSelfCancelOnWoLock(WO, PROJECT, 'cascade-a', 'run-111', outDir);

    expect(await releaseWoLocksForRun('run-111', outDir)).toEqual([]);
    const still = await acquireWoLock(WO, PROJECT, 'cascade-b', outDir);
    expect(still.acquired).toBe(false);
  });

  test('release with no lock directory is a no-op', async () => {
    const outDir = await makeOutDir();
    expect(await releaseWoLocksForRun('run-111', outDir)).toEqual([]);
  });

  test('runs are recorded once and only by the owning cascade', async () => {
    const outDir = await makeOutDir();
    await acquireWoLock(WO, PROJECT, 'cascade-a', outDir);
    await recordRunOnWoLock(WO, PROJECT, 'cascade-a', 'run-111', outDir);
    await recordRunOnWoLock(WO, PROJECT, 'cascade-a', 'run-111', outDir);
    await recordRunOnWoLock(WO, PROJECT, 'intruder', 'run-222', outDir);
    expect((await readLockFile(outDir)).runIds).toEqual(['run-111']);
  });
});

describe('exclusive takeover (Overseer review of the earlier stale-recovery PRs)', () => {
  test('eight concurrent acquires of a dead-owner lock yield exactly one owner', async () => {
    const outDir = await makeOutDir();
    await plantLock(outDir, {
      cascadeId: 'dead-cascade',
      pid: await deadPid(),
      host: hostname(),
      heartbeatAt: new Date().toISOString(),
    });

    const ids = Array.from({ length: 8 }, (_, i) => `racer-${i}`);
    const results = await Promise.all(ids.map(id => acquireWoLock(WO, PROJECT, id, outDir)));

    const winners = results.map((r, i) => (r.acquired ? ids[i] : null)).filter(Boolean);
    expect(winners).toHaveLength(1);
    expect((await readLockFile(outDir)).cascadeId).toBe(winners[0] as string);
    // Every loser was told who holds the lock now.
    for (const r of results.filter(r => !r.acquired)) {
      expect(r.record.cascadeId).toBe(winners[0] as string);
    }
  });

  test('eight concurrent acquires of a released lock yield exactly one owner', async () => {
    const outDir = await makeOutDir();
    await acquireWoLock(WO, PROJECT, 'first', outDir);
    await releaseWoLock(WO, PROJECT, 'first', outDir);

    const ids = Array.from({ length: 8 }, (_, i) => `racer-${i}`);
    const results = await Promise.all(ids.map(id => acquireWoLock(WO, PROJECT, id, outDir)));
    expect(results.filter(r => r.acquired)).toHaveLength(1);
  });

  test('a delayed caller cannot overwrite a lock that was just taken over and is live', async () => {
    const outDir = await makeOutDir();
    await plantLock(outDir, {
      cascadeId: 'dead-cascade',
      pid: await deadPid(),
      host: hostname(),
      heartbeatAt: new Date().toISOString(),
    });
    const first = await acquireWoLock(WO, PROJECT, 'fast', outDir);
    expect(first.acquired).toBe(true);
    const late = await acquireWoLock(WO, PROJECT, 'late', outDir);
    expect(late.acquired).toBe(false);
    expect((await readLockFile(outDir)).cascadeId).toBe('fast');
  });

  test('a mutex file abandoned by a dead process does not wedge acquisition', async () => {
    const outDir = await makeOutDir();
    await acquireWoLock(WO, PROJECT, 'first', outDir);
    await releaseWoLock(WO, PROJECT, 'first', outDir);
    const mutex = `${lockFile(outDir)}.mutex`;
    await writeFile(mutex, '99999\n');
    const old = new Date(Date.now() - 60_000);
    await utimes(mutex, old, old);

    const next = await acquireWoLock(WO, PROJECT, 'second', outDir);
    expect(next.acquired).toBe(true);
    expect(next.record.cascadeId).toBe('second');
  });
});
