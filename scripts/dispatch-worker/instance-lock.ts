import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname } from 'path';

/**
 * Duplicate-instance protection for the dispatch worker.
 *
 * Design choice: a local PID lockfile, not a check against the drop-box
 * server's own registration/heartbeat rows.
 *
 * Why a local lockfile and not a server-side check:
 * - The server heartbeat row for a crashed worker stays "fresh" for up to
 *   heartbeat_interval_ms after the process dies (see GET /api/dispatch/status,
 *   which only expires stale rows on read, not on a timer). A newly-starting
 *   worker that asked the server "is dispatch-worker-X already registered and
 *   heartbeating" could see a live-looking row for a worker that is actually
 *   dead, and refuse to start when it should not (a false-positive lockout
 *   with no local recovery path short of waiting out the stale window).
 * - A local lockfile answers a simpler, more reliable question -- "is a
 *   process with this PID alive on this machine right now, and is it the
 *   same process that took the lock" -- with no network round trip and no
 *   dependency on server clock/expiry behavior. It also fails toward
 *   availability: if the lock is stale (process is dead, or the PID was
 *   reused by a different process), the new instance reclaims it and starts,
 *   instead of waiting on a server-side timeout it does not control. If the
 *   live process still matches the recorded identity, or identity cannot be
 *   proven, startup fails closed.
 * - The existing token file convention (join(homedir(), '.config', 'bdc', ...))
 *   already establishes homedir()/.config/bdc as the correct place for this
 *   kind of local-machine state, so the lockfile follows the same pattern.
 */

/** Holder process creation time and CIM process name, when known. */
export interface ProcessIdentity {
  start_time: string;
  executable: string | null;
}

export interface InstanceLockOptions {
  lockFile: string;
  /** Injected for tests; defaults to process.pid. */
  pid?: number;
  /** Injected for tests; defaults to a real liveness check via process.kill(pid, 0). */
  isAlive?: (pid: number) => boolean;
  /**
   * Process start time and executable for a PID. Injected in tests. The
   * default is a Windows CIM lookup via powershell.exe and returns null on
   * every failure, including non-Windows hosts.
   */
  lookupProcess?: (pid: number) => ProcessIdentity | null;
  /** Identity-mismatch reclaim log. Defaults to console.error. */
  log?: (message: string) => void;
  /**
   * Append-only death log. When acquireInstanceLock reclaims a lock held by a
   * dead PID, it appends one JSON line describing that death here BEFORE the
   * lock is overwritten, so the evidence survives a watchdog restart that would
   * otherwise erase all trace of the death (the heartbeat clock restarts fresh).
   */
  deathLogFile?: string;
}

/** One reclaimed-death record, worker-supplied fields only (never the server clock). */
export interface RestartEvidenceEntry {
  previous_pid: number;
  previous_started_at: string;
  reclaimed_at: string;
}

export interface InstanceLockHandle {
  release: () => Promise<void>;
  /**
   * Set when this acquisition reclaimed a lock held by a dead PID; null on a
   * clean start (no prior lock, unparseable lock, or our own pid) and null
   * when a live PID is reclaimed because its process identity does not match.
   * Carries the same object that was appended to the death log.
   */
  reclaimed: RestartEvidenceEntry | null;
}

/** Milliseconds in the retention window for restart evidence. */
const RESTART_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Cap on how many recent entries readRestartEvidence returns. */
const RESTART_EVIDENCE_MAX_ENTRIES = 20;
/** CIM lookup budget. A hung powershell.exe must not stall worker startup. */
const PROCESS_LOOKUP_TIMEOUT_MS = 15000;

const WINDOWS_PROCESS_DATE = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/;
const ISO_PROCESS_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type StaleReason = 'start_time' | 'executable' | 'legacy_lock';

interface StoredLock {
  pid: number | null;
  started_at: string | null;
  start_time: string | null;
  executable: string | null;
  /** True only when the lock JSON has no start_time field. */
  missingStartTime: boolean;
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 sends no signal; it only tests whether the process exists and
    // is reachable. Node/Bun implement this consistently on Windows and POSIX:
    // throws ESRCH if the process does not exist, succeeds (or throws EPERM,
    // which still means "exists") if it does.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM') return true; // exists, just not signalable by us
    return false; // ESRCH or anything else: treat as not alive
  }
}

