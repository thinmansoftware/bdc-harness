import { appendFile, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { basename, dirname } from 'path';

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
 *   process with this PID alive on this machine right now" -- with no network
 *   round trip and no dependency on server clock/expiry behavior. It also
 *   fails toward availability: if the lock is stale (process is dead), the
 *   new instance simply reclaims it and starts, instead of waiting on a
 *   server-side timeout it does not control.
 * - The existing token file convention (join(homedir(), '.config', 'bdc', ...))
 *   already establishes homedir()/.config/bdc as the correct place for this
 *   kind of local-machine state, so the lockfile follows the same pattern.
 */

/**
 * Process exit code when a GENUINE live instance already holds the lock. The Windows
 * launcher (start-windows.ps1) reads it to stop retrying instead of looping.
 */
export const EXIT_ALREADY_RUNNING = 75;

export interface InstanceLockOptions {
  lockFile: string;
  /** Injected for tests; defaults to process.pid. */
  pid?: number;
  /** Injected for tests; defaults to a real liveness check via process.kill(pid, 0). */
  isAlive?: (pid: number) => boolean;
  /**
   * Append-only death log. When acquireInstanceLock reclaims a lock held by a
   * dead PID, it appends one JSON line describing that death here BEFORE the
   * lock is overwritten, so the evidence survives a watchdog restart that would
   * otherwise erase all trace of the death (the heartbeat clock restarts fresh).
   */
  deathLogFile?: string;
  /**
   * Injected for tests; defaults to a real lookup of a process's start time and
   * executable name (PowerShell CIM on Windows, ps elsewhere). Returns null when
   * the identity cannot be read, which is never treated as proof of a stale lock.
   */
  lookupIdentity?: (pid: number) => ProcessIdentity | null;
  /** One-line logger for why a live-PID lock was reclaimed. Defaults to stderr. */
  log?: (line: string) => void;
}

/** What identifies a process beyond its PID, which Windows reuses after a reboot. */
export interface ProcessIdentity {
  /** ISO-8601 UTC process creation time, or null when unknown. */
  start_time: string | null;
  /** Executable file name (for example bun.exe), or null when unknown. */
  executable: string | null;
}

/** The fields of a lock file; start_time and executable are absent in pre-upgrade locks. */
export interface LockContents {
  pid: number | null;
  started_at: string | null;
  start_time: string | null;
  executable: string | null;
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
   * clean start (no prior lock, unparseable lock, or our own pid). Carries the
   * same object that was appended to the death log.
   */
  reclaimed: RestartEvidenceEntry | null;
}

/** Milliseconds in the retention window for restart evidence. */
const RESTART_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Cap on how many recent entries readRestartEvidence returns. */
const RESTART_EVIDENCE_MAX_ENTRIES = 20;

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

export async function readLockContents(lockFile: string): Promise<LockContents> {
  const empty: LockContents = { pid: null, started_at: null, start_time: null, executable: null };
  try {
    const raw = (await readFile(lockFile, 'utf8')).trim();
    const parsed = JSON.parse(raw) as {
      pid?: number;
      started_at?: string;
      start_time?: string;
      executable?: string;
    };
    return {
      pid: typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : null,
      started_at: typeof parsed.started_at === 'string' ? parsed.started_at : null,
      start_time: typeof parsed.start_time === 'string' ? parsed.start_time : null,
      executable: typeof parsed.executable === 'string' ? parsed.executable : null,
    };
  } catch {
    return empty;
  }
}

/**
 * Start times from two lookups of the same process agree to well under a second;
 * 30 s of slack keeps a genuine holder from ever being judged stale by jitter,
 * while a PID reused after a reboot or a crash starts minutes or more later.
 */
const START_TIME_TOLERANCE_MS = 30_000;
/** A genuine holder cannot start after it wrote its own lock; allow clock and rounding slack. */
const LEGACY_START_SLACK_MS = 2_000;

/**
 * Decide whether a lock whose PID is ALIVE still belongs to the process that wrote
 * it. Returns a stale reason only on positive proof of a different process;
 * unknown identity is never proof, so a genuine worker stays protected.
 */
export function classifyAliveHolder(
  lock: LockContents,
  holder: ProcessIdentity | null
): { stale: false } | { stale: true; reason: string } {
  if (!holder) return { stale: false };
  const holderMs = holder.start_time ? Date.parse(holder.start_time) : Number.NaN;

  if (lock.start_time && Number.isFinite(holderMs)) {
    const recordedMs = Date.parse(lock.start_time);
    if (Number.isFinite(recordedMs) && Math.abs(holderMs - recordedMs) > START_TIME_TOLERANCE_MS) {
      return {
        stale: true,
        reason: `holder_start_time_differs recorded=${lock.start_time} observed=${holder.start_time}`,
      };
    }
  }
  if (lock.executable && holder.executable) {
    if (lock.executable.toLowerCase() !== holder.executable.toLowerCase()) {
      return {
        stale: true,
        reason: `holder_executable_differs recorded=${lock.executable} observed=${holder.executable}`,
      };
    }
  }
  if (!lock.start_time && lock.started_at && Number.isFinite(holderMs)) {
    const startedMs = Date.parse(lock.started_at);
    if (Number.isFinite(startedMs) && holderMs > startedMs + LEGACY_START_SLACK_MS) {
      return {
        stale: true,
        reason: `legacy_lock_holder_started_after_lock lock_started_at=${lock.started_at} observed=${holder.start_time}`,
      };
    }
  }
  return { stale: false };
}

/**
 * Real process identity lookup, no new dependency. Windows: one CIM query for the
 * creation time and image name. Elsewhere: ps elapsed seconds and command name.
 * Any failure returns null.
 */
export function defaultLookupIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const script =
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
        "if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') + '|' + $p.Name }";
      const out = Bun.spawnSync(
        ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
        { stdout: 'pipe', stderr: 'ignore', timeout: 10_000 }
      );
      if (out.exitCode !== 0) return null;
      const line = out.stdout.toString().trim();
      const sep = line.indexOf('|');
      if (sep <= 0) return null;
      const startMs = Date.parse(line.slice(0, sep));
      if (!Number.isFinite(startMs)) return null;
      const executable = line.slice(sep + 1).trim();
      return {
        start_time: new Date(startMs).toISOString(),
        executable: executable.length > 0 ? executable : null,
      };
    }
    const out = Bun.spawnSync(['ps', '-o', 'etimes=,comm=', '-p', String(pid)], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 10_000,
    });
    if (out.exitCode !== 0) return null;
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(out.stdout.toString());
    if (!match) return null;
    return {
      start_time: new Date(Date.now() - Number(match[1]) * 1000).toISOString(),
      executable: basename(match[2]),
    };
  } catch {
    return null;
  }
}

