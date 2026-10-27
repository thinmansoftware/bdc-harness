import { dlopen, ptr, type Pointer } from 'bun:ffi';
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
  /**
   * Called synchronously once the child pid is a positive integer, before any
   * await. The pid is the process-group id on POSIX detached spawn.
   */
  onSpawn?: (pgid: number) => void;
  /**
   * Called after the owned group has exited, including a timeout whose tree
   * was ended. Not called when the tree survives (treeSurvived).
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

/**
 * Test seam for Windows tree ownership. Production leaves this unset.
 * descendants() returns living descendant pids, or null when the tree
 * cannot be verified. taskkill() force-ends one pid and its children.
 */
export interface WindowsOwnedTreeControl {
  descendants(rootPid: number): Promise<number[] | null>;
  taskkill(pid: number): Promise<boolean>;
}

export interface TreeSurvivedError extends Error {
  treeSurvived: true;
  killed: false;
  pgid?: number;
}

let processGroupControl: ProcessGroupControl | null = null;
let windowsOwnedTreeControl: WindowsOwnedTreeControl | null = null;

/** Test seam. Production leaves this unset. Pass null to restore real signals. */
export function setProcessGroupControlForTests(control: ProcessGroupControl | null): void {
  processGroupControl = control;
}

/** Test seam. Production leaves this unset. Pass null to restore taskkill and job queries. */
export function setWindowsOwnedTreeControlForTests(control: WindowsOwnedTreeControl | null): void {
  windowsOwnedTreeControl = control;
  if (control === null) releaseAllWindowsJobs();
}

