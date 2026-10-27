/**
 * Reconcile the served global workflow volume to baked defaults.
 *
 * A same-named top-level *.yaml is replaced only when its bytes match a
 * previously committed hash. Uncommitted edits and volume-only files are
 * left in place and reported. Discovery precedence is not changed here.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import type { BigIntStats } from 'fs';
import {
  chmod,
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

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  );
}

function isEexist(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'EEXIST'
  );
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

/**
 * Full identity of a served lane file at one instant: contents AND the inode
 * that held them, plus size and nanosecond mtime.
 *
 * Hashing alone is not enough to decide a replacement is safe. An atomic-save
 * editor (write temp, rename over the target) swaps in a NEW inode; if the
 * saved bytes happen to match what we classified, a hash-only check sees "no
 * change" and overwrites a file that a live editor is actively holding. The
 * inode is what distinguishes "nobody touched this" from "someone replaced
 * this with something that merely looks the same".
 */
interface LaneIdentity {
  sha256: string;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

function identityOf(bytes: Buffer, info: BigIntStats): LaneIdentity {
  return {
    sha256: sha256Hex(bytes),
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
  };
}

function sameIdentity(left: LaneIdentity, right: LaneIdentity): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

async function identityAt(filePath: string): Promise<{ bytes: Buffer; identity: LaneIdentity }> {
  const bytes = await readFile(filePath);
  const info = await stat(filePath, { bigint: true });
  return { bytes, identity: identityOf(bytes, info) };
}

/**
 * Put a moved-aside lane back at its served path WITHOUT clobbering anything a
 * concurrent writer may have created there in the meantime.
 *
 * `link()` is the atomic primitive for "create only if absent" -- it fails with
 * EEXIST rather than overwriting, so there is no check-then-rename window. It
 * also re-attaches the ORIGINAL inode to the served path, so an editor that is
 * still holding a descriptor on that inode keeps writing to the served file
 * exactly as it would have if we had never touched it.
 */
async function restoreAside(
  backupFile: string,
  livePath: string
): Promise<'restored' | 'live_path_taken'> {
  try {
    await link(backupFile, livePath);
  } catch (error) {
    if (isEexist(error)) return 'live_path_taken';
    throw error;
  }
  await unlink(backupFile);
  return 'restored';
}

export async function reconcileServedLanes(input: {
  volumeDir: string;
  bakedDir: string;
  history: ServedLaneHistory;
  now: Date;
  beforeReplace?: () => Promise<void> | void;
  afterObserve?: (filename: string) => Promise<void> | void;
  afterFinalVerify?: (filename: string) => Promise<void> | void;
  afterLiveCreate?: (filename: string) => Promise<void> | void;
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

      // Observe the live file once at replace time, capturing its FULL identity
      // (bytes + inode + size + mtime), not just a hash. If the contents already
      // changed since classification (a hand edit that landed between discovery
      // and now), preserve it and overwrite nothing.
      const preStat = await stat(livePath, { bigint: true });
      const preBytes = await readFile(livePath);
      const preIdentity = identityOf(preBytes, preStat);
      if (preIdentity.sha256 !== lane.servedSha256) {
        result.unique_edit.push({
          filename: lane.filename,
          sha256: preIdentity.sha256,
          mtime: preStat.mtime.toISOString(),
        });
        continue;
      }

      // Test seam: an edit injected here lands between the observation above and
      // the rename below -- including an atomic-save swap that leaves the bytes
      // identical but installs a new inode.
      await input.afterObserve?.(lane.filename);

      // Create the backup directory lazily, the first time a replacement needs
      // it, so a run that replaces nothing leaves no stray .bak- directory.
      if (result.backup_path === null) {
        const backupDir = `${input.volumeDir}.bak-${backupStamp(input.now)}`;
        await mkdir(backupDir);
        result.backup_path = backupDir;
      }
      const backupFile = join(result.backup_path, lane.filename);
      if (await pathExists(backupFile)) {
        throw new Error(`Backup target already exists: ${backupFile}`);
      }

      // Atomically MOVE the live file into the backup instead of truncating it
      // in place. This closes the TOCTOU window that a read-verify-then-write
      // left open:
      //   1. The backup is the live file itself, moved -- never a copy -- so it
      //      can never hold bytes that differ from what was actually removed.
      //   2. The live path is now empty, so the exclusive create below cannot
      //      clobber a concurrent writer, even one that races in afterwards.
      //   3. uid/gid of the original ride along on the moved inode.
      await rename(livePath, backupFile);

      // FINAL VALIDATION of the moved inode: hash AND inode AND size AND mtime.
      // A hash-only check is not sufficient here. Two distinct races both leave
      // the bytes looking correct:
      //   a. An atomic-save editor (write temp, rename over the target) installs
      //      a NEW inode between the observation above and our rename. If its
      //      bytes coincide with what we classified, a hash-only check says
      //      "unchanged" and we move aside -- then overwrite -- a file a live
      //      editor is holding.
      //   b. A plain in-place write that happens to restore identical bytes
      //      still bumps size/mtime, proving someone else is active on the path.
      // Any identity mismatch means we are not looking at the file we vetted, so
      // we put it back and overwrite nothing.
      const moved = await identityAt(backupFile);
      if (!sameIdentity(moved.identity, preIdentity)) {
        const outcome = await restoreAside(backupFile, livePath);
        // 'live_path_taken': a concurrent writer created a fresh file at the
        // served path while it was free. Preserve THAT file and leave our
        // moved-aside bytes in the backup directory -- nothing is destroyed on
        // either side.
        const settled = await identityAt(livePath);
        const settledStat = await stat(livePath);
        if (outcome === 'live_path_taken') {
          log.warn(
            { filename: lane.filename, backupFile },
            'served_lanes.live_path_recreated_during_restore'
          );
        }
        result.unique_edit.push({
          filename: lane.filename,
          sha256: settled.identity.sha256,
          mtime: settledStat.mtime.toISOString(),
        });
        continue;
      }

      // Test seam: an edit injected here lands AFTER the final verification and
      // AFTER the live path was freed by the rename. The exclusive create below
      // must refuse to clobber it.
      await input.afterFinalVerify?.(lane.filename);

      // Write the baked bytes with O_CREAT|O_EXCL ('wx'): the write FAILS if the
      // live path exists. Because the rename above freed the path, success means
      // nothing raced us. EEXIST means a concurrent writer recreated the file in
      // the window, so we preserve that file rather than overwrite it -- there is
      // no path on which an uncoordinated edit is silently clobbered.
      try {
        await writeFile(livePath, lane.bakedBytes, { flag: 'wx' });
      } catch (error) {
        if (!isEexist(error)) throw error;
        const liveBytes = await readFile(livePath);
        const liveStat = await stat(livePath);
        result.unique_edit.push({
          filename: lane.filename,
          sha256: sha256Hex(liveBytes),
          mtime: liveStat.mtime.toISOString(),
        });
        continue;
      }

      // Test seam: an edit injected here simulates an editor that still holds a
      // descriptor on the ORIGINAL inode. That inode now lives at the backup
      // path, so the editor's save lands in the backup, NOT at the served path.
      await input.afterLiveCreate?.(lane.filename);

      // POST-CREATE RE-VERIFICATION. The rename above detached the original
      // inode, but any process that opened the file BEFORE the rename still
      // holds a descriptor straight to it -- renaming a path does not disturb an
      // open descriptor. Such a writer can land a save on that inode after our
      // final read, which would silently put a hand edit in the backup directory
      // while we report the lane 'replaced'. Re-check the backup inode now: if
      // it moved at all, roll the baked file back out and hand the served path
      // to the edit instead.
      const settledBackup = await identityAt(backupFile);
      if (!sameIdentity(settledBackup.identity, preIdentity)) {
        // rename() replaces the destination atomically, and the destination is
        // the file WE just created under O_EXCL, so discarding it cannot race a
        // third party. The preserved inode -- descriptor and all -- goes back to
        // the served path.
        await rename(backupFile, livePath);
        const restoredStat = await stat(livePath);
        log.warn({ filename: lane.filename }, 'served_lanes.open_descriptor_write_preserved');
        result.unique_edit.push({
          filename: lane.filename,
          sha256: settledBackup.identity.sha256,
          mtime: restoredStat.mtime.toISOString(),
        });
        continue;
      }

      // Residual, and bounded by design: a descriptor holder can still write to
      // the detached inode after this check. Those bytes land on the file now
      // sitting in the backup directory, which this routine never deletes -- so
      // the edit is retained on disk for recovery rather than destroyed. There
      // is no sequence on which an uncoordinated edit is lost.

      // Reapply the original mode onto the freshly created inode. The process
      // already shares the volume's ownership, so uid/gid are unchanged and only
      // the permission bits need to be restored explicitly.
      await chmod(livePath, Number(preStat.mode) & 0o7777);
      result.replaced.push(lane.filename);
    }

    // A run whose only candidate was restored by the final verification can
    // leave an empty backup directory behind; drop it so backup_path stays
    // honest about whether anything was actually backed up.
    if (result.backup_path !== null) {
      const remaining = await readdir(result.backup_path);
      if (remaining.length === 0) {
        await rm(result.backup_path, { recursive: true, force: true });
        result.backup_path = null;
      }
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
