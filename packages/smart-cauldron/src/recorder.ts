/**
 * recorder.ts -- Cascade run record writer.
 *
 * Writes per-cascade telemetry to cascade-runs/<slug>/cascade-record.json.
 * This is the local telemetry store for v1.0 (DB cascade_step event wiring
 * is deferred to v1.2 per spec section 4.D).
 *
 * Pattern mirrors @archon/fusion/src/cli.ts buildRunSlug + createRunFolder + writeRunFile.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { CascadeRunRecord } from './types.js';

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
  const slug = buildRunSlug(record);
  const runDir = join(outDir, slug);

  await mkdir(runDir, { recursive: true });

  const filePath = join(runDir, 'cascade-record.json');
  await writeFile(filePath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return filePath;
}

/**
 * Build a filesystem-safe slug for the cascade run.
 * Format: YYYY-MM-DD-<woId-slug>-<cascadeId[:8]>
 */
function buildRunSlug(record: CascadeRunRecord): string {
  const dateStr = record.createdAt.slice(0, 10); // YYYY-MM-DD
  const woSlug = record.woId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
  const shortId = record.cascadeId.slice(0, 8);
  return `${dateStr}-${woSlug}-${shortId}`;
}