function windowsTreeActive(): boolean {
  return process.platform === 'win32' || windowsOwnedTreeControl !== null;
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

/**
 * Timeout and output-limit handlers share this so group termination and
 * ownership retirement cannot drift.
 *
 * POSIX may already have a root exit code while descendants still hold the
 * output pipes. Always terminate and verify the group, and retire only after
 * it is gone. A treeSurvived throw leaves ownership recorded.
 *
 * Windows processGroupExists cannot see descendants after the root exits.
 * taskkill /T /F the recorded pid and any surviving descendants, and retire
 * only when a rescan proves the tree is gone. An unverified closed root
 * stays recorded for terminal teardown.
 */
async function endOwnedGroupForHandler(
  child: { exitCode: number | null; signalCode: NodeJS.Signals | null },
  pid: number,
  options: OwnedGroupExecOptions
): Promise<void> {
  if (windowsTreeActive()) {
    const status = await endWindowsOwnedTree(pid);
    if (status === 'gone') {
      notifyOwnedExit(options, pid);
      return;
    }
    const rootClosed = child.exitCode !== null || child.signalCode !== null;
    if (status === 'survived' || !rootClosed) throw treeSurvivedError(pid);
    return;
  }
  await endProcessGroup(pid);
  if (!processGroupExists(pid)) notifyOwnedExit(options, pid);
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

// Win32 job limits and info classes. Layout of JOBOBJECT_BASIC_LIMIT_INFORMATION
// on x64 puts LimitFlags at byte 16. JOBOBJECT_BASIC_PROCESS_ID_LIST is
// two DWORDs followed by ULONG_PTR pids (8-byte aligned at offset 8).
const JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_INFO_EXTENDED_LIMIT = 9;
const JOB_INFO_PROCESS_ID_LIST = 3;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE_ACCESS = 0x0001;
const JOB_LIST_PID_CAP = 4096;

interface OwnedWindowsJob {
  pids(): number[] | null;
  terminate(): void;
  close(): void;
}

const windowsJobs = new Map<number, OwnedWindowsJob>();

function openKernel32(): {
  CreateJobObjectW(attrs: null, name: null): Pointer | null;
  SetInformationJobObject(job: Pointer, cls: number, info: Pointer, len: number): number;
  OpenProcess(access: number, inherit: number, pid: number): Pointer | null;
  AssignProcessToJobObject(job: Pointer, processHandle: Pointer): number;
  QueryInformationJobObject(
    job: Pointer,
    cls: number,
    info: Pointer,
    len: number,
    returned: null
  ): number;
  TerminateJobObject(job: Pointer, exitCode: number): number;
  CloseHandle(handle: Pointer): number;
} | null {
  try {
    return dlopen('kernel32.dll', {
      CreateJobObjectW: { args: ['ptr', 'ptr'], returns: 'ptr' },
      SetInformationJobObject: { args: ['ptr', 'u32', 'ptr', 'u32'], returns: 'i32' },
      OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'ptr' },
      AssignProcessToJobObject: { args: ['ptr', 'ptr'], returns: 'i32' },
      QueryInformationJobObject: { args: ['ptr', 'u32', 'ptr', 'u32', 'ptr'], returns: 'i32' },
      TerminateJobObject: { args: ['ptr', 'u32'], returns: 'i32' },
      CloseHandle: { args: ['ptr'], returns: 'i32' },
    }).symbols;
  } catch {
    return null;
  }
}

let kernel32: ReturnType<typeof openKernel32> | undefined;

function loadKernel32(): ReturnType<typeof openKernel32> {
  if (kernel32 !== undefined) return kernel32;
  kernel32 = process.platform === 'win32' ? openKernel32() : null;
  return kernel32;
}

/**
 * Read a JobObjectBasicProcessIdList buffer.
 * Returns null when the list is truncated or the header is inconsistent.
 */
export function pidsFromWindowsJobList(buffer: Uint8Array): number[] | null {
  if (buffer.byteLength < 8) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const assigned = view.getUint32(0, true);
  const count = view.getUint32(4, true);
  if (assigned !== count || count > JOB_LIST_PID_CAP) return null;
  if (buffer.byteLength < 8 + count * 8) return null;
  const pids: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = view.getBigUint64(8 + i * 8, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const pid = Number(value);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    pids.push(pid);
  }
  return pids;
}

function readJobPids(handle: Pointer): number[] | null {
  const kernel = loadKernel32();
  if (!kernel) return null;
  const buf = new Uint8Array(8 + JOB_LIST_PID_CAP * 8);
  const ok = kernel.QueryInformationJobObject(
    handle,
    JOB_INFO_PROCESS_ID_LIST,
    ptr(buf),
    buf.byteLength,
    null
  );
  if (ok === 0) return null;
  return pidsFromWindowsJobList(buf);
}

function createWindowsJob(pid: number): OwnedWindowsJob | null {
  const kernel = loadKernel32();
  if (!kernel || !isTerminablePid(pid)) return null;
  const job = kernel.CreateJobObjectW(null, null);
  if (!job) return null;
  const limits = new Uint8Array(144);
  new DataView(limits.buffer).setUint32(16, JOB_LIMIT_KILL_ON_JOB_CLOSE, true);
  kernel.SetInformationJobObject(job, JOB_INFO_EXTENDED_LIMIT, ptr(limits), limits.byteLength);
  const processHandle = kernel.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE_ACCESS, 0, pid);
  if (!processHandle) {
    kernel.CloseHandle(job);
    return null;
  }
  const assigned = kernel.AssignProcessToJobObject(job, processHandle);
  kernel.CloseHandle(processHandle);
  if (assigned === 0) {
    kernel.CloseHandle(job);
    return null;
  }
  const listed = readJobPids(job);
  const rootAlive = windowsPidAlive(pid);
  // A living root missing from the snapshot means the query layout is wrong.
  // A root that already exited may leave a real empty job; keep that handle.
  if (listed === null || (rootAlive && !listed.includes(pid))) {
    kernel.CloseHandle(job);
    return null;
  }
  return {
    pids(): number[] | null {
      return readJobPids(job);
    },
    terminate(): void {
      kernel.TerminateJobObject(job, 1);
    },
    close(): void {
      kernel.CloseHandle(job);
    },
  };
}

function trackWindowsJob(pid: number): void {
  if (process.platform !== 'win32' || windowsOwnedTreeControl) return;
  if (!isTerminablePid(pid) || windowsJobs.has(pid)) return;
  try {
    const job = createWindowsJob(pid);
    if (job) windowsJobs.set(pid, job);
  } catch {
    // No job means the tree stays unverified. Do not retire on root exit.
  }
}

function releaseWindowsJob(pid: number): void {
  const job = windowsJobs.get(pid);
  if (!job) return;
  windowsJobs.delete(pid);
  job.close();
}

function releaseAllWindowsJobs(): void {
  for (const pid of [...windowsJobs.keys()]) releaseWindowsJob(pid);
}

