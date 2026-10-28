import { execFile, spawn } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { mkdir as fsMkdir } from 'fs/promises';
import { promisify } from 'util';

const promisifiedExecFile = promisify(execFile);

/** Wrapper around child_process.execFile for test mockability */
export async function execFileAsync(
  cmd: string,
  args: string[],
  options?: { timeout?: number; cwd?: string; maxBuffer?: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  const result = await promisifiedExecFile(cmd, args, options);
  return {
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
  };
}

/** Wrapper around fs.mkdir for test mockability */
export async function mkdirAsync(path: string, options?: { recursive?: boolean }): Promise<void> {
  await fsMkdir(path, options);
}

// prettier-ignore
/**
 * Accepted limits:
 * (1) a descendant that leaves our process group AND leaves working_path is not detected (closing this needs cgroups; out of scope); (2) only Linux proves teardown; other platforms always report teardown_unverifiable by design; (3) the window between the last non-empty observation and the kill(-pgid) syscall relies on the kernel rule that a live group's pgid is not reallocated.
 *
 * Owned process-group execution for bash and script DAG nodes.
 *
 * Upstream attribution (MIT):
 * - 7c287f52eaad9b500e32b02dc5e0b146f503928a (#4307): a timed-out bash or
 *   script node ends its whole process tree.
 * - 81e432bbfb5f661c6681209c9a23ad6e1b9822e9 (#3446): abandon stops a
 *   reachable owner before releasing the run.
 * - Termination bounds from 646fcfb662bf98437dc7d867f39860f709316070
 *   (TERMINATION_GRACE_MS = 5000, TERMINATION_CONFIRM_MS = 1000).
 */
export const TERMINATION_GRACE_MS = 5000;
export const TERMINATION_CONFIRM_MS = 1000;
const POLL_INTERVAL_MS = 50;

export interface OwnedGroupExecOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  /** When true (the DAG default), a deadline ends the process group, not only the root. */
  endTreeOnTimeout?: boolean;
  /**
   * When false, this spawn is unverifiable: non-detached, and a timeout kills
   * only the direct child and fails with treeSurvived. Undefined uses the
   * Linux /proc probe.
   */
  verifiedTeardown?: boolean;
  /**
   * Called synchronously once the child pid is a positive integer, before any
   * await. The pid is the process-group id on POSIX detached spawn.
   */
  onSpawn?: (pgid: number) => void;
  /**
   * Called only after a /proc pgrp scan observes the group empty.
   * Not called when the tree survives (treeSurvived) or on an unverifiable platform.
   */
  onExit?: (pgid: number) => void;
}

export interface OwnedGroupExecResult {
  stdout: string;
  stderr: string;
  /** Child pid, which is the process-group id on POSIX detached spawn. */
  pgid: number;
}

export interface ProcessGroupControl {
  signal(pid: number, signal: NodeJS.Signals | 0): boolean;
  groupExists(pid: number): boolean;
}

export interface TreeSurvivedError extends Error {
  treeSurvived: true;
  killed: false;
  pgid?: number;
}

let processGroupControl: ProcessGroupControl | null = null;
let verifiedTeardownOverride: boolean | null = null;

/** Test seam. Production leaves this unset. Pass null to restore real signals. */
export function setProcessGroupControlForTests(control: ProcessGroupControl | null): void {
  processGroupControl = control;
}

/** Test seam. null uses the Linux /proc probe. false forces unverifiable teardown. */
export function setVerifiedTeardownForTests(value: boolean | null): void {
  verifiedTeardownOverride = value;
}

/**
 * Verified teardown exists only when the override is not false, the platform
 * is Linux, and /proc can be read. `requested: false` forces the unverifiable path.
 */
export function verifiedTeardownAvailable(requested?: boolean): boolean {
  if (verifiedTeardownOverride === false) return false;
  if (requested === false) return false;
  if (process.platform !== 'linux') return false;
  try {
    readdirSync('/proc');
    return true;
  } catch {
    return false;
  }
}

export function isTreeSurvivedError(err: unknown): err is TreeSurvivedError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { treeSurvived?: unknown }).treeSurvived === true
  );
}

function notifyOwnedExit(options: OwnedGroupExecOptions, pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    options.onExit?.(pid);
  } catch {
    // Retirement must not replace the command result.
  }
}

function treeSurvivedError(pid: number): TreeSurvivedError {
  return Object.assign(
    new Error('Detached workflow process group ' + String(pid) + ' is still running'),
    { treeSurvived: true as const, killed: false as const, pgid: pid }
  );
}

function isTerminablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid;
}

/** True when any non-zombie /proc entry has pgrp == pid. null when /proc cannot be read. */
function liveGroupMember(pid: number): boolean | null {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat = '';
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch {
      continue;
    }
    const after = stat.slice(stat.lastIndexOf(')') + 1).trim();
    const fields = after.split(/\s+/);
    const state = fields[0] ?? '';
    const pgrp = Number(fields[2]);
    if (pgrp === pid && state !== 'Z' && state !== '') return true;
  }
  return false;
}

