/**
 * recorder.ts -- Cascade run record writer.
 *
 * Writes per-cascade telemetry to cascade-runs/<slug>/cascade-record.json.
 * This is the local telemetry store for v1.0 (DB cascade_step event wiring
 * is deferred to v1.2 per spec section 4.D).
 *
 * Pattern mirrors @archon/fusion/src/cli.ts buildRunSlug + createRunFolder + writeRunFile.
 */

import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import type { CascadeRunRecord } from './types.js';

export interface CreateCascadeRecordResult {
  readonly created: boolean;
  readonly path: string;
  readonly record: CascadeRunRecord;
}

function recordPath(cascadeId: string, outDir: string): string {
  const digest = createHash('sha256').update(cascadeId).digest('hex').slice(0, 24);
  return join(outDir, `dispatch-${digest}`, 'cascade-record.json');
}

/** Read-only lookup: absence never creates admission or grants execution. */
export async function readCascadeRecordById(
  cascadeId: string,
  outDir = './cascade-runs'
): Promise<CascadeRunRecord | null> {
  try {
    return JSON.parse(await readFile(recordPath(cascadeId, outDir), 'utf8')) as CascadeRunRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function assertCascadeRecordIdentity(
  existing: CascadeRunRecord,
  requested: Pick<CascadeRunRecord, 'cascadeId' | 'woId' | 'project' | 'request'>
): void {
  if (
    existing?.cascadeId !== requested.cascadeId ||
    existing.woId !== requested.woId ||
    existing.project !== requested.project ||
    JSON.stringify(existing.request) !== JSON.stringify(requested.request)
  )
    throw new Error('[smart-cauldron/recorder] dispatch identity conflict');
}

/** Create the admission record exactly once. Existing dispatch IDs are returned, not overwritten. */
export async function createRecord(
  record: CascadeRunRecord,
  outDir = './cascade-runs'
): Promise<CreateCascadeRecordResult> {
  const filePath = await ensureRecordPath(record, outDir);
  try {
    await writeFile(filePath, JSON.stringify(record, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
    return { created: true, path: filePath, record };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(filePath, 'utf8')) as CascadeRunRecord;
    assertCascadeRecordIdentity(existing, record);
    return { created: false, path: filePath, record: existing };
  }
}

/**
 * Write a cascade run record to disk.
 *
 * @param record  The complete CascadeRunRecord to persist.
 * @param outDir  Output directory (default: ./cascade-runs relative to CWD).
 * @returns The path of the written file.
 */
export async function writeRecord(
  record: CascadeRunRecord,
  outDir = './cascade-runs'
): Promise<string> {
  const filePath = await ensureRecordPath(record, outDir);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(record, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
  // Persist one immutable payload. Windows can transiently refuse replacement;
  // retry only this rename, never the provider work or a destructive fallback.
  const delays = [10, 20, 40, 80] as const;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tempPath, filePath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== 'win32' ||
        (code !== 'EPERM' && code !== 'EBUSY') ||
        attempt >= delays.length
      )
        throw error;
      await new Promise<void>(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
  return filePath;
}

async function ensureRecordPath(record: CascadeRunRecord, outDir: string): Promise<string> {
  const runDir = join(outDir, buildRunSlug(record));
  await mkdir(runDir, { recursive: true });
  return join(runDir, 'cascade-record.json');
}

/**
 * Build a filesystem-safe slug for the cascade run.
 * Format: dispatch-<sha256(cascadeId)[:24]>
 *
 * The full dispatch identity is hashed so paths are stable across dates, safe
 * for arbitrary caller keys, and do not collide on a shared short prefix.
 */
function buildRunSlug(record: CascadeRunRecord): string {
  const dispatchDigest = createHash('sha256').update(record.cascadeId).digest('hex').slice(0, 24);
  return `dispatch-${dispatchDigest}`;
}
