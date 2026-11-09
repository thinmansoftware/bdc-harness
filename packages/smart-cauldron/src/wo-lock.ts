/**
 * wo-lock.ts -- Exclusive active-cascade lock per WO + project.
 *
 * Admission by cascadeId alone does not stop two different cascadeIds from
 * racing the same WO (bdc-xo#1546). This lock is keyed by woId+project so a
 * second cascade cannot start while the first is still non-terminal.
 *
 * Orphan recovery (WO-HARNESS-WO-LOCK-RELEASE-ON-CANCEL-01): a lock is only
 * released by the owning cascade's `finally`, so killing the conductor process
 * left status=running forever and the next fire was refused as a duplicate. The
 * record now carries owner liveness (pid, host, heartbeat) and the runs the
 * cascade fired. A running lock is RECLAIMABLE on acquire when its owner is
 * provably gone (same-host pid dead) or silent (no heartbeat inside the stale
 * window), and a run cancel releases the lock that run belongs to.
 *
 * Exclusivity: every read-check-write on an existing lock (takeover, release,
 * heartbeat, run bookkeeping) runs under a per-lock mutex file created with an
 * exclusive `wx` write, so two callers can never both judge the same lock stale
 * and both take it. Atomic rename alone prevents partial writes but does not
 * serialize ownership; the mutex does.
 */

import { createHash, randomUUID } from 'crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import { hostname } from 'os';
import { join } from 'path';

export type WoLockStatus = 'running' | 'released';

export interface WoLockRecord {
  readonly woId: string;
  readonly project: string;
  readonly cascadeId: string;
  readonly status: WoLockStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Owner process id. Absent on locks written before orphan recovery shipped. */
  readonly pid?: number;
  /** Owner host name; the pid check only applies when it matches this host. */
  readonly host?: string;
  /** Last owner heartbeat (ISO). Absent on legacy locks -- updatedAt is used. */
  readonly heartbeatAt?: string;
  /** Workflow run ids this cascade fired, so a run cancel can find its lock. */
  readonly runIds?: readonly string[];
  /**
   * Runs the OWNING cascade is about to cancel itself (stall timeout) and then
   * climb past. A cancel of one of these must not release the lock: the
   * cascade is alive and still holds the WO.
   */
  readonly selfCancelRunIds?: readonly string[];
}

export interface AcquireWoLockResult {
  readonly acquired: boolean;
  readonly path: string;
  readonly record: WoLockRecord;
  /** Set when a stale running lock was taken over; names the dead cascade. */
  readonly reclaimedFrom?: string;
  /** Why the previous lock was judged stale (set with reclaimedFrom). */
  readonly reclaimReason?: string;
}

/** A running lock with no heartbeat for this long is orphaned. */
export const DEFAULT_WO_LOCK_STALE_MS = 300_000;
/** The owning cascade refreshes its heartbeat this often (well inside the stale window). */
export const DEFAULT_WO_LOCK_HEARTBEAT_MS = 60_000;
/** A mutex file older than this was left by a process that died mid-operation. */
const MUTEX_STALE_MS = 10_000;
/** How long a caller waits for the mutex before giving up. */
const MUTEX_WAIT_MS = 5_000;
const MUTEX_POLL_MS = 15;

class WoLockMutexTimeoutError extends Error {
  constructor(path: string) {
    super(`[smart-cauldron/wo-lock] timed out waiting for lock mutex ${path}`);
    this.name = 'WoLockMutexTimeoutError';
  }
}