/** This process's own identity: the real lookup, else derived from process uptime. */
function ownProcessIdentity(): ProcessIdentity {
  const looked = defaultLookupIdentity(process.pid);
  if (looked) return looked;
  return {
    start_time: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    executable: basename(process.execPath),
  };
}

async function readLockPid(lockFile: string): Promise<number | null> {
  return (await readLockContents(lockFile)).pid;
}

/**
 * Acquire the single-instance lock for this worker id. Throws
 * 'dispatch_worker_already_running' if a live process already holds it.
 * A lock held by a dead PID is treated as stale and reclaimed.
 */
export async function acquireInstanceLock(
  options: InstanceLockOptions
): Promise<InstanceLockHandle> {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? defaultIsAlive;

  const existing = await readLockContents(options.lockFile);
  const existingPid = existing.pid;
  const emit =
    options.log ??
    ((line: string): void => {
      console.error(line);
    });
  // A live PID is a genuine holder only if it is still the process that wrote the lock.
  // Windows reuses PIDs after a reboot (2026-10-19: PID 4220 became atkexComSvc.exe and
  // blocked every start for ten hours), so identity is checked, not just liveness.
  let reusedHolderReason: string | null = null;
  if (existingPid !== null && existingPid !== pid && isAlive(existingPid)) {
    const holder = (options.lookupIdentity ?? defaultLookupIdentity)(existingPid);
    const verdict = classifyAliveHolder(existing, holder);
    if (!verdict.stale) {
      throw new Error(
        `dispatch_worker_already_running: pid ${existingPid} holds ${options.lockFile}`
      );
    }
    reusedHolderReason = verdict.reason;
    emit(
      `dispatch_worker_lock_reclaimed_reused_pid: pid=${existingPid} lock=${options.lockFile} reason=${verdict.reason}`
    );
  }

  // A lock held by a DEAD pid (not ours) is being reclaimed. Journal the death
  // to the append-only death log BEFORE the lock is overwritten -- otherwise a
  // watchdog restart erases the only trace that the previous process died.
  let reclaimed: RestartEvidenceEntry | null = null;
  if (
    existingPid !== null &&
    existingPid !== pid &&
    (reusedHolderReason !== null || !isAlive(existingPid))
  ) {
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
  }

  await mkdir(dirname(options.lockFile), { recursive: true });
  // Record who we are beyond the PID so a later start can tell this process from an
  // unrelated one that reuses the number. Unknown identity is simply omitted.
  const ownIdentity = options.lookupIdentity
    ? options.lookupIdentity(pid)
    : pid === process.pid
      ? ownProcessIdentity()
      : null;
  await writeFile(
    options.lockFile,
    JSON.stringify(
      {
        pid,
        started_at: new Date().toISOString(),
        ...(ownIdentity?.start_time ? { start_time: ownIdentity.start_time } : {}),
        ...(ownIdentity?.executable ? { executable: ownIdentity.executable } : {}),
      },
      null,
      2
    ),
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
        // reclaimed by the next start (dead PID -> not alive -> reclaimed).
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
