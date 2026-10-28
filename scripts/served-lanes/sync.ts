/**
 * Reconcile the served global workflow volume to baked defaults.
 *
 * A same-named top-level *.yaml is replaced only when its bytes match a
 * previously committed hash. Replacement swaps the live name out of the way
 * and links the baked bytes in; the live path is never opened for writing.
 * Uncommitted edits and volume-only files are left in place and reported.
 * Discovery precedence is not changed here.
 */
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import {
  chmod,
  chown,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'fs/promises';
import { join, resolve } from 'path';
import { createLogger } from '../../packages/paths/src/logger';

const log = createLogger('served-lanes');
const BACKUP_RESERVE_ATTEMPTS = 16;

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

export interface ReplacedLane {
  filename: string;
  backup_path: string;
}

export interface EditConflict {
  filename: string;
  live_path: string;
  backup_path: string;
  sha256: string;
  mtime: string;
}

export interface EditAfterSwap {
  filename: string;
  backup_path: string;
  sha256: string;
  mtime: string;
}

export interface ReconcileResult {
  replaced: ReplacedLane[];
  unique_edit: UniqueEdit[];
  edit_conflict: EditConflict[];
  edit_after_swap: EditAfterSwap[];
  volume_only: string[];
  backup_path: string | null;
}

export interface ServedLaneHooks {
  afterFinalStat?: (path: string) => Promise<void> | void;
  afterSwapToBackup?: (path: string, backupPath: string) => Promise<void> | void;
  afterInstall?: (path: string, backupPath: string) => Promise<void> | void;
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

interface LiveIdentity {
  sha256: string;
  mtime: string;
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}

function isEnoent(error: unknown): boolean {
  return isCode(error, 'ENOENT');
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function emptyResult(): ReconcileResult {
  return {
    replaced: [],
    unique_edit: [],
    edit_conflict: [],
    edit_after_swap: [],
    volume_only: [],
    backup_path: null,
  };
}

function sortResult(result: ReconcileResult): void {
  const byFilename = (left: { filename: string }, right: { filename: string }): number =>
    compareAscii(left.filename, right.filename);
  result.replaced.sort(byFilename);
  result.unique_edit.sort(byFilename);
  result.edit_conflict.sort(byFilename);
  result.edit_after_swap.sort(byFilename);
  result.volume_only.sort(compareAscii);
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
        edit_conflict: result.edit_conflict,
        edit_after_swap: result.edit_after_swap,
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
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}Z`;
}

function randomHex6(): string {
  return randomBytes(3).toString('hex');
}

async function mkdirNewDirectory(path: string): Promise<void> {
  await mkdir(path);
}

async function reserveBackupDir(
  volumeDir: string,
  now: Date,
  mkdirExclusive: (path: string) => Promise<void>
): Promise<string> {
  const stamp = backupStamp(now);
  const pid = process.pid;
  for (let attempt = 0; attempt < BACKUP_RESERVE_ATTEMPTS; attempt += 1) {
    const backupDir = `${volumeDir}.bak-${stamp}-${pid}-${randomHex6()}`;
    try {
      await mkdirExclusive(backupDir);
      return backupDir;
    } catch (error) {
      if (isCode(error, 'EEXIST')) continue;
      throw error;
    }
  }
  throw new Error(
    `Failed to reserve served-lanes backup directory under ${volumeDir} after ${BACKUP_RESERVE_ATTEMPTS} attempts`
  );
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

async function discardTemp(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath);
  } catch (error) {
    if (isEnoent(error)) return;
    log.warn({ err: error, tempPath }, 'served_lanes.temp_cleanup_failed');
    throw error;
  }
}

async function readLiveIdentity(filePath: string): Promise<LiveIdentity> {
  const bytes = await readFile(filePath);
  const info = await stat(filePath);
  return { sha256: sha256Hex(bytes), mtime: info.mtime.toISOString() };
}

async function recordEditConflict(
  result: ReconcileResult,
  filename: string,
  livePath: string,
  backupFile: string
): Promise<void> {
  const live = await readLiveIdentity(livePath);
  result.edit_conflict.push({
    filename,
    live_path: livePath,
    backup_path: backupFile,
    sha256: live.sha256,
    mtime: live.mtime,
  });
}

async function swapStaleLane(input: {
  volumeDir: string;
  backupDir: string;
  lane: ClassifiedLane;
  hooks: ServedLaneHooks | undefined;
  result: ReconcileResult;
}): Promise<void> {
  if (input.lane.bakedBytes === null) {
    throw new Error(`Missing baked bytes for replacement: ${input.lane.filename}`);
  }
  if (input.lane.servedSha256 === null) {
    throw new Error(`Missing classified hash for replacement: ${input.lane.filename}`);
  }
  const bakedBytes = input.lane.bakedBytes;
  const classifiedHash = input.lane.servedSha256;
  const livePath = join(input.volumeDir, input.lane.filename);
  const backupFile = join(input.backupDir, input.lane.filename);
  let tempPath: string | null = null;

  try {
    const preStat = await stat(livePath);
    const uid = preStat.uid;
    const gid = preStat.gid;
    const mode = preStat.mode & 0o777;
    await input.hooks?.afterFinalStat?.(livePath);

    tempPath = join(
      input.volumeDir,
      `.${input.lane.filename}.served-lanes-tmp-${process.pid}-${randomHex6()}`
    );
    await writeFile(tempPath, bakedBytes);
    await chown(tempPath, uid, gid);
    await chmod(tempPath, mode);

    await rename(livePath, backupFile);
    await input.hooks?.afterSwapToBackup?.(livePath, backupFile);

    const backupBytes = await readFile(backupFile);
    const backupHash = sha256Hex(backupBytes);
    if (backupHash !== classifiedHash) {
      try {
        await link(backupFile, livePath);
      } catch (error) {
        if (!isCode(error, 'EEXIST')) throw error;
        await discardTemp(tempPath);
        tempPath = null;
        await recordEditConflict(input.result, input.lane.filename, livePath, backupFile);
        return;
      }
      const liveStat = await stat(livePath);
      input.result.unique_edit.push({
        filename: input.lane.filename,
        sha256: backupHash,
        mtime: liveStat.mtime.toISOString(),
      });
      await discardTemp(tempPath);
      tempPath = null;
      return;
    }

    try {
      await link(tempPath, livePath);
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      await discardTemp(tempPath);
      tempPath = null;
      await recordEditConflict(input.result, input.lane.filename, livePath, backupFile);
      return;
    }

    await discardTemp(tempPath);
    tempPath = null;
    input.result.replaced.push({
      filename: input.lane.filename,
      backup_path: backupFile,
    });

    await input.hooks?.afterInstall?.(livePath, backupFile);
    const postBytes = await readFile(backupFile);
    const postHash = sha256Hex(postBytes);
    if (postHash !== backupHash) {
      const postStat = await stat(backupFile);
      input.result.edit_after_swap.push({
        filename: input.lane.filename,
        backup_path: backupFile,
        sha256: postHash,
        mtime: postStat.mtime.toISOString(),
      });
    }
  } catch (error) {
    // Pre-swap ENOENT drops the temp file and rethrows. After the rename, any
    // other error keeps the backup and rethrows; this cleanup only unlinks the
    // temp name and never a backup.
    if (tempPath !== null) {
      try {
        await unlink(tempPath);
      } catch (cleanupError) {
        if (!isEnoent(cleanupError)) {
          log.warn({ err: cleanupError, tempPath }, 'served_lanes.temp_cleanup_failed');
        }
      }
    }
    throw error;
  }
}

export async function reconcileServedLanes(input: {
  volumeDir: string;
  bakedDir: string;
  history: ServedLaneHistory;
  now: Date;
  mkdirExclusive?: (path: string) => Promise<void>;
  hooks?: ServedLaneHooks;
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

    const replacements = lanes.filter(lane => lane.state === 'stale_replaceable');
    if (replacements.length > 0) {
      const mkdirExclusive = input.mkdirExclusive ?? mkdirNewDirectory;
      result.backup_path = await reserveBackupDir(input.volumeDir, input.now, mkdirExclusive);
      for (const lane of replacements) {
        await swapStaleLane({
          volumeDir: input.volumeDir,
          backupDir: result.backup_path,
          lane,
          hooks: input.hooks,
          result,
        });
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

function noticeRowsFrom(value: unknown): UniqueEdit[] {
  if (!Array.isArray(value)) return [];
  const valid: UniqueEdit[] = [];
  for (const edit of value) {
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

function readUniqueEdits(parsed: unknown): UniqueEdit[] | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!('unique_edit' in parsed)) return null;
  const edits = (parsed as { unique_edit: unknown }).unique_edit;
  if (!Array.isArray(edits)) return null;
  return noticeRowsFrom(edits);
}

function readOptionalNotices(
  parsed: object,
  key: 'edit_conflict' | 'edit_after_swap'
): UniqueEdit[] {
  if (!(key in parsed)) return [];
  return noticeRowsFrom((parsed as Record<string, unknown>)[key]);
}

async function sendDispatchNotice(
  createAuthenticatedMessage: CreateDispatchNotice,
  edit: UniqueEdit
): Promise<void> {
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
  if (edits === null || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn({ reportPath }, 'served_lanes.report_parse_failed');
    return;
  }
  const notices = [
    ...edits,
    ...readOptionalNotices(parsed, 'edit_conflict'),
    ...readOptionalNotices(parsed, 'edit_after_swap'),
  ];
  if (notices.length === 0) return;

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

  for (const edit of notices) {
    await sendDispatchNotice(createAuthenticatedMessage, edit);
  }
}