function windowsPidAlive(pid: number): boolean {
  if (!isTerminablePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function taskkillWindowsPid(pid: number): Promise<boolean> {
  if (!isTerminablePid(pid)) return false;
  if (windowsOwnedTreeControl) return windowsOwnedTreeControl.taskkill(pid);
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
    return true;
  } catch {
    return false;
  }
}

async function listWindowsDescendants(rootPid: number): Promise<number[] | null> {
  if (windowsOwnedTreeControl) return windowsOwnedTreeControl.descendants(rootPid);
  const job = windowsJobs.get(rootPid);
  if (!job) return null;
  const pids = job.pids();
  if (pids === null) return null;
  // Job membership survives the root exiting. A parent-pid walk does not:
  // Windows reparents orphans, so an empty parent walk is not an empty tree.
  return pids.filter(pid => pid !== rootPid && isTerminablePid(pid));
}

/**
 * End a Windows-owned tree. A dead root is not proof: taskkill /T /F does
 * not reach orphans, so descendants are killed by pid and the scan must
 * come back empty before the tree is gone.
 */
async function endWindowsOwnedTree(pid: number): Promise<'gone' | 'survived' | 'unverified'> {
  if (!isTerminablePid(pid)) return 'survived';
  try {
    const rootWasAlive = windowsPidAlive(pid);
    const killedRoot = await taskkillWindowsPid(pid);
    const listed = await listWindowsDescendants(pid);
    if (listed === null) {
      // No job snapshot. taskkill /T /F on an already-dead root does not reach
      // reparented children, and the root PID being gone is not an empty tree.
      const job = windowsJobs.get(pid);
      if (job) job.terminate();
      if (!job && rootWasAlive && killedRoot && !windowsPidAlive(pid)) return 'gone';
      return 'unverified';
    }
    for (const child of listed) {
      if (!isTerminablePid(child)) continue;
      await taskkillWindowsPid(child);
    }
    windowsJobs.get(pid)?.terminate();
    let remaining = listed;
    if (listed.length > 0) {
      const deadline = Date.now() + TERMINATION_CONFIRM_MS;
      while (remaining.length > 0) {
        if (Date.now() >= deadline) return 'survived';
        await new Promise<void>(resolve => {
          setTimeout(resolve, POLL_INTERVAL_MS);
        });
        const next = await listWindowsDescendants(pid);
        if (next === null) return 'unverified';
        remaining = next;
      }
    }
    const rootGone = await waitUntilGone(() => windowsPidAlive(pid), TERMINATION_CONFIRM_MS);
    if (!rootGone) return 'survived';
    releaseWindowsJob(pid);
    return 'gone';
  } catch {
    return 'unverified';
  }
}

/**
 * SIGTERM the process group, wait, SIGKILL, then confirm.
 * Throws treeSurvived when the group is still present after the confirm window.
 * On Windows, taskkill /T /F the root and any descendants that outlive it.
 * A dead root with an unverified or surviving tree throws treeSurvived.
 */
export async function endProcessGroup(pid: number): Promise<void> {
  if (!isTerminablePid(pid)) {
    throw treeSurvivedError(pid);
  }
  if (windowsTreeActive()) {
    const status = await endWindowsOwnedTree(pid);
    if (status !== 'gone') throw treeSurvivedError(pid);
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
  const child = spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Assign before the child can background a grandchild. POSIX uses the
  // process group; Windows keeps the tree in a job after the root exits.
  if (typeof child.pid === 'number') trackWindowsJob(child.pid);

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
      if (pgid > 0 && windowsTreeActive()) {
        // Latch before the scan so a later timeout cannot retire or settle first.
        // processGroupExists is not a Windows tree check: after the root exits
        // it cannot see a detached child, and retiring here drops the taskkill.
        deferredFailure = true;
        void (async (): Promise<void> => {
          try {
            const status = await endWindowsOwnedTree(pgid);
            if (status === 'gone') notifyOwnedExit(options, pgid);
          } catch {
            // Keep ownership when the scan fails closed.
          }
          finish(settle);
        })();
        return;
      }
      finish(() => {
        try {
          // Retire only after the group is gone. A background child keeps the
          // group alive after the root closes, and teardown still owns it.
          if (pgid > 0 && !processGroupExists(pgid)) notifyOwnedExit(options, pgid);
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
          await endProcessGroup(pid);
          notifyOwnedExit(options, pid);
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
          await endOwnedGroupForHandler(child, pid, options);
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
            // POSIX may have a set root exit code while descendants still
            // retain pipes, so always terminate and verify the group before
            // retirement. Windows taskkills the root and any detached
            // descendants; an unverified closed root stays recorded.
            await endOwnedGroupForHandler(child, pid, options);
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
                Object.assign(err as Error, { pgid: pid, stdout: text.stdout, stderr: text.stderr })
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
