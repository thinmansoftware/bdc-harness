/**
 * wo-lock.test.ts -- exclusive active-cascade lock per WO+project.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireWoLock, releaseWoLock } from '../wo-lock.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeOutDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wo-lock-'));
  tempDirs.push(dir);
  return dir;
}

describe('wo-lock', () => {
  test('second cascade for same WO is refused while first is running', async () => {
    const outDir = await makeOutDir();
    const first = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    expect(first.acquired).toBe(true);

    const second = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-b', outDir);
    expect(second.acquired).toBe(false);
    expect(second.record.cascadeId).toBe('cascade-a');
  });

  test('same cascadeId can re-acquire', async () => {
    const outDir = await makeOutDir();
    await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    const again = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    expect(again.acquired).toBe(true);
  });

  test('release allows a new cascade', async () => {
    const outDir = await makeOutDir();
    await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    await releaseWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    const next = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-b', outDir);
    expect(next.acquired).toBe(true);
    expect(next.record.cascadeId).toBe('cascade-b');
  });

  test('different WOs do not contend', async () => {
    const outDir = await makeOutDir();
    const a = await acquireWoLock('WO-LOCK-01', 'shopops', 'cascade-a', outDir);
    const b = await acquireWoLock('WO-LOCK-02', 'shopops', 'cascade-b', outDir);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });
});
