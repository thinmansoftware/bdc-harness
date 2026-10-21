/**
 * wo-lock.ts -- Exclusive active-cascade lock per WO + project.
 *
 * Admission by cascadeId alone does not stop two different cascadeIds from
 * racing the same WO (bdc-xo#1546). This lock is keyed by woId+project so a
 * second cascade cannot start while the first is still non-terminal.
 */

import { createHash, randomUUID } from 'crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  isCascadeLive,
  type CascadeLivenessOptions,
  type RunStatusReader,
} from './wo-lock-liveness.js';

export const LOCK_GRACE_MS = 120_000;
const DEFAULT_WO_LOCK_MAX_AGE_MS = 15_600_000;

export type WoLockStatus = 'running' | 'released';

export interface WoLockRecord {
  readonly woId: string;
  readonly project: string;
  readonly cascadeId: string;
  readonly status: WoLockStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly takenOverFrom?: string;
}

export interface AcquireWoLockResult {
  readonly acquired: boolean;
  readonly path: string;
  readonly record: WoLockRecord;
}

export interface WoLockDependencies {
  readonly apiBaseUrl?: string;
  readonly token?: string;
  readonly runStatusReader?: RunStatusReader;
}

export interface WoLockReconciliationResult {
  readonly scanned: number;
  readonly released: number;
  readonly keptLive: number;
  readonly keptUnknown: number;
}

function lockPath(outDir: string, woId: string, project: string): string {
  const digest = createHash('sha256').update(`${woId}\n${project}`).digest('hex').slice(0, 24);
  return join(outDir, 'wo-locks', `wo-${digest}.json`);
}

function maximumLockAgeMs(): number {
  const configured = Number(process.env.SMART_CAULDRON_WO_LOCK_MAX_AGE_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_WO_LOCK_MAX_AGE_MS;
}

function lockAgeMs(record: WoLockRecord): number {
  const updatedAt = Date.parse(record.updatedAt);
  return Number.isFinite(updatedAt) ? Math.max(0, Date.now() - updatedAt) : 0;
}

async function replaceLock(filePath: string, record: WoLockRecord): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(record, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(tempPath, filePath);
}

async function backupStaleLock(filePath: string, record: WoLockRecord): Promise<void> {
  await writeFile(
    `${filePath}.bak-stale-${record.cascadeId.slice(0, 8)}`,
    JSON.stringify(record, null, 2) + '\n',
    'utf8'
  );
}

function livenessOptions(outDir: string, deps: WoLockDependencies): CascadeLivenessOptions {
  return { outDir, ...deps };
}

export async function acquireWoLock(
  woId: string,
  project: string,
  cascadeId: string,
  outDir = './cascade-runs',
  deps: WoLockDependencies = {}
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
      await replaceLock(filePath, record);
      return { acquired: true, path: filePath, record };
    }
    if (existing.cascadeId === cascadeId) {
      return { acquired: true, path: filePath, record: existing };
    }
    const age = lockAgeMs(existing);
    const liveness = await isCascadeLive(existing.cascadeId, livenessOptions(outDir, deps));
    let reason: 'no-live-run' | 'max-age' | null = null;
    if (liveness === 'dead' && age >= LOCK_GRACE_MS) {
      reason = 'no-live-run';
    } else if (liveness === 'unknown' && age > maximumLockAgeMs()) {
      reason = 'max-age';
    }
    if (reason === null) return { acquired: false, path: filePath, record: existing };

    const takeover: WoLockRecord = { ...record, takenOverFrom: existing.cascadeId };
    await backupStaleLock(filePath, existing);
    await replaceLock(filePath, takeover);
    console.log(
      `[smart-cauldron] WO lock takeover woId=${woId} project=${project} ` +
        `staleCascadeId=${existing.cascadeId} newCascadeId=${cascadeId} ` +
        `reason=${reason} lockAgeMs=${String(age)}`
    );
    return { acquired: true, path: filePath, record: takeover };
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
    await replaceLock(filePath, released);
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

export async function reconcileStaleWoLocks(
  outDir: string,
  deps: WoLockDependencies = {}
): Promise<WoLockReconciliationResult> {
  const result = { scanned: 0, released: 0, keptLive: 0, keptUnknown: 0 };
  let names: string[];
  try {
    names = await readdir(join(outDir, 'wo-locks'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }

  for (const name of names) {
    if (!name.endsWith('.json') || name.includes('.bak-') || name.includes('.tmp')) continue;
    const filePath = join(outDir, 'wo-locks', name);
    let record: WoLockRecord;
    try {
      record = JSON.parse(await readFile(filePath, 'utf8')) as WoLockRecord;
      if (
        typeof record.woId !== 'string' ||
        typeof record.project !== 'string' ||
        typeof record.cascadeId !== 'string' ||
        (record.status !== 'running' && record.status !== 'released') ||
        typeof record.updatedAt !== 'string'
      ) {
        continue;
      }
    } catch {
      continue;
    }
    result.scanned++;
    if (record.status !== 'running') continue;

    const liveness = await isCascadeLive(record.cascadeId, livenessOptions(outDir, deps));
    if (liveness === 'live') {
      result.keptLive++;
      continue;
    }
    if (liveness === 'unknown') {
      result.keptUnknown++;
      continue;
    }
    await backupStaleLock(filePath, record);
    await releaseWoLock(record.woId, record.project, record.cascadeId, outDir);
    result.released++;
    console.log(
      `[smart-cauldron] startup released stale WO lock woId=${record.woId} cascadeId=${record.cascadeId}`
    );
  }
  return result;
}
