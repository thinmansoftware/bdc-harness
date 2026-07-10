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
    if (
      existing.woId !== record.woId ||
      existing.project !== record.project ||
      JSON.stringify(existing.request) !== JSON.stringify(record.request)
    ) {
      throw new Error(
        `[smart-cauldron/recorder] dispatch identity conflict for ${record.cascadeId}: ` +
          `existing scope is ${existing.woId}/${existing.project ?? 'none'}, ` +
          `requested scope is ${record.woId}/${record.project ?? 'none'}, or request parameters differ`
      );
    }
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
  await rename(tempPath, filePath);
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
