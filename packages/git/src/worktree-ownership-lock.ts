import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { closeSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { dlopen, read } from 'bun:ffi';

/**
 * Thrown when another process already holds the worktree ownership lock.
 * Callers discriminate with `instanceof` and must not treat the worktree as free.
 */
export class WorktreeOwnershipLockBusyError extends Error {
  readonly worktreePath: string;

  constructor(worktreePath: string) {
    super('ownership lock held');
    this.name = 'WorktreeOwnershipLockBusyError';
    this.worktreePath = worktreePath;
  }
}

interface HeldLock {
  fd: number;
  refcount: number;
}

const heldByCanonicalPath = new Map<string, HeldLock>();
const operationTails = new Map<string, Promise<void>>();

function enqueue<T>(canonical: string, operation: () => Promise<T>): Promise<T> {
  const previous = operationTails.get(canonical) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.then(
    () => undefined,
    () => undefined
  );
  operationTails.set(canonical, settled);
  void settled.then(() => {
    if (operationTails.get(canonical) === settled) {
      operationTails.delete(canonical);
    }
  });
  return current;
}

function canonicalWorktreePath(worktreePath: string): string {
  return realpathSync(worktreePath);
}

const execGit = promisify(execFile);

async function resolveGitCommonDir(canonical: string): Promise<string> {
  const result = await execGit('git', ['-C', canonical, 'rev-parse', '--git-common-dir'], {
    timeout: 15000,
  });
  const raw = (result.stdout ?? '').trim();
  if (!raw) {
    throw new Error(`git common dir missing for ${canonical}`);
  }
  const absolute = isAbsolute(raw) ? raw : resolve(canonical, raw);
  return realpathSync(absolute);
}

// Same advisory lock as util-linux `flock -n`: LOCK_EX|LOCK_NB on the parent fd.
// A spawned `flock` can exit after taking that lock while Bun never reports
// the exit, so acquire must call flock(2) directly and keep this fd open.
const LOCK_EX = 2;
const LOCK_NB = 4;
const EINTR = 4;
const EAGAIN = 11; // Linux defines EWOULDBLOCK as EAGAIN

type FlockLib = ReturnType<typeof loadFlockLib>;

function loadFlockLib(): ReturnType<
  typeof dlopen<{
    flock: { args: ['i32', 'i32']; returns: 'i32' };
    __errno_location: { args: []; returns: 'ptr' };
  }>
> {
  return dlopen('libc.so.6', {
    flock: { args: ['i32', 'i32'], returns: 'i32' },
    __errno_location: { args: [], returns: 'ptr' },
  });
}

let flockLib: FlockLib | undefined;

function getFlockLib(): FlockLib {
  if (!flockLib) flockLib = loadFlockLib();
  return flockLib;
}

function flockNonBlocking(fd: number): 'acquired' | 'busy' {
  const lib = getFlockLib();
  for (let interrupts = 0; interrupts <= 20; interrupts += 1) {
    const rc = lib.symbols.flock(fd, LOCK_EX | LOCK_NB);
    if (rc === 0) return 'acquired';
    const errnoPtr = lib.symbols.__errno_location();
    if (errnoPtr === null) {
      throw new Error('flock failed: errno unavailable');
    }
    const errno = read.i32(errnoPtr);
    if (errno === EINTR) continue;
    if (errno === EAGAIN) return 'busy';
    throw new Error(`flock failed: errno ${errno}`);
  }
  throw new Error('flock interrupted');
}

export async function acquireWorktreeOwnershipLock(worktreePath: string): Promise<void> {
  const canonical = canonicalWorktreePath(worktreePath);
  await enqueue(canonical, async () => {
    const existing = heldByCanonicalPath.get(canonical);
    if (existing && existing.refcount > 0) {
      existing.refcount += 1;
      return;
    }

    const commonDir = await resolveGitCommonDir(canonical);
    const lockDir = join(commonDir, 'archon-worktree-ownership');
    mkdirSync(lockDir, { recursive: true });
    const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const lockPath = join(lockDir, `${digest}.lock`);
    const fd = openSync(lockPath, 'a');
    let outcome: 'acquired' | 'busy';
    try {
      outcome = flockNonBlocking(fd);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    if (outcome === 'busy') {
      closeSync(fd);
      throw new WorktreeOwnershipLockBusyError(canonical);
    }
    heldByCanonicalPath.set(canonical, { fd, refcount: 1 });
  });
}

export async function releaseWorktreeOwnershipLock(worktreePath: string): Promise<void> {
  const canonical = canonicalWorktreePath(worktreePath);
  await enqueue(canonical, async () => {
    const held = heldByCanonicalPath.get(canonical);
    if (!held) return;
    held.refcount -= 1;
    if (held.refcount > 0) return;
    heldByCanonicalPath.delete(canonical);
    closeSync(held.fd);
  });
}

export async function isWorktreeOwnershipLockHeldByThisProcess(
  worktreePath: string
): Promise<boolean> {
  const canonical = canonicalWorktreePath(worktreePath);
  return enqueue(canonical, async () => {
    const held = heldByCanonicalPath.get(canonical);
    return held !== undefined && held.refcount > 0;
  });
}