function emptyLock(): StoredLock {
  return {
    pid: null,
    started_at: null,
    start_time: null,
    executable: null,
    missingStartTime: false,
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Parse one CIM Win32_Process JSON payload (object or a one-element array).
 * Accepts /Date(ms)/, /Date(ms+/-offset)/, and ISO-8601 CreationDate values.
 * Returns null for empty, invalid, multi-row, malformed, or pid-less output.
 * ExecutablePath is ignored; executable is the CIM Name.
 */
export function parseWindowsProcessIdentity(stdout: string): ProcessIdentity | null {
  let text = stdout;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  let row: unknown;
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) return null;
    row = parsed[0];
  } else {
    row = parsed;
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;

  const obj = row as Record<string, unknown>;
  const createdRaw = obj.CreationDate;
  if (typeof createdRaw !== 'string') return null;
  const startTime = creationDateToIso(createdRaw.trim());
  if (startTime === null) return null;

  return {
    start_time: startTime,
    executable: nonEmptyString(obj.Name),
  };
}

function creationDateToIso(value: string): string | null {
  const windows = WINDOWS_PROCESS_DATE.exec(value);
  if (windows) {
    const ms = Number(windows[1]);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
  }
  if (!ISO_PROCESS_DATE.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * powershell.exe writes UTF-16 LE to a redirected pipe, often without a BOM.
 * Decoding that as UTF-8 would hide the CIM JSON and fail every lookup closed.
 */
function decodeSpawnStdout(stdout: string | Buffer | null | undefined): string {
  if (stdout == null) return '';
  if (typeof stdout === 'string') {
    if (stdout.charCodeAt(0) === 0xfeff) return stdout.slice(1);
    if (stdout.length >= 4 && stdout.charCodeAt(1) === 0 && stdout.charCodeAt(3) === 0) {
      return Buffer.from(stdout, 'latin1').toString('utf16le');
    }
    return stdout;
  }
  if (stdout.length === 0) return '';
  if (stdout.length >= 2 && stdout[0] === 0xff && stdout[1] === 0xfe) {
    return stdout.subarray(2).toString('utf16le');
  }
  if (stdout.length >= 4 && stdout[1] === 0 && stdout[3] === 0) {
    return stdout.toString('utf16le');
  }
  if (stdout.length >= 3 && stdout[0] === 0xef && stdout[1] === 0xbb && stdout[2] === 0xbf) {
    return stdout.subarray(3).toString('utf8');
  }
  return stdout.toString('utf8');
}

function defaultLookupProcess(pid: number): ProcessIdentity | null {
  try {
    if (process.platform !== 'win32') return null;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const command = [
      'Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=' + String(pid) + '"',
      'Select-Object Name,ExecutablePath,CreationDate',
      'ConvertTo-Json -Compress',
    ].join(' | ');
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      {
        timeout: PROCESS_LOOKUP_TIMEOUT_MS,
        windowsHide: true,
        shell: false,
      }
    );
    if (result.error || result.status !== 0) return null;
    return parseWindowsProcessIdentity(decodeSpawnStdout(result.stdout));
  } catch {
    return null;
  }
}

function staleIdentityReason(
  existing: StoredLock,
  live: ProcessIdentity | null
): StaleReason | null {
  if (live === null) return null;
  const liveMs = Date.parse(live.start_time);
  if (!Number.isFinite(liveMs)) return null;

  if (!existing.missingStartTime) {
    if (existing.start_time === null) return null;
    const recordedMs = Date.parse(existing.start_time);
    if (!Number.isFinite(recordedMs)) return null;
    if (recordedMs !== liveMs) return 'start_time';
    const liveExe = nonEmptyString(live.executable);
    if (existing.executable !== null && liveExe !== null && existing.executable !== liveExe) {
      return 'executable';
    }
    return null;
  }

  if (existing.started_at === null) return null;
  const startedMs = Date.parse(existing.started_at);
  if (!Number.isFinite(startedMs)) return null;
  if (liveMs > startedMs) return 'legacy_lock';
  return null;
}

async function readLockContents(lockFile: string): Promise<StoredLock> {
  try {
    const raw = (await readFile(lockFile, 'utf8')).trim();
    const parsedUnknown: unknown = JSON.parse(raw);
    if (!parsedUnknown || typeof parsedUnknown !== 'object' || Array.isArray(parsedUnknown)) {
      return emptyLock();
    }
    const parsed = parsedUnknown as Record<string, unknown>;
    const pid = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : null;
    const startedAt = typeof parsed.started_at === 'string' ? parsed.started_at : null;
    const missingStartTime = !Object.hasOwn(parsed, 'start_time');
    const startTime = missingStartTime ? null : nonEmptyString(parsed.start_time);
    return {
      pid,
      started_at: startedAt,
      start_time: startTime,
      executable: nonEmptyString(parsed.executable),
      missingStartTime,
    };
  } catch {
    return emptyLock();
  }
}

async function readLockPid(lockFile: string): Promise<number | null> {
  return (await readLockContents(lockFile)).pid;
}

function lockBody(
  holderPid: number,
  identity: ProcessIdentity | null
): { pid: number; started_at: string; start_time?: string; executable?: string } {
  const body: {
    pid: number;
    started_at: string;
    start_time?: string;
    executable?: string;
  } = {
    pid: holderPid,
    started_at: new Date().toISOString(),
  };
  if (identity?.start_time) body.start_time = identity.start_time;
  if (identity?.executable) body.executable = identity.executable;
  return body;
}

/**
 * Acquire the single-instance lock for this worker id. Throws
 * 'dispatch_worker_already_running' if a live process already holds it and
 * the recorded identity still matches (or cannot be disproven). A lock held
 * by a dead PID, or by a live PID whose start time or executable does not
 * match, is reclaimed.
 */
export async function acquireInstanceLock(
  options: InstanceLockOptions
): Promise<InstanceLockHandle> {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const lookupProcess = options.lookupProcess ?? defaultLookupProcess;
  const log =
    options.log ??
    ((message: string): void => {
      console.error(message);
    });

  const existing = await readLockContents(options.lockFile);
  const existingPid = existing.pid;

  // Same-PID reacquisition rewrites the lock below and does not evaluate
  // identity. A different PID is either a dead holder (death log) or a live
  // holder whose process identity decides reclaim vs refuse.
  let reclaimed: RestartEvidenceEntry | null = null;
  if (existingPid !== null && existingPid !== pid) {
    if (!isAlive(existingPid)) {
      reclaimed = {
        previous_pid: existingPid,
        previous_started_at: existing.started_at ?? '',
        reclaimed_at: new Date().toISOString(),
      };
      if (options.deathLogFile) {
        try {
          await mkdir(dirname(options.deathLogFile), { recursive: true });
          await appendFile(options.deathLogFile, `${JSON.stringify(reclaimed)}\n`, 'utf8');
        } catch {
          // Best-effort: a lost death line must never block the worker from
          // starting. The heartbeat-age page path remains as a backstop.
        }
      }
    } else {
      const reason = staleIdentityReason(existing, lookupProcess(existingPid));
      if (reason === null) {
        throw new Error(
          `dispatch_worker_already_running: pid ${existingPid} holds ${options.lockFile}`
        );
      }
      // PID reuse is not a death. Leave reclaimed null and do not append a
      // death-log line; the previous process was not observed dead.
      log(`dispatch_worker_lock_stale pid=${existingPid} reason=${reason}`);
    }
  }

  await mkdir(dirname(options.lockFile), { recursive: true });
  await writeFile(
    options.lockFile,
    JSON.stringify(lockBody(pid, lookupProcess(pid)), null, 2),
    'utf8'
  );

  let released = false;
  return {
    reclaimed,
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      try {
        const currentPid = await readLockPid(options.lockFile);
        // Only remove the lock if it is still ours; never clobber a lock a
        // newer instance may have already reclaimed after a stale read.
        if (currentPid === pid) {
          await rm(options.lockFile, { force: true });
        }
      } catch {
        // Best-effort cleanup only; a stale lock left behind is safely
        // reclaimed by the next start (dead PID, or a mismatched identity).
      }
    },
  };
}

/**
 * Read the retained restart evidence from a death log written by
 * acquireInstanceLock. Returns entries newer than 24 hours, oldest first, at
 * most the most recent 20. Unparseable lines are skipped (never thrown); a
 * missing file returns []. This is what a worker attaches to its registration
 * as capabilities.restart_evidence so the server-side alarm can page each death
 * even when a watchdog restarted the worker before its heartbeat went stale.
 */
export async function readRestartEvidence(
  deathLogFile: string,
  nowIso: string
): Promise<RestartEvidenceEntry[]> {
  let raw: string;
  try {
    raw = await readFile(deathLogFile, 'utf8');
  } catch {
    return [];
  }

  const nowMs = Date.parse(nowIso);
  const cutoffMs = Number.isFinite(nowMs) ? nowMs - RESTART_EVIDENCE_MAX_AGE_MS : null;

  const entries: RestartEvidenceEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    const pid = obj.previous_pid;
    const startedAt = obj.previous_started_at;
    const reclaimedAt = obj.reclaimed_at;
    if (typeof pid !== 'number' || !Number.isInteger(pid)) continue;
    if (typeof startedAt !== 'string') continue;
    if (typeof reclaimedAt !== 'string') continue;
    if (cutoffMs !== null) {
      const reclaimedMs = Date.parse(reclaimedAt);
      if (Number.isFinite(reclaimedMs) && reclaimedMs < cutoffMs) continue;
    }
    entries.push({ previous_pid: pid, previous_started_at: startedAt, reclaimed_at: reclaimedAt });
  }

  if (entries.length > RESTART_EVIDENCE_MAX_ENTRIES) {
    return entries.slice(entries.length - RESTART_EVIDENCE_MAX_ENTRIES);
  }
  return entries;
}