function resolveStaleMs(): number {
  const configured = Number.parseInt(process.env.SMART_CAULDRON_WO_LOCK_STALE_MS ?? '', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_WO_LOCK_STALE_MS;
}

function lockPath(outDir: string, woId: string, project: string): string {
  const digest = createHash('sha256').update(`${woId}\n${project}`).digest('hex').slice(0, 24);
  return join(outDir, 'wo-locks', `wo-${digest}.json`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = the process exists but is not ours; only ESRCH proves it is gone.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export interface WoLockStaleness {
  readonly stale: boolean;
  readonly reason: string;
}

/**
 * Decide whether a RUNNING lock is orphaned. Same-host pid dead is immediate
 * proof; otherwise the heartbeat (or updatedAt on a legacy record) must be
 * older than the stale window. A pid on a different host is never probed.
 */
export function assessWoLockStaleness(
  record: WoLockRecord,
  nowMs: number = Date.now(),
  staleMs: number = resolveStaleMs()
): WoLockStaleness {
  if (record.pid !== undefined && record.host === hostname() && !pidAlive(record.pid)) {
    return { stale: true, reason: `owner pid ${record.pid} is not running on ${record.host}` };
  }
  const lastSeen = Date.parse(record.heartbeatAt ?? record.updatedAt);
  if (Number.isNaN(lastSeen)) {
    return { stale: true, reason: 'lock has no readable heartbeat or updatedAt' };
  }
  const ageMs = nowMs - lastSeen;
  if (ageMs > staleMs) {
    return {
      stale: true,
      reason: `no heartbeat for ${Math.round(ageMs / 1000)}s (window ${Math.round(staleMs / 1000)}s)`,
    };
  }
  return { stale: false, reason: 'owner alive' };
}

async function replaceLockFile(filePath: string, record: WoLockRecord): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(record, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(tempPath, filePath);
}

async function readLock(filePath: string): Promise<WoLockRecord | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as WoLockRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding the per-lock mutex. The mutex is a sibling file
 * created with an exclusive write, so only one caller in any process can be
 * inside at a time. A mutex file older than MUTEX_STALE_MS belongs to a process
 * that died mid-operation and is removed (only if it is still the same file
 * we judged stale). Throws WoLockMutexTimeoutError if the mutex stays busy.
 */
async function withLockMutex<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const mutexPath = `${filePath}.mutex`;
  const deadline = Date.now() + MUTEX_WAIT_MS;
  for (;;) {
    try {
      await writeFile(mutexPath, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const seen = await stat(mutexPath);
        if (Date.now() - seen.mtimeMs > MUTEX_STALE_MS) {
          const again = await stat(mutexPath);
          if (again.ino === seen.ino && again.mtimeMs === seen.mtimeMs) {
            await unlink(mutexPath).catch(() => undefined);
          }
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue; // released meanwhile
        throw statError;
      }
      if (Date.now() > deadline) throw new WoLockMutexTimeoutError(mutexPath);
      await sleep(MUTEX_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(mutexPath).catch(() => undefined);
  }
}

export async function acquireWoLock(
  woId: string,
  project: string,
  cascadeId: string,
  outDir = './cascade-runs'
): Promise<AcquireWoLockResult> {
  const filePath = lockPath(outDir, woId, project);
  await mkdir(join(outDir, 'wo-locks'), { recursive: true });
  const now = new Date().toISOString();
  const record: WoLockRecord = {
    woId,
    project,
    cascadeId,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    pid: process.pid,
    host: hostname(),
    heartbeatAt: now,
    runIds: [],
  };

  // The lock file itself is created exclusively, so a fresh acquire is atomic.
  // Everything past EEXIST (takeover of a released or stale lock) is a
  // read-check-write and runs under the mutex, with the decision re-made on a
  // fresh read inside it. Loop only if the lock vanished between the two steps.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(filePath, JSON.stringify(record, null, 2) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
      });
      return { acquired: true, path: filePath, record };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const outcome = await withLockMutex<AcquireWoLockResult | 'retry'>(filePath, async () => {
      const existing = await readLock(filePath);
      if (!existing) return 'retry';
      if (existing.status !== 'running') {
        // Released lock -- take over with a replace.
        await replaceLockFile(filePath, record);
        return { acquired: true, path: filePath, record };
      }
      if (existing.cascadeId === cascadeId) {
        return { acquired: true, path: filePath, record: existing };
      }
      const staleness = assessWoLockStaleness(existing);
      if (staleness.stale) {
        console.log(
          `[smart-cauldron] RECLAIMING stale WO lock woId=${woId} project=${project} ` +
            `from cascadeId=${existing.cascadeId}: ${staleness.reason}`
        );
        await replaceLockFile(filePath, record);
        return {
          acquired: true,
          path: filePath,
          record,
          reclaimedFrom: existing.cascadeId,
          reclaimReason: staleness.reason,
        };
      }
      return { acquired: false, path: filePath, record: existing };
    });
    if (outcome !== 'retry') return outcome;
  }
  throw new Error(`[smart-cauldron/wo-lock] could not settle ownership of ${filePath}`);
}

export async function releaseWoLock(
  woId: string,
  project: string,
  cascadeId: string,
  outDir = './cascade-runs'
): Promise<void> {
  const filePath = lockPath(outDir, woId, project);
  try {
    await withLockMutex(filePath, async () => {
      const existing = await readLock(filePath);
      if (existing?.cascadeId !== cascadeId) return;
      await replaceLockFile(filePath, {
        ...existing,
        status: 'released',
        updatedAt: new Date().toISOString(),
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    // A busy mutex is not a reason to delete a lock we may not own; the stale
    // reclaim covers it. Any other failure: best-effort release -- never fail
    // the cascade on lock cleanup.
    if (error instanceof WoLockMutexTimeoutError) return;
    try {
      await unlink(filePath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Refresh the owner heartbeat on a lock this cascade holds. Returns false when
 * the lock is gone, released, or held by another cascade (the heartbeat loop
 * then has nothing left to protect).
 */
export async function touchWoLockHeartbeat(
  woId: string,
  project: string,
  cascadeId: string,
  outDir = './cascade-runs'
): Promise<boolean> {
  const filePath = lockPath(outDir, woId, project);
  try {
    return await withLockMutex(filePath, async () => {
      const existing = await readLock(filePath);
      if (existing?.status !== 'running' || existing.cascadeId !== cascadeId) return false;
      const now = new Date().toISOString();
      await replaceLockFile(filePath, { ...existing, heartbeatAt: now, updatedAt: now });
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Keep a held lock's heartbeat fresh until the returned stop function is
 * called. The timer is unref'd so it never keeps the process alive.
 */
export function startWoLockHeartbeat(
  woId: string,
  project: string,
  cascadeId: string,
  outDir = './cascade-runs',
  intervalMs: number = DEFAULT_WO_LOCK_HEARTBEAT_MS
): () => void {
  const timer = setInterval(() => {
    void touchWoLockHeartbeat(woId, project, cascadeId, outDir);
  }, intervalMs);
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
  return () => {
    clearInterval(timer);
  };
}

/** Apply `update` to a running lock this cascade holds, under the mutex. Best-effort. */
async function updateOwnedLock(
  woId: string,
  project: string,
  cascadeId: string,
  outDir: string,
  update: (existing: WoLockRecord) => WoLockRecord | null
): Promise<void> {
  const filePath = lockPath(outDir, woId, project);
  try {
    await withLockMutex(filePath, async () => {
      const existing = await readLock(filePath);
      if (existing?.status !== 'running' || existing.cascadeId !== cascadeId) return;
      const next = update(existing);
      if (next) await replaceLockFile(filePath, next);
    });
  } catch {
    /* best-effort: a lock that cannot record bookkeeping still works, it just
       falls back to stale-owner reclaim instead of release-on-cancel */
  }
}

/** Record a fired workflow run on the lock this cascade holds (cancel lookup key). */
export async function recordRunOnWoLock(
  woId: string,
  project: string,
  cascadeId: string,
  runId: string,
  outDir = './cascade-runs'
): Promise<void> {
  await updateOwnedLock(woId, project, cascadeId, outDir, existing => {
    const runIds = existing.runIds ?? [];
    if (runIds.includes(runId)) return null;
    return { ...existing, runIds: [...runIds, runId], updatedAt: new Date().toISOString() };
  });
}

/**
 * Mark a run as one the owning cascade is cancelling itself and will climb
 * past, so the cancel does not release the lock out from under the climb.
 */
export async function markSelfCancelOnWoLock(
  woId: string,
  project: string,
  cascadeId: string,
  runId: string,
  outDir = './cascade-runs'
): Promise<void> {
  await updateOwnedLock(woId, project, cascadeId, outDir, existing => {
    const marked = existing.selfCancelRunIds ?? [];
    if (marked.includes(runId)) return null;
    return {
      ...existing,
      selfCancelRunIds: [...marked, runId],
      updatedAt: new Date().toISOString(),
    };
  });
}

/**
 * Release every running lock that fired `runId`. Called when a run is
 * cancelled: a cancelled run leaves the WO with no live run, so its lock must
 * not keep refusing the next fire. If the owning cascade is still alive it sees
 * the cancel (outcome 'cancelled'), stops, and its own release is a no-op. A run
 * the owner marked as its own stall-cancel (selfCancelRunIds) is skipped.
 *
 * @returns the woIds whose locks were released.
 */
export async function releaseWoLocksForRun(
  runId: string,
  outDir = './cascade-runs'
): Promise<string[]> {
  const dir = join(outDir, 'wo-locks');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const released: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const filePath = join(dir, name);
    try {
      await withLockMutex(filePath, async () => {
        const existing = await readLock(filePath);
        if (existing?.status !== 'running') return;
        if (!(existing.runIds ?? []).includes(runId)) return;
        // The live owner cancelled this run itself and is about to climb: keep the lock.
        if ((existing.selfCancelRunIds ?? []).includes(runId)) return;
        await replaceLockFile(filePath, {
          ...existing,
          status: 'released',
          updatedAt: new Date().toISOString(),
        });
        released.push(existing.woId);
      });
    } catch {
      /* unreadable or busy lock: skip, never fail the cancel */
    }
  }
  return released;
}
