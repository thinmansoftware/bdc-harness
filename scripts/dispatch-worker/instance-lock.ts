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
 *   process with this PID alive on this machine right now" -- with no network
 *   round trip and no dependency on server clock/expiry behavior. It also
 *   fails toward availability: if the lock is stale (process is dead), the
 *   new instance simply reclaims it and starts, instead of waiting on a
 *   server-side timeout it does not control.
 * - The existing token file convention (join(homedir(), '.config', 'bdc', ...))
 *   already establishes homedir()/.config/bdc as the correct place for this
 *   kind of local-machine state, so the lockfile follows the same pattern.
 */

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

async function readLockContents(
  lockFile: string
): Promise<{ pid: number | null; started_at: string | null }> {
  try {
    const raw = (await readFile(lockFile, 'utf8')).trim();
    const parsed = JSON.parse(raw) as { pid?: number; started_at?: string };
    const pid = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : null;
    const startedAt = typeof parsed.started_at === 'string' ? parsed.started_at : null;
    return { pid, started_at: startedAt };
  } catch {
    return { pid: null, started_at: null };
  }
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
  // Take exactly one liveness reading and reuse it for both the reject and the
  // reclaim decision. Calling isAlive twice would let liveness change (or a PID
  // be reused) between calls, which could reclaim a lock held by a live process
  // -- or throw for one that has since died -- with no matching evidence logged.
  const existingIsForeign = existingPid !== null && existingPid !== pid;
  const existingAlive = existingIsForeign ? isAlive(existingPid) : false;
  if (existingIsForeign && existingAlive) {
    throw new Error(
      `dispatch_worker_already_running: pid ${existingPid} holds ${options.lockFile}`
    );
  }

  // A lock held by a DEAD pid (not ours) is being reclaimed. Journal the death
  // to the append-only death log BEFORE the lock is overwritten -- otherwise a
  // watchdog restart erases the only trace that the previous process died.
  let reclaimed: RestartEvidenceEntry | null = null;
  if (existingIsForeign && !existingAlive) {
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
  await writeFile(
    options.lockFile,
    JSON.stringify({ pid, started_at: new Date().toISOString() }, null, 2),
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
      // The retention contract keeps only entries demonstrably newer than the
      // cutoff. An unparseable timestamp (NaN) cannot demonstrate that, so it
      // is rejected rather than silently retained.
      if (!Number.isFinite(reclaimedMs) || reclaimedMs < cutoffMs) continue;
    }
    entries.push({ previous_pid: pid, previous_started_at: startedAt, reclaimed_at: reclaimedAt });
  }

  if (entries.length > RESTART_EVIDENCE_MAX_ENTRIES) {
    return entries.slice(entries.length - RESTART_EVIDENCE_MAX_ENTRIES);
  }
  return entries;
}
