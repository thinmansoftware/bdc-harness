import { describe, expect, mock, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { checkWatchdog, runWatchdogMain, type WatchdogDeps } from './watchdog';
import type { LockContents, ProcessIdentity } from './instance-lock';

const TASK = 'BlueDevil-Dispatch-Worker';

function deps(overrides: Partial<WatchdogDeps>): WatchdogDeps {
  return {
    readLockPid: mock(async () => null),
    isAlive: mock(() => false),
    readLock: mock(
      async (): Promise<LockContents> => ({
        pid: null,
        started_at: null,
        start_time: null,
        executable: null,
      })
    ),
    lookupIdentity: mock((): ProcessIdentity | null => null),
    startTask: mock(async () => {}),
    log: mock(() => {}),
    ...overrides,
  };
}

describe('dispatch worker watchdog', () => {
  test('Test 7: watchdog_starts_the_task_when_the_lock_pid_is_dead', async () => {
    const startTask = mock(async () => {});
    const d = deps({
      readLockPid: mock(async () => 999999),
      isAlive: mock(() => false), // dead
      startTask,
    });

    const result = await checkWatchdog({ lockFile: '/tmp/x.lock', taskName: TASK }, d);

    expect(result.action).toBe('started');
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask).toHaveBeenCalledWith(TASK);
  });

  test('Test 8: watchdog_does_nothing_when_the_worker_is_alive', async () => {
    const startTask = mock(async () => {});
    const d = deps({
      readLockPid: mock(async () => 4242),
      isAlive: mock(() => true), // alive
      startTask,
    });

    const result = await checkWatchdog({ lockFile: '/tmp/x.lock', taskName: TASK }, d);

    expect(result.action).toBe('healthy');
    expect(startTask).not.toHaveBeenCalled();
  });

  test('Test 9: watchdog_starts_the_task_when_the_lock_file_is_missing', async () => {
    const startTask = mock(async () => {});
    const isAlive = mock(() => true);
    const d = deps({
      readLockPid: mock(async () => null), // missing/unparseable lock
      isAlive,
      startTask,
    });

    const result = await checkWatchdog({ lockFile: '/tmp/missing.lock', taskName: TASK }, d);

    expect(result.action).toBe('started');
    expect(startTask).toHaveBeenCalledTimes(1);
    // A missing lock must not even consult isAlive (no pid to check).
    expect(isAlive).not.toHaveBeenCalled();
  });

  test('Test 10: watchdog_start_failure_is_loud', async () => {
    const lines: string[] = [];
    const d = deps({
      readLockPid: mock(async () => 999999),
      isAlive: mock(() => false), // dead -> will try to start
      startTask: mock(async () => {
        throw new Error('schtasks_run_failed:1:access denied');
      }),
      log: (line: string) => lines.push(line),
    });

    const code = await runWatchdogMain({ lockFile: '/tmp/x.lock', taskName: TASK }, d);

    expect(code).toBe(1);
    expect(lines.some(l => l.includes('dispatch_worker_watchdog_start_failed'))).toBe(true);
  });

  test('Test 11: installer_registers_a_repeating_watchdog_trigger_that_is_not_logon_only', async () => {
    const ps1 = await readFile(join(import.meta.dir, 'install-windows.ps1'), 'utf8');

    // The watchdog task is registered by name.
    expect(ps1).toContain('BlueDevil-Dispatch-Worker-Watchdog');
    // A -Once trigger with a 5-minute repetition interval (not logon-gated).
    expect(ps1).toContain('New-ScheduledTaskTrigger -Once');
    expect(ps1).toContain('RepetitionInterval');
    // MaxValue duration is rejected by modern Task Scheduler; repetition must be indefinite.
    expect(ps1).not.toContain('MaxValue');
    expect(ps1).toContain("Repetition.Duration = ''");
    expect(ps1).toMatch(/New-TimeSpan -Minutes 5/);
    // The original worker task's AtLogOn trigger is still present.
    expect(ps1).toContain('-AtLogOn');
  });
});

describe('dispatch worker watchdog: process identity (WO-HARNESS-DISPATCH-WORKER-STALE-LOCK-01 Test 6)', () => {
  const lock: LockContents = {
    pid: 4220,
    started_at: '2026-10-15T02:32:00.543Z',
    start_time: '2026-10-15T02:32:00.000Z',
    executable: 'bun.exe',
  };

  test('a lock PID reused by an unrelated process is treated as no worker: the task is started, the reason is logged', async () => {
    const startTask = mock(async () => {});
    const lines: string[] = [];
    const d = deps({
      readLockPid: mock(async () => 4220),
      isAlive: mock(() => true),
      readLock: mock(async () => lock),
      lookupIdentity: mock(() => ({
        start_time: '2026-10-19T07:49:00.000Z',
        executable: 'atkexComSvc.exe',
      })),
      startTask,
      log: (line: string) => lines.push(line),
    });

    const result = await checkWatchdog({ lockFile: '/tmp/x.lock', taskName: TASK }, d);

    expect(result.action).toBe('started');
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask).toHaveBeenCalledWith(TASK);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('dispatch_worker_watchdog_reused_pid');
    expect(lines[0]).toContain('pid=4220');
  });

  test('a genuine live holder (same start time and executable) is left alone', async () => {
    const startTask = mock(async () => {});
    const d = deps({
      readLockPid: mock(async () => 4220),
      isAlive: mock(() => true),
      readLock: mock(async () => lock),
      lookupIdentity: mock(() => ({
        start_time: '2026-10-15T02:32:00.400Z',
        executable: 'bun.exe',
      })),
      startTask,
    });

    const result = await checkWatchdog({ lockFile: '/tmp/x.lock', taskName: TASK }, d);

    expect(result.action).toBe('healthy');
    expect(startTask).not.toHaveBeenCalled();
  });

  test('an unreadable identity is not proof: a live holder is left alone', async () => {
    const startTask = mock(async () => {});
    const d = deps({
      readLockPid: mock(async () => 4220),
      isAlive: mock(() => true),
      readLock: mock(async () => lock),
      lookupIdentity: mock(() => null),
      startTask,
    });

    const result = await checkWatchdog({ lockFile: '/tmp/x.lock', taskName: TASK }, d);

    expect(result.action).toBe('healthy');
    expect(startTask).not.toHaveBeenCalled();
  });

  test('a legacy lock whose live holder started after the lock was written is treated as stale', async () => {
    const startTask = mock(async () => {});
    const d = deps({
      readLockPid: mock(async () => 4220),
      isAlive: mock(() => true),
      readLock: mock(async () => ({ ...lock, start_time: null, executable: null })),
      lookupIdentity: mock(() => ({
        start_time: '2026-10-19T07:49:00.000Z',
        executable: 'atkexComSvc.exe',
      })),
      startTask,
    });

    const result = await checkWatchdog({ lockFile: '/tmp/x.lock', taskName: TASK }, d);

    expect(result.action).toBe('started');
    expect(startTask).toHaveBeenCalledTimes(1);
  });

  test('the watchdog never consults identity for a dead or missing lock PID', async () => {
    const lookupIdentity = mock((): ProcessIdentity | null => null);
    const d = deps({
      readLockPid: mock(async () => 999999),
      isAlive: mock(() => false),
      lookupIdentity,
    });

    const result = await checkWatchdog({ lockFile: '/tmp/x.lock', taskName: TASK }, d);

    expect(result.action).toBe('started');
    expect(lookupIdentity).not.toHaveBeenCalled();
  });
});
