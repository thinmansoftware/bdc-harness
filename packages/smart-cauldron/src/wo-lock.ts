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
import { createLogger } from '@archon/paths';

const log = createLogger('smart-cauldron/wo-lock');
const MUTATION_WAIT_MS = 2000;

/** Short cross-process metadata mutex. An abandoned guard requires reconciliation. */
async function withMutationGuard<T>(filePath: string, mutate: () => Promise<T>): Promise<T> {
  const guardPath = `${filePath}.mutation-guard`;
  const deadline = performance.now() + MUTATION_WAIT_MS;
  for (;;) {
    try {
      await writeFile(guardPath, '', { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (performance.now() >= deadline) throw new Error('smart_cauldron_wo_lock_busy');
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    return await mutate();
  } finally {
    try {
      await unlink(guardPath);
    } catch {
      log.warn('smart_cauldron.wo_lock_guard_cleanup_failed');
    }
  }
}

async function readValidatedLock(
  filePath: string,
  woId: string,
  project: string
): Promise<WoLockRecord> {
  const record = JSON.parse(await readFile(filePath, 'utf8')) as WoLockRecord;
  if (
    record?.woId !== woId ||
    record.project !== project ||
    typeof record.cascadeId !== 'string' ||
    !record.cascadeId.trim() ||
    !['running', 'released'].includes(record.status) ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    (record.executionToken !== undefined &&
      (typeof record.executionToken !== 'string' || !record.executionToken.trim()))
  )
    throw new Error('smart_cauldron_wo_lock_unknown');
  return record;
}

export type WoLockStatus = 'running' | 'released';

export interface WoLockRecord {
  readonly woId: string;
  readonly project: string;
  readonly cascadeId: string;
  readonly status: WoLockStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly executionToken?: string;
}

export interface AcquireWoLockResult {
  readonly acquired: boolean;
  readonly path: string;
  readonly record: WoLockRecord;
  /** Nonempty only for the fresh execution owner; null is a read-only same-ID replay. */
  readonly executionToken?: string | null;
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
  const executionToken = randomUUID();
  const record: WoLockRecord = {
    woId,
    project,
    cascadeId,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    executionToken,
  };

  return withMutationGuard(filePath, async () => {
    try {
      await writeFile(filePath, JSON.stringify(record, null, 2) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
      });
      return { acquired: true, path: filePath, record, executionToken };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readValidatedLock(filePath, woId, project);
      if (existing.status === 'released') {
        // Stale/released lock -- take over with a replace.
        const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(tempPath, JSON.stringify(record, null, 2) + '\n', {
          encoding: 'utf8',
          flag: 'wx',
        });
        await rename(tempPath, filePath);
        return { acquired: true, path: filePath, record, executionToken };
      }
      if (existing.cascadeId === cascadeId) {
        return { acquired: true, path: filePath, record: existing, executionToken: null };
      }
      return { acquired: false, path: filePath, record: existing, executionToken: null };
    }
  });
}

export async function releaseWoLock(
  woId: string,
  project: string,
  cascadeId: string,
  outDir = './cascade-runs',
  executionToken?: string
): Promise<void> {
  if (typeof executionToken !== 'string' || !executionToken.trim()) {
    log.warn('smart_cauldron.wo_lock_release_owner_unknown');
    return;
  }
  const filePath = lockPath(outDir, woId, project);
  try {
    await mkdir(join(outDir, 'wo-locks'), { recursive: true });
    await withMutationGuard(filePath, async () => {
      const existing = await readValidatedLock(filePath, woId, project);
      if (
        existing.cascadeId !== cascadeId ||
        existing.executionToken !== executionToken ||
        existing.status === 'released'
      )
        return;
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
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    // Best-effort release must never turn uncertain evidence into an unlocked WO.
    log.warn('smart_cauldron.wo_lock_release_unknown');
  }
}
