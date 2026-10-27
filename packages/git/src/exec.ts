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

/**
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

/** Test seam. Production leaves this unset. Pass null to restore real signals. */
export function setProcessGroupControlForTests(control: ProcessGroupControl | null): void {
  processGroupControl = control;
}

export function isTreeSurvivedError(err: unknown): err is TreeSurvivedError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { treeSurvived?: unknown }).treeSurvived === true
  );
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

function liveGroupMember(pid: number): boolean | null {
  if (process.platform === 'win32') return null;
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
  const scanned = liveGroupMember(pid);
  if (scanned !== null) return scanned;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalOwnerGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (!isTerminablePid(pid)) return false;
  if (processGroupControl) return processGroupControl.signal(pid, signal);
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
 * SIGTERM the process group, wait, SIGKILL, then confirm.
 * Throws treeSurvived when the group is still present after the confirm window.
 * On Windows, taskkill /T /F ends the tree.
 */
export async function endProcessGroup(pid: number): Promise<void> {
  if (!isTerminablePid(pid)) {
    throw treeSurvivedError(pid);
  }
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
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
 * Spawn a command as the leader of its own process group (POSIX detached).
 * Does not unref the child. On timeout with endTreeOnTimeout, the group is
 * ended; a group that survives is rejected with treeSurvived and is not a timeout.
 */
export async function execOwnedProcessGroup(
  cmd: string,
  args: string[],
  options: OwnedGroupExecOptions = {}
): Promise<OwnedGroupExecResult> {
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  const child = spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pgid = child.pid;
  if (pgid === undefined) {
    throw Object.assign(new Error(`spawn failed for ${cmd}`), { code: 'ENOENT' });
  }

  let stdout = '';
  let stderr = '';
  const onChunk =
    (which: 'stdout' | 'stderr') =>
    (buf: Buffer): void => {
      if (which === 'stdout') stdout += buf.toString();
      else stderr += buf.toString();
    };
  child.stdout?.on('data', onChunk('stdout'));
  child.stderr?.on('data', onChunk('stderr'));

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        resolve({ code, signal });
      });
    }
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (options.timeout === undefined) {
      const outcome = await closed;
      return settleOwnedClose(cmd, pgid, outcome, stdout, stderr, maxBuffer);
    }
    const timeoutMs = options.timeout;
    const winner = await Promise.race([
      closed.then(outcome => ({ kind: 'close' as const, outcome })),
      new Promise<{ kind: 'timeout' }>(resolve => {
        timer = setTimeout(() => {
          resolve({ kind: 'timeout' });
        }, timeoutMs);
      }),
    ]);
    if (winner.kind === 'close') {
      return settleOwnedClose(cmd, pgid, winner.outcome, stdout, stderr, maxBuffer);
    }
    if (options.endTreeOnTimeout !== false) {
      try {
        await endProcessGroup(pgid);
      } catch (err) {
        if (isTreeSurvivedError(err)) {
          throw Object.assign(err, { pgid, stdout, stderr, killed: false, treeSurvived: true });
        }
        throw Object.assign(err as Error, { pgid, stdout, stderr });
      }
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        // The root may already be gone.
      }
    }
    await Promise.race([
      closed.then(() => undefined).catch(() => undefined),
      new Promise<void>(resolve => {
        setTimeout(resolve, TERMINATION_CONFIRM_MS);
      }),
    ]);
    throw Object.assign(new Error(`Command timed out after ${String(timeoutMs)}ms`), {
      killed: true,
      code: null,
      stdout,
      stderr,
      pgid,
      treeSurvived: false,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function settleOwnedClose(
  cmd: string,
  pgid: number,
  outcome: { code: number | null; signal: NodeJS.Signals | null },
  stdout: string,
  stderr: string,
  maxBuffer: number
): OwnedGroupExecResult {
  if (stdout.length > maxBuffer || stderr.length > maxBuffer) {
    throw Object.assign(new Error(`Command failed: ${cmd}`), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stdout,
      stderr,
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
