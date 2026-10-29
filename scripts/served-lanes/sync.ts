/**
 * Reconcile the served global workflow volume to baked defaults.
 *
 * A same-named top-level *.yaml is replaced only when its bytes match a
 * previously committed hash. Uncommitted edits and volume-only files are
 * left in place and reported. Discovery precedence is not changed here.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import {
  chmod,
  chown,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'fs/promises';
import { join, resolve } from 'path';
import { createLogger } from '../../packages/paths/src/logger';

const log = createLogger('served-lanes');

export type ServedLaneHistory = Readonly<Record<string, readonly string[]>>;

type CreateDispatchNotice = (
  context: { kind: 'system'; sender: 'dispatch' },
  data: {
    correlation_id: string;
    idempotency_key: string;
    task_type: 'agent_message';
    recipient: string;
    body: string;
  }
) => Promise<unknown>;

export interface UniqueEdit {
  filename: string;
  sha256: string;
  mtime: string;
}

export interface ReconcileResult {
  replaced: string[];
  unique_edit: UniqueEdit[];
  volume_only: string[];
  backup_path: string | null;
}

export type DriftState =
  | 'in_sync'
  | 'stale_replaceable'
  | 'unique_edit'
  | 'volume_only'
  | 'missing_in_volume';

export interface DriftLane {
  filename: string;
  state: DriftState;
  served_sha256: string | null;
  baked_sha256: string | null;
}

interface ClassifiedLane {
  filename: string;
  state: DriftState;
  servedSha256: string | null;
  bakedSha256: string | null;
  bakedBytes: Buffer | null;
  mtime: string | null;
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}

function isEnoent(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

function isEexist(error: unknown): boolean {
  return hasErrorCode(error, 'EEXIST');
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function emptyResult(): ReconcileResult {
  return {
    replaced: [],
    unique_edit: [],
    volume_only: [],
    backup_path: null,
  };
}

function sortResult(result: ReconcileResult): void {
  result.replaced.sort(compareAscii);
  result.volume_only.sort(compareAscii);
  result.unique_edit.sort((left, right) => compareAscii(left.filename, right.filename));
}

function reportPathFor(volumeDir: string): string {
  return resolve(volumeDir, '..', 'served-lanes-report.json');
}

async function writeReport(reportPath: string, result: ReconcileResult): Promise<void> {
  sortResult(result);
  const body =
    JSON.stringify(
      {
        replaced: result.replaced,
        unique_edit: result.unique_edit,
        volume_only: result.volume_only,
        backup_path: result.backup_path,
      },
      null,
      2
    ) + '\n';
  await writeFile(reportPath, body);
}

function backupStamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

async function directoryPresence(dir: string): Promise<'missing' | 'present'> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new Error(`Expected a directory: ${dir}`);
    }
    return 'present';
  } catch (error) {
    if (isEnoent(error)) return 'missing';
    throw error;
  }
}

async function listYamlNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.yaml'))
    .map(entry => entry.name)
    .sort(compareAscii);
}

function historyHas(history: ServedLaneHistory, filename: string, hash: string): boolean {
  const hashes = history[filename] ?? [];
  return hashes.includes(hash);
}

async function classifyAll(input: {
  volumeDir: string;
  bakedDir: string;
  history: ServedLaneHistory;
}): Promise<ClassifiedLane[]> {
  let volumeNames: Set<string>;
  try {
    volumeNames = new Set(await listYamlNames(input.volumeDir));
  } catch (error) {
    if (!isEnoent(error)) throw error;
    volumeNames = new Set();
  }
  const bakedNames = new Set(await listYamlNames(input.bakedDir));
  const names = [...new Set([...volumeNames, ...bakedNames])].sort(compareAscii);
  const lanes: ClassifiedLane[] = [];

  for (const filename of names) {
    const inVolume = volumeNames.has(filename);
    const inBaked = bakedNames.has(filename);
    if (inVolume && !inBaked) {
      const volumeBytes = await readFile(join(input.volumeDir, filename));
      lanes.push({
        filename,
        state: 'volume_only',
        servedSha256: sha256Hex(volumeBytes),
        bakedSha256: null,
        bakedBytes: null,
        mtime: null,
      });
      continue;
    }
    if (!inVolume && inBaked) {
      const bakedBytes = await readFile(join(input.bakedDir, filename));
      lanes.push({
        filename,
        state: 'missing_in_volume',
        servedSha256: null,
        bakedSha256: sha256Hex(bakedBytes),
        bakedBytes: null,
        mtime: null,
      });
      continue;
    }

    const volumePath = join(input.volumeDir, filename);
    const volumeBytes = await readFile(volumePath);
    const bakedBytes = await readFile(join(input.bakedDir, filename));
    const servedSha256 = sha256Hex(volumeBytes);
    const bakedSha256 = sha256Hex(bakedBytes);
    if (servedSha256 === bakedSha256) {
      lanes.push({
        filename,
        state: 'in_sync',
        servedSha256,
        bakedSha256,
        bakedBytes: null,
        mtime: null,
      });
      continue;
    }
    if (historyHas(input.history, filename, servedSha256)) {
      lanes.push({
        filename,
        state: 'stale_replaceable',
        servedSha256,
        bakedSha256,
        bakedBytes,
        mtime: null,
      });
      continue;
    }
    const info = await stat(volumePath);
    lanes.push({
      filename,
      state: 'unique_edit',
      servedSha256,
      bakedSha256,
      bakedBytes: null,
      mtime: info.mtime.toISOString(),
    });
  }

  return lanes;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export async function reconcileServedLanes(input: {
  volumeDir: string;
  bakedDir: string;
  history: ServedLaneHistory;
  now: Date;
  beforeReplace?: () => Promise<void> | void;
  beforeFinalVerify?: (filename: string) => Promise<void> | void;
  beforeReplaceWrite?: (filename: string) => Promise<void> | void;
  beforeStagedInstall?: (filename: string) => Promise<void> | void;
}): Promise<ReconcileResult> {
  const reportPath = reportPathFor(input.volumeDir);
  const volumePresence = await directoryPresence(input.volumeDir);
  const bakedPresence = await directoryPresence(input.bakedDir);
  if (volumePresence === 'missing' || bakedPresence === 'missing') {
    const empty = emptyResult();
    await writeReport(reportPath, empty);
    return empty;
  }

  const result = emptyResult();
  try {
    const lanes = await classifyAll(input);
    for (const lane of lanes) {
      if (lane.state === 'volume_only') {
        result.volume_only.push(lane.filename);
      } else if (
        lane.state === 'unique_edit' &&
        lane.servedSha256 !== null &&
        lane.mtime !== null
      ) {
        result.unique_edit.push({
          filename: lane.filename,
          sha256: lane.servedSha256,
          mtime: lane.mtime,
        });
      }
    }

    await input.beforeReplace?.();

    const replacements = lanes.filter(lane => lane.state === 'stale_replaceable');
    for (const lane of replacements) {
      if (lane.bakedBytes === null) {
        throw new Error(`Missing baked bytes for replacement: ${lane.filename}`);
      }
      if (lane.servedSha256 === null) {
        throw new Error(`Missing classified hash for replacement: ${lane.filename}`);
      }
      const livePath = join(input.volumeDir, lane.filename);

      // Observe the live file once at replace time. mtime and inode are
      // captured here so the final verification below can detect any edit.
      const preBytes = await readFile(livePath);
      const preStat = await stat(livePath);
      const preHash = sha256Hex(preBytes);
      if (preHash !== lane.servedSha256) {
        // Changed since classification: preserve it, overwrite nothing.
        result.unique_edit.push({
          filename: lane.filename,
          sha256: preHash,
          mtime: preStat.mtime.toISOString(),
        });
        continue;
      }

      // Test seam: an edit injected here lands BEFORE the final verification
      // read and must be caught by it and preserved, never overwritten.
      await input.beforeFinalVerify?.(lane.filename);

      // Final verification: re-read the bytes AND re-stat (mtime + inode) and
      // compare against the pre-observation. An edit detected here is preserved.
      const finalBytes = await readFile(livePath);
      const finalStat = await stat(livePath);
      const finalHash = sha256Hex(finalBytes);
      if (
        finalHash !== preHash ||
        finalStat.ino !== preStat.ino ||
        finalStat.mtimeMs !== preStat.mtimeMs
      ) {
        result.unique_edit.push({
          filename: lane.filename,
          sha256: finalHash,
          mtime: finalStat.mtime.toISOString(),
        });
        continue;
      }

      // Stage the baked bytes beside the live file, carrying over the served
      // file's permission bits (and uid/gid when permitted) so the swapped-in
      // file keeps the volume's ownership and mode. Inode identity is NOT
      // preserved here: a conflict-safe capture-then-install swap (rename to
      // capture, link to install) is required by the PR #1334 review to
      // guarantee that a concurrent edit is never silently lost -- a guarantee
      // an in-place truncating overwrite cannot provide, because the overwrite
      // destroys any edit that lands in the unavoidable gap between the final
      // hash read and the write. Both legs are non-destructive: rename captures
      // the live bytes whole, and link refuses to clobber a new livePath.
      const stagedNew = `${livePath}.served-lanes-new`;
      await writeFile(stagedNew, lane.bakedBytes);
      await chmod(stagedNew, preStat.mode & 0o7777);
      try {
        await chown(stagedNew, preStat.uid, preStat.gid);
      } catch (chownError) {
        // Non-fatal: an unprivileged process cannot chown to a different owner.
        // The staged file already belongs to this process (the volume owner),
        // so mode is preserved and ownership is unchanged from the live file.
        log.warn({ err: chownError, filename: lane.filename }, 'served_lanes.chown_skipped');
      }

      // Test seam: an edit injected HERE lands AFTER the final verification and
      // BEFORE the swap -- the true TOCTOU window the earlier in-place write
      // left open. The atomic capture below moves whatever bytes are live into
      // the staging backup, so such an edit is never destroyed: it is detected
      // and restored in place (reported as unique_edit), never overwritten.
      await input.beforeReplaceWrite?.(lane.filename);

      // Atomically move the current live file aside. rename() captures the
      // exact bytes present at swap time as a whole -- there is no read-then-
      // write gap in which an edit on the existing inode could be lost.
      const stagedOld = `${livePath}.served-lanes-bak-staging`;
      await rename(livePath, stagedOld);

      // Compare what we actually captured against the verified hash. A mismatch
      // means an edit raced in after the final verification: restore it in
      // place and preserve it, replacing nothing.
      const capturedBytes = await readFile(stagedOld);
      const capturedHash = sha256Hex(capturedBytes);
      if (capturedHash !== preHash) {
        await rename(stagedOld, livePath);
        await rm(stagedNew, { force: true });
        const restoredStat = await stat(livePath);
        result.unique_edit.push({
          filename: lane.filename,
          sha256: capturedHash,
          mtime: restoredStat.mtime.toISOString(),
        });
        continue;
      }

      // Test seam: an edit injected HERE lands in the window where livePath is
      // vacant (after the capture rename, before the baked bytes are installed).
      // An editor that saves by creating/renaming a file at livePath in this
      // window must NOT be clobbered by the install below.
      await input.beforeStagedInstall?.(lane.filename);

      // Verified unchanged: install the staged baked file. link() is used rather
      // than rename() because rename() clobbers its destination unconditionally:
      // livePath is vacant for the span above, so a concurrent save landing
      // there would be silently destroyed by a rename. link() instead fails
      // closed with EEXIST if anything now occupies livePath, letting the racing
      // edit be detected and preserved. The subsequent unlink drops only the
      // staging name; livePath keeps the installed inode.
      try {
        await link(stagedNew, livePath);
      } catch (installError) {
        if (!isEexist(installError)) throw installError;

        // A concurrent save created a file at livePath inside the vacant window.
        // That file is the live truth: leave it untouched, drop our staged baked
        // bytes, and report it as a preserved edit. The captured old bytes are a
        // known committed-history version (preHash matched), so they are
        // discarded rather than restored -- restoring them would clobber exactly
        // the edit this branch exists to protect. The discarded hash is logged
        // so the decision stays auditable.
        await rm(stagedNew, { force: true });
        await rm(stagedOld, { force: true });
        const racedBytes = await readFile(livePath);
        const racedStat = await stat(livePath);
        log.warn(
          {
            filename: lane.filename,
            discardedSha256: preHash,
            preservedSha256: sha256Hex(racedBytes),
          },
          'served_lanes.install_raced_edit_preserved'
        );
        result.unique_edit.push({
          filename: lane.filename,
          sha256: sha256Hex(racedBytes),
          mtime: racedStat.mtime.toISOString(),
        });
        continue;
      }
      await unlink(stagedNew);

      // Promote the captured old bytes into the official backup directory,
      // created lazily so a run that replaces nothing creates no backup dir.
      // The backup therefore holds exactly the bytes that were replaced.
      if (result.backup_path === null) {
        const backupDir = `${input.volumeDir}.bak-${backupStamp(input.now)}`;
        await mkdir(backupDir);
        result.backup_path = backupDir;
      }
      const backupFile = join(result.backup_path, lane.filename);
      if (await pathExists(backupFile)) {
        throw new Error(`Backup target already exists: ${backupFile}`);
      }
      await rename(stagedOld, backupFile);
      result.replaced.push(lane.filename);
    }

    await writeReport(reportPath, result);
    return result;
  } catch (error) {
    try {
      await writeReport(reportPath, result);
    } catch (reportError) {
      log.warn({ err: reportError, reportPath }, 'served_lanes.report_write_failed');
    }
    throw error;
  }
}

export async function computeDrift(input: {
  volumeDir: string;
  bakedDir: string;
  history: ServedLaneHistory;
}): Promise<{ lanes: DriftLane[] }> {
  const lanes = await classifyAll(input);
  return {
    lanes: lanes.map(lane => ({
      filename: lane.filename,
      state: lane.state,
      served_sha256: lane.servedSha256,
      baked_sha256: lane.bakedSha256,
    })),
  };
}

export function readServedLaneHistory(historyPath: string): ServedLaneHistory {
  let raw: string;
  try {
    raw = readFileSync(historyPath, 'utf8');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Failed to load served lane history at ${historyPath}: ${err.message}`);
  }
  return parseServedLaneHistory(raw, historyPath);
}

function parseServedLaneHistory(raw: string, source: string): ServedLaneHistory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Failed to parse served lane history at ${source}: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Served lane history at ${source} must be a JSON object`);
  }
  const history: Record<string, readonly string[]> = {};
  for (const [filename, hashes] of Object.entries(parsed)) {
    if (!Array.isArray(hashes) || hashes.some(hash => typeof hash !== 'string')) {
      throw new Error(`Served lane history at ${source} has an invalid hash list for ${filename}`);
    }
    history[filename] = hashes;
  }
  return history;
}

function readUniqueEdits(parsed: unknown): UniqueEdit[] | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!('unique_edit' in parsed)) return null;
  const edits = (parsed as { unique_edit: unknown }).unique_edit;
  if (!Array.isArray(edits)) return null;
  const valid: UniqueEdit[] = [];
  for (const edit of edits) {
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) continue;
    const row = edit as { filename?: unknown; sha256?: unknown; mtime?: unknown };
    if (
      typeof row.filename !== 'string' ||
      row.filename.length === 0 ||
      typeof row.sha256 !== 'string' ||
      row.sha256.length < 12 ||
      typeof row.mtime !== 'string' ||
      row.mtime.length === 0
    ) {
      continue;
    }
    valid.push({ filename: row.filename, sha256: row.sha256, mtime: row.mtime });
  }
  return valid;
}

export async function notifyServedLaneUniqueEdits(reportPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(reportPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      log.warn({ reportPath }, 'served_lanes.report_missing');
      return;
    }
    log.warn({ err: error, reportPath }, 'served_lanes.report_read_failed');
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    log.warn({ err: error, reportPath }, 'served_lanes.report_parse_failed');
    return;
  }

  const edits = readUniqueEdits(parsed);
  if (edits === null) {
    log.warn({ reportPath }, 'served_lanes.report_parse_failed');
    return;
  }
  if (edits.length === 0) return;

  let createAuthenticatedMessage: CreateDispatchNotice;
  try {
    const dispatch = (await import('../../packages/core/src/db/dispatch')) as {
      createAuthenticatedMessage: CreateDispatchNotice;
    };
    createAuthenticatedMessage = dispatch.createAuthenticatedMessage;
  } catch (error) {
    log.warn({ err: error }, 'served_lanes.notice_failed');
    return;
  }

  for (const edit of edits) {
    const idempotencyKey = `served-lanes:${edit.filename}:${edit.sha256.slice(0, 12)}`;
    try {
      await createAuthenticatedMessage(
        { kind: 'system', sender: 'dispatch' },
        {
          correlation_id: idempotencyKey,
          idempotency_key: idempotencyKey,
          task_type: 'agent_message',
          recipient: 'xo',
          body: JSON.stringify({
            filename: edit.filename,
            volume_sha256: edit.sha256,
            mtime: edit.mtime,
          }),
        }
      );
    } catch (error) {
      log.warn({ err: error, filename: edit.filename }, 'served_lanes.notice_failed');
    }
  }
}
