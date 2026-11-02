/**
 * wo-lock.ts -- Exclusive active-cascade lock per WO + project.
 *
 * Admission by cascadeId alone does not stop two different cascadeIds from
 * racing the same WO (bdc-xo#1546). This lock is keyed by woId+project so a
 * second cascade cannot start while the first is still non-terminal.
 */

import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { join } from 'path';

export type WoLockStatus = 'running' | 'released';

export interface WoLockRecord {
  readonly woId: string;
  readonly project: string;
  readonly cascadeId: string;
  readonly status: WoLockStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AcquireWoLockResult {
  readonly acquired: boolean;
  readonly path: string;
  readonly record: WoLockRecord;
}

function lockPath(outDir: string, woId: string, project: string): string {
  const digest = createHash('sha256').update(`${woId}\n${project}`).digest('hex').slice(0, 24);
  return join(outDir, 'wo-locks', `wo-${digest}.json`);
}

export async function acquireWoLock(
  woId: string,
  project: string,
  cascadeId: string,
  outDir = './cascade-runs'
): Promise<AcquireWoLockResult> {
  const filePath = lockPath(outDir, woId, project);
  await mkdir(join(outDir, 'wo-locks'), { recursive: true });
  const now = new Date().toISOString();
  const record: WoLockRecord = {
    woId,
    project,
    cascadeId,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  };

  try {
    await writeFile(filePath, JSON.stringify(record, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
    return { acquired: true, path: filePath, record };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(filePath, 'utf8')) as WoLockRecord;
    if (existing.status !== 'running') {
      // Stale/released lock -- take over with a replace.
      const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tempPath, JSON.stringify(record, null, 2) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
      });
      await rename(tempPath, filePath);
      return { acquired: true, path: filePath, record };
    }
    if (existing.cascadeId === cascadeId) {
      return { acquired: true, path: filePath, record: existing };
    }
    return { acquired: false, path: filePath, record: existing };
  }
}

export async function releaseWoLock(
  woId: string,
  project: string,
  cascadeId: string,
  outDir = './cascade-runs'
): Promise<void> {
  const filePath = lockPath(outDir, woId, project);
  try {
    const existing = JSON.parse(await readFile(filePath, 'utf8')) as WoLockRecord;
    if (existing.cascadeId !== cascadeId) return;
    const released: WoLockRecord = {
      ...existing,
      status: 'released',
      updatedAt: new Date().toISOString(),
    };
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(released, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(tempPath, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    // Best-effort release -- never fail the cascade on lock cleanup.
    try {
      await unlink(filePath);
    } catch {
      /* ignore */
    }
  }
}