export function processGroupExists(pid: number): boolean {
  if (!isTerminablePid(pid)) return false;
  if (processGroupControl) return processGroupControl.groupExists(pid);
  if (process.platform !== 'linux') return true;
  const scanned = liveGroupMember(pid);
  // Unreadable /proc cannot prove the group is empty.
  if (scanned === null) return true;
  return scanned;
}

function signalOwnerGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (!isTerminablePid(pid)) return false;
  if (processGroupControl) return processGroupControl.signal(pid, signal);
  if (process.platform !== 'linux') return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function waitUntilGone(exists: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (exists()) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>(resolve => {
      setTimeout(resolve, POLL_INTERVAL_MS);
    });
  }
  return true;
}

/**
 * SIGTERM the process group, wait, SIGKILL, then confirm via the /proc pgrp scan.
 * Throws treeSurvived when the group is still present after the confirm window.
 * An unverifiable platform signals nobody.
 */
export async function endProcessGroup(pid: number): Promise<void> {
  if (!isTerminablePid(pid)) {
    throw treeSurvivedError(pid);
  }
  if (!verifiedTeardownAvailable() && processGroupControl === null) {
    throw treeSurvivedError(pid);
  }
  const signaled = signalOwnerGroup(pid, 'SIGTERM');
  if (!signaled && processGroupExists(pid)) {
    throw treeSurvivedError(pid);
  }
  if (await waitUntilGone(() => processGroupExists(pid), TERMINATION_GRACE_MS)) return;
  const killed = signalOwnerGroup(pid, 'SIGKILL');
  if (!killed && processGroupExists(pid)) {
    throw treeSurvivedError(pid);
  }
  if (!(await waitUntilGone(() => processGroupExists(pid), TERMINATION_CONFIRM_MS))) {
    throw treeSurvivedError(pid);
  }
}

/**
 * Timeout and output-limit handlers share this so group termination and
 * ownership retirement cannot drift.
 *
 * On Linux, always terminate and verify the group. Retire (onExit) only after
 * the /proc scan is empty. An unverifiable platform kills only the direct
 * child and throws treeSurvived so the failure is never a skippable timeout.
 */
async function endOwnedGroupForHandler(
  child: { kill(signal?: NodeJS.Signals | number): boolean },
  pid: number,
  options: OwnedGroupExecOptions,
  verified: boolean
): Promise<void> {
  if (!verified) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The root may already be gone.
    }
    throw treeSurvivedError(pid);
  }
  await endProcessGroup(pid);
  if (!processGroupExists(pid)) notifyOwnedExit(options, pid);
}

/**
 * Spawn a command as the leader of its own process group when teardown is
 * verifiable (Linux, readable /proc). Does not unref the child. On timeout
 * the group is ended; a group that survives is rejected with treeSurvived
 * and is not a timeout. An unverifiable platform spawns non-detached.
 */
function asBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function boundedText(buf: Buffer, maxBuffer: number): string {
  const capped = buf.length > maxBuffer ? buf.subarray(0, maxBuffer) : buf;
  return capped.toString('utf8');
}

