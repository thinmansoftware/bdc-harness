import { mkdir, readFile, rm, writeFile } from 'fs/promises';
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
}

export interface InstanceLockHandle {
  release: () => Promise<void>;
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

async function readLockPid(lockFile: string): Promise<number | null> {
  try {
    const raw = (await readFile(lockFile, 'utf8')).trim();
    const parsed = JSON.parse(raw) as { pid?: number };
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)) {
      return parsed.pid;
    }
    return null;
  } catch {
    return null;
  }
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

  const existingPid = await readLockPid(options.lockFile);
  if (existingPid !== null && existingPid !== pid && isAlive(existingPid)) {
    throw new Error(
      `dispatch_worker_already_running: pid ${existingPid} holds ${options.lockFile}`
    );
  }

  await mkdir(dirname(options.lockFile), { recursive: true });
  await writeFile(
    options.lockFile,
    JSON.stringify({ pid, started_at: new Date().toISOString() }, null, 2),
    'utf8'
  );

  let released = false;
  return {
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
