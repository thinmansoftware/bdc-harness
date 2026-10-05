import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Desktop watchdog for the Dispatch worker.
 *
 * Task Scheduler's own restart budget (RestartCount) can be exhausted, and its
 * task state can read "Ready" with no live process (last result 0xFFFFFFFF) --
 * i.e. it lies. This watchdog answers the reliable question instead: is a
 * process holding the worker's PID lockfile alive right now? If not (missing
 * lock or dead PID), it starts the worker scheduled task. It is registered as a
 * second, repeating (every 5 minutes, not logon-only) scheduled task so a dead
 * worker restarts without a human.
 */

export const DEFAULT_WATCHDOG_WORKER_ID = 'dispatch-worker-ASUS-ROG-DSK-2T';
export const DEFAULT_WATCHDOG_TASK_NAME = 'BlueDevil-Dispatch-Worker';

export interface WatchdogDeps {
  /** Read the PID recorded in the worker lockfile, or null if absent/unparseable. */
  readLockPid: (lockFile: string) => Promise<number | null>;
  /** Liveness check for a PID. */
  isAlive: (pid: number) => boolean;
  /** Start the worker scheduled task by name. Rejects on failure. */
  startTask: (taskName: string) => Promise<void>;
  /** Structured single-line logger. */
  log: (line: string) => void;
}

export interface WatchdogResult {
  action: 'started' | 'healthy';
}

export function defaultWatchdogLockFile(workerId: string): string {
  return join(homedir(), '.config', 'bdc', `dispatch-worker-${workerId}.lock`);
}

/**
 * Decide and act: if the worker lock is missing or its PID is dead, start the
 * task; otherwise report healthy. Any startTask failure propagates to the
 * caller (runWatchdogMain), which turns it into a loud nonzero exit.
 */
export async function checkWatchdog(
  options: { lockFile: string; taskName: string },
  deps: WatchdogDeps
): Promise<WatchdogResult> {
  const pid = await deps.readLockPid(options.lockFile);
  if (pid !== null && deps.isAlive(pid)) {
    return { action: 'healthy' };
  }
  // Missing lock OR dead PID: there is no live worker process -> start it.
  await deps.startTask(options.taskName);
  return { action: 'started' };
}

/**
 * Main entry. Returns a process exit code: 0 on healthy/started, 1 when the
 * restart attempt itself failed (logged loudly, never silent).
 */
export async function runWatchdogMain(
  options: { lockFile: string; taskName: string },
  deps: WatchdogDeps
): Promise<number> {
  try {
    const result = await checkWatchdog(options, deps);
    deps.log(`dispatch_worker_watchdog_${result.action}: task=${options.taskName}`);
    return 0;
  } catch (error) {
    deps.log(
      `dispatch_worker_watchdog_start_failed: task=${options.taskName} error=${String(error)}`
    );
    return 1;
  }
}

async function realReadLockPid(lockFile: string): Promise<number | null> {
  try {
    const raw = (await readFile(lockFile, 'utf8')).trim();
    const parsed = JSON.parse(raw) as { pid?: number };
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)) return parsed.pid;
    return null;
  } catch {
    return null;
  }
}

function realIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

async function realStartTask(taskName: string): Promise<void> {
  // Windows Task Scheduler: run the already-registered worker task on demand.
  const proc = Bun.spawn(['schtasks.exe', '/Run', '/TN', taskName], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`schtasks_run_failed:${code}:${stderr.trim()}`);
  }
}

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

if (import.meta.main) {
  const workerId = argValue('--worker-id', DEFAULT_WATCHDOG_WORKER_ID);
  const taskName = argValue('--task-name', DEFAULT_WATCHDOG_TASK_NAME);
  const code = await runWatchdogMain(
    { lockFile: defaultWatchdogLockFile(workerId), taskName },
    {
      readLockPid: realReadLockPid,
      isAlive: realIsAlive,
      startTask: realStartTask,
      log: (line: string): void => {
        console.error(line);
      },
    }
  );
  process.exit(code);
}