export async function execOwnedProcessGroup(
  cmd: string,
  args: string[],
  options: OwnedGroupExecOptions = {}
): Promise<OwnedGroupExecResult> {
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  const verified = verifiedTeardownAvailable(options.verifiedTeardown);
  const child = spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    detached: verified,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  return new Promise<OwnedGroupExecResult>((resolve, reject) => {
    let settled = false;
    let deferredFailure = false;
    let knownPid = -1;
    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    const timer: { id?: ReturnType<typeof setTimeout> } = {};

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer.id !== undefined) clearTimeout(timer.id);
      fn();
    };

    const snapshot = (): { stdout: string; stderr: string } => ({
      stdout: boundedText(stdoutBuf, maxBuffer),
      stderr: boundedText(stderrBuf, maxBuffer),
    });

    // Attach before reading pid. A missing executable or a bad cwd emits
    // 'error' on a later turn, including when pid is still undefined, and an
    // unhandled error event would take down the server.
    child.once('error', (err: Error) => {
      if (settled || deferredFailure) return;
      finish(() => {
        reject(err);
      });
    });
    child.once('close', (code, signal) => {
      if (settled || deferredFailure) return;
      const pgid = knownPid > 0 ? knownPid : (child.pid ?? -1);
      const outcome = { code, signal };
      const settle = (): void => {
        try {
          resolve(settleOwnedClose(cmd, pgid, outcome, snapshot(), maxBuffer));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      finish(() => {
        try {
          // Retire only after a /proc scan observes the group empty. A
          // background child keeps the group alive after the root closes.
          if (verified && pgid > 0 && !processGroupExists(pgid)) notifyOwnedExit(options, pgid);
          settle();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    const pid = child.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return;
    }
    knownPid = pid;

    try {
      options.onSpawn?.(pid);
    } catch (callbackErr) {
      deferredFailure = true;
      const failure = callbackErr instanceof Error ? callbackErr : new Error(String(callbackErr));
      void (async (): Promise<void> => {
        try {
          if (verified) {
            await endProcessGroup(pid);
            if (!processGroupExists(pid)) notifyOwnedExit(options, pid);
          } else {
            try {
              child.kill('SIGKILL');
            } catch {
              // The root may already be gone.
            }
          }
        } catch {
          // The callback error is the execution failure either way.
          // A surviving group stays recorded.
        }
        finish(() => {
          reject(failure);
        });
      })();
      return;
    }

    const beginOverflow = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (settled || deferredFailure) return;
      deferredFailure = true;
      const current = which === 'stdout' ? stdoutBuf : stderrBuf;
      const room = Math.max(0, maxBuffer - current.length);
      const retained = Buffer.concat([current, chunk.subarray(0, room)]);
      if (which === 'stdout') stdoutBuf = retained;
      else stderrBuf = retained;
      if (stdoutBuf.length > maxBuffer) stdoutBuf = stdoutBuf.subarray(0, maxBuffer);
      if (stderrBuf.length > maxBuffer) stderrBuf = stderrBuf.subarray(0, maxBuffer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      void (async (): Promise<void> => {
        try {
          await endOwnedGroupForHandler(child, pid, options, verified);
        } catch {
          // The output-limit error still wins when the group cannot be ended.
          // A surviving group stays recorded.
        }
        const text = snapshot();
        finish(() => {
          reject(
            Object.assign(new Error(`Command failed: ${cmd}`), {
              code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
              stdout: text.stdout,
              stderr: text.stderr,
              killed: false,
              pgid: pid,
            })
          );
        });
      })();
    };

    const onChunk =
      (which: 'stdout' | 'stderr') =>
      (chunk: Buffer | string): void => {
        if (settled || deferredFailure) return;
        const buf = asBuffer(chunk);
        const current = which === 'stdout' ? stdoutBuf : stderrBuf;
        if (current.length + buf.length > maxBuffer) {
          beginOverflow(which, buf);
          return;
        }
        if (which === 'stdout') stdoutBuf = Buffer.concat([stdoutBuf, buf]);
        else stderrBuf = Buffer.concat([stderrBuf, buf]);
      };
    child.stdout?.on('data', onChunk('stdout'));
    child.stderr?.on('data', onChunk('stderr'));

    if (options.timeout === undefined) return;
    const timeoutMs = options.timeout;
    timer.id = setTimeout(() => {
      if (settled || deferredFailure) return;
      deferredFailure = true;
      void (async (): Promise<void> => {
        if (options.endTreeOnTimeout !== false) {
          try {
            // Descendants may still hold pipes after the root exits, so always
            // terminate and verify the group before retirement.
            await endOwnedGroupForHandler(child, pid, options, verified);
          } catch (err) {
            const text = snapshot();
            if (isTreeSurvivedError(err)) {
              finish(() => {
                reject(
                  Object.assign(err, {
                    pgid: pid,
                    stdout: text.stdout,
                    stderr: text.stderr,
                    killed: false,
                    treeSurvived: true,
                  })
                );
              });
              return;
            }
            finish(() => {
              reject(
                Object.assign(err as Error, {
                  pgid: pid,
                  stdout: text.stdout,
                  stderr: text.stderr,
                })
              );
            });
            return;
          }
        } else {
          try {
            child.kill('SIGKILL');
          } catch {
            // The root may already be gone.
          }
        }
        if (child.exitCode === null && child.signalCode === null) {
          await Promise.race([
            new Promise<void>(done => {
              child.once('close', () => {
                done();
              });
            }),
            new Promise<void>(done => {
              setTimeout(done, TERMINATION_CONFIRM_MS);
            }),
          ]);
        }
        const text = snapshot();
        finish(() => {
          reject(
            Object.assign(new Error(`Command timed out after ${String(timeoutMs)}ms`), {
              killed: true,
              code: null,
              stdout: text.stdout,
              stderr: text.stderr,
              pgid: pid,
              treeSurvived: false,
            })
          );
        });
      })();
    }, timeoutMs);
  });
}

function settleOwnedClose(
  cmd: string,
  pgid: number,
  outcome: { code: number | null; signal: NodeJS.Signals | null },
  text: { stdout: string; stderr: string },
  maxBuffer: number
): OwnedGroupExecResult {
  const stdout = text.stdout;
  const stderr = text.stderr;
  if (Buffer.byteLength(stdout) > maxBuffer || Buffer.byteLength(stderr) > maxBuffer) {
    throw Object.assign(new Error(`Command failed: ${cmd}`), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stdout: boundedText(Buffer.from(stdout), maxBuffer),
      stderr: boundedText(Buffer.from(stderr), maxBuffer),
      killed: false,
      pgid,
    });
  }
  if (outcome.code === 0) {
    return { stdout, stderr, pgid };
  }
  throw Object.assign(new Error(`Command failed: ${cmd}`), {
    code: outcome.code ?? 1,
    stdout,
    stderr,
    killed: false,
    pgid,
  });
}
