import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  endProcessGroup,
  execOwnedProcessGroup,
  isTreeSurvivedError,
  pidsFromWindowsJobList,
  setWindowsOwnedTreeControlForTests,
} from './exec';

const problems: unknown[] = [];
const strayPids: number[] = [];

function onUncaught(err: unknown): void {
  problems.push(err);
}

function onRejection(err: unknown): void {
  problems.push(err);
}

function remember(pid: number): void {
  if (pid > 0) strayPids.push(pid);
}

function processAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state =
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[0] ?? '';
    return state !== '' && state !== 'Z' && state !== 'X';
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}

function stopPid(pid: number): void {
  if (pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // Already gone.
  }
}

afterEach(() => {
  setWindowsOwnedTreeControlForTests(null);
  while (strayPids.length > 0) {
    const pid = strayPids.pop();
    if (pid !== undefined) stopPid(pid);
  }
});

describe('execOwnedProcessGroup spawn errors', () => {
  test('missing executable and invalid cwd reject with the original spawn error', async () => {
    problems.length = 0;
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
    const missingCwd = join(tmpdir(), 'archon-missing-cwd-does-not-exist');
    try {
      const cwdProbe = spawn(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: missingCwd,
        stdio: 'ignore',
      });
      const cwdProbePid = cwdProbe.pid;
      const cwdProbeError = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        cwdProbe.once('error', resolve);
        cwdProbe.once('close', () => {
          reject(new Error('invalid cwd probe closed without an error event'));
        });
      });
      expect(cwdProbePid).toBeUndefined();
      expect(cwdProbeError.code).toBe('ENOENT');

      const cwdErr = await execOwnedProcessGroup(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: missingCwd,
      }).then(
        () => {
          throw new Error('invalid cwd spawn resolved');
        },
        (err: NodeJS.ErrnoException) => err
      );
      expect(cwdErr.code).toBe(cwdProbeError.code);
      expect(cwdErr.syscall).toBe(cwdProbeError.syscall);
      expect(cwdErr.message).not.toContain('spawn failed for');

      const missingBin = join(tmpdir(), 'archon-missing-owned-exec');
      const binProbe = spawn(missingBin, [], { stdio: 'ignore' });
      const binProbePid = binProbe.pid;
      const binProbeError = await new Promise<NodeJS.ErrnoException>(resolve => {
        binProbe.once('error', resolve);
      });
      expect(binProbeError.code).toBe('ENOENT');
      const binErr = await execOwnedProcessGroup(missingBin, []).then(
        () => {
          throw new Error('missing executable spawn resolved');
        },
        (err: NodeJS.ErrnoException) => err
      );
      expect(binErr.code).toBe('ENOENT');
      expect(binErr.syscall).toBe(binProbeError.syscall);
      expect(binErr.message).not.toContain('spawn failed for');
      if (binProbePid === undefined) {
        expect(binErr).toBeInstanceOf(Error);
      }
      expect(problems).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
    }
  });

  test('onSpawn exception is the execution failure and the child is stopped', async () => {
    problems.length = 0;
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
    let spawned = 0;
    try {
      const err = await execOwnedProcessGroup(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        {
          onSpawn(pgid: number): void {
            spawned = pgid;
            remember(pgid);
            throw new Error('spawn-callback-failed');
          },
        }
      ).then(
        () => {
          throw new Error('onSpawn failure resolved');
        },
        (caught: Error) => caught
      );
      expect(err.message).toBe('spawn-callback-failed');
      expect(spawned).toBeGreaterThan(0);
      expect(processAlive(spawned)).toBe(false);
      expect(problems).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
      stopPid(spawned);
    }
  });
});

describe('execOwnedProcessGroup output bound', () => {
  // Three U+00E9 characters are 6 UTF-8 bytes. A 4 byte cap must not pass on a character count.
  const writer = [
    'const chunk = Buffer.from([0xc3, 0xa9, 0xc3, 0xa9, 0xc3, 0xa9]);',
    "const stream = process.env.ARCHON_STREAM === 'stderr' ? process.stderr : process.stdout;",
    'const write = () => { stream.write(chunk); };',
    'write();',
    'setInterval(write, 10);',
  ].join('\n');

  async function overflow(which: 'stdout' | 'stderr'): Promise<
    NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      pgid?: number;
    }
  > {
    let spawned = 0;
    try {
      return await execOwnedProcessGroup(process.execPath, ['-e', writer], {
        maxBuffer: 4,
        env: { ...process.env, ARCHON_STREAM: which },
        onSpawn(pgid: number): void {
          spawned = pgid;
          remember(pgid);
        },
      }).then(
        () => {
          throw new Error(`${which} writer resolved`);
        },
        (err: NodeJS.ErrnoException) => err
      );
    } finally {
      stopPid(spawned);
    }
  }

  test('stdout past the byte cap stops the group and rejects', async () => {
    problems.length = 0;
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
    try {
      const err = await overflow('stdout');
      expect(err.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      expect(Buffer.byteLength(err.stdout ?? '')).toBeLessThanOrEqual(4);
      expect(Buffer.byteLength(err.stderr ?? '')).toBeLessThanOrEqual(4);
      expect(err.pgid ?? 0).toBeGreaterThan(0);
      expect(processAlive(err.pgid ?? 0)).toBe(false);
      expect(problems).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
    }
  });

  test('stderr past the byte cap stops the group and rejects', async () => {
    problems.length = 0;
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
    try {
      const err = await overflow('stderr');
      expect(err.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      expect(Buffer.byteLength(err.stdout ?? '')).toBeLessThanOrEqual(4);
      expect(Buffer.byteLength(err.stderr ?? '')).toBeLessThanOrEqual(4);
      expect(Buffer.byteLength(err.stderr ?? '')).toBeGreaterThan(0);
      expect(err.pgid ?? 0).toBeGreaterThan(0);
      expect(processAlive(err.pgid ?? 0)).toBe(false);
      expect(problems).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('execOwnedProcessGroup timeout descendants', () => {
  test.skipIf(process.platform === 'win32')(
    'timeout ends descendants after the root exits and retires ownership only then',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'archon-owned-desc-'));
      const pidFile = join(dir, 'desc.pid');
      let exitCalls = 0;
      let descendantPid = 0;
      try {
        const err = await execOwnedProcessGroup(
          'bash',
          ['-c', 'sleep 300 & echo $! > "$DESC_PID"; exit 0'],
          {
            timeout: 500,
            env: { ...process.env, DESC_PID: pidFile },
            onSpawn(pgid: number): void {
              remember(pgid);
            },
            onExit(): void {
              const parsed = Number(readFileSync(pidFile, 'utf8').trim());
              if (!Number.isInteger(parsed) || parsed <= 0) {
                throw new Error('descendant pid missing');
              }
              descendantPid = parsed;
              remember(descendantPid);
              exitCalls += 1;
              // Retirement runs only after the group is gone, so the
              // descendant must already be dead inside this callback.
              expect(processAlive(descendantPid)).toBe(false);
            },
          }
        ).then(
          () => {
            throw new Error('descendant timeout resolved');
          },
          (caught: Error & { killed?: boolean; treeSurvived?: boolean }) => caught
        );
        expect(err.killed).toBe(true);
        expect(err.treeSurvived).toBe(false);
        expect(err.message).toContain('Command timed out');
        expect(exitCalls).toBe(1);
        expect(descendantPid).toBeGreaterThan(0);
        expect(processAlive(descendantPid)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

// Redirected stdio so the root can exit while the child stays in the Windows
// job. detached:true would break away from that job and escape taskkill /T.
const orphanLauncher = [
  "const { spawn } = require('child_process');",
  "const fs = require('fs');",
  'const logFd = fs.openSync(process.env.DESC_LOG, "w");',
  'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000000)"], {',
  "  stdio: ['ignore', logFd, logFd],",
  '  windowsHide: true,',
  '});',
  'if (!child.pid) process.exit(2);',
  'fs.writeFileSync(process.env.DESC_PID, String(child.pid));',
  'child.unref();',
  'process.exit(0);',
].join('\n');

describe('execOwnedProcessGroup windows descendants', () => {
  test('job list keeps every pid and rejects a truncated snapshot', () => {
    const buf = new Uint8Array(8 + 16);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 2, true);
    view.setUint32(4, 2, true);
    view.setBigUint64(8, BigInt(10), true);
    view.setBigUint64(16, BigInt(11), true);
    expect(pidsFromWindowsJobList(buf)).toEqual([10, 11]);
    expect(pidsFromWindowsJobList(new Uint8Array(8))).toEqual([]);
    view.setUint32(0, 3, true);
    expect(pidsFromWindowsJobList(buf)).toBeNull();
  });

  test('an unverifiable windows scan does not retire a closed root', async () => {
    setWindowsOwnedTreeControlForTests({
      descendants(): Promise<number[] | null> {
        return Promise.resolve(null);
      },
      taskkill(): Promise<boolean> {
        return Promise.resolve(false);
      },
    });
    let exitCalls = 0;
    const result = await execOwnedProcessGroup(process.execPath, ['-e', 'process.exit(0)'], {
      onExit(): void {
        exitCalls += 1;
      },
    });
    expect(result.pgid).toBeGreaterThan(0);
    expect(exitCalls).toBe(0);
  });

  test('a windows scan with no descendants retires the closed root', async () => {
    setWindowsOwnedTreeControlForTests({
      descendants(): Promise<number[] | null> {
        return Promise.resolve([]);
      },
      taskkill(pid: number): Promise<boolean> {
        return Promise.resolve(processAlive(pid));
      },
    });
    let exitCalls = 0;
    const result = await execOwnedProcessGroup(process.execPath, ['-e', 'process.exit(0)'], {
      onExit(): void {
        exitCalls += 1;
      },
    });
    expect(result.pgid).toBeGreaterThan(0);
    expect(exitCalls).toBe(1);
  });

  test('endProcessGroup keeps a surviving windows descendant as treeSurvived', async () => {
    setWindowsOwnedTreeControlForTests({
      descendants(): Promise<number[] | null> {
        return Promise.resolve([424242]);
      },
      taskkill(): Promise<boolean> {
        return Promise.resolve(false);
      },
    });
    const err = await endProcessGroup(2147483000).then(
      () => {
        throw new Error('surviving windows tree returned');
      },
      (caught: Error) => caught
    );
    expect(isTreeSurvivedError(err)).toBe(true);
  });

  test('endProcessGroup returns when the windows scan proves the tree is gone', async () => {
    setWindowsOwnedTreeControlForTests({
      descendants(): Promise<number[] | null> {
        return Promise.resolve([]);
      },
      taskkill(): Promise<boolean> {
        return Promise.resolve(false);
      },
    });
    await endProcessGroup(2147483000);
  });

  test('windows close taskkills a descendant that outlives the root before retiring', async () => {
    let descendantAlive = true;
    const killed: number[] = [];
    let aliveAtExit: boolean | null = null;
    setWindowsOwnedTreeControlForTests({
      descendants(): Promise<number[] | null> {
        // A root-pid check would report the tree gone here. The descendant
        // is still alive until taskkill runs.
        return Promise.resolve(descendantAlive ? [525252] : []);
      },
      taskkill(pid: number): Promise<boolean> {
        killed.push(pid);
        if (pid === 525252) descendantAlive = false;
        return Promise.resolve(true);
      },
    });
    let exitCalls = 0;
    const result = await execOwnedProcessGroup(process.execPath, ['-e', 'process.exit(0)'], {
      onExit(): void {
        exitCalls += 1;
        aliveAtExit = descendantAlive;
      },
    });
    expect(result.pgid).toBeGreaterThan(0);
    expect(killed).toContain(525252);
    expect(exitCalls).toBe(1);
    expect(aliveAtExit).toBe(false);
  });

  test('successful close taskkills a redirected descendant before retiring', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-owned-win-'));
    const pidFile = join(dir, 'desc.pid');
    const logFile = join(dir, 'desc.log');
    const killed: number[] = [];
    let exitCalls = 0;
    let descendantPid = 0;
    let aliveAtExit: boolean | null = null;
    const simulated = process.platform !== 'win32';
    if (simulated) {
      setWindowsOwnedTreeControlForTests({
        descendants(rootPid: number): Promise<number[] | null> {
          let parsed = 0;
          try {
            parsed = Number(readFileSync(pidFile, 'utf8').trim());
          } catch {
            return Promise.resolve(null);
          }
          if (!Number.isInteger(parsed) || parsed <= 0 || parsed === rootPid) {
            return Promise.resolve([]);
          }
          return Promise.resolve(processAlive(parsed) ? [parsed] : []);
        },
        taskkill(pid: number): Promise<boolean> {
          if (!processAlive(pid)) return Promise.resolve(false);
          killed.push(pid);
          try {
            process.kill(pid, 'SIGKILL');
            return Promise.resolve(true);
          } catch {
            return Promise.resolve(false);
          }
        },
      });
    }
    try {
      const result = await execOwnedProcessGroup(process.execPath, ['-e', orphanLauncher], {
        env: { ...process.env, DESC_PID: pidFile, DESC_LOG: logFile },
        onSpawn(pgid: number): void {
          remember(pgid);
        },
        onExit(): void {
          exitCalls += 1;
          try {
            descendantPid = Number(readFileSync(pidFile, 'utf8').trim());
          } catch {
            descendantPid = -1;
          }
          remember(descendantPid);
          aliveAtExit = processAlive(descendantPid);
        },
      });
      expect(result.pgid).toBeGreaterThan(0);
      expect(exitCalls).toBe(1);
      expect(descendantPid).toBeGreaterThan(1);
      expect(aliveAtExit).toBe(false);
      expect(processAlive(descendantPid)).toBe(false);
      if (simulated) expect(killed).toContain(descendantPid);
    } finally {
      setWindowsOwnedTreeControlForTests(null);
      let leftover = 0;
      try {
        leftover = Number(readFileSync(pidFile, 'utf8').trim());
      } catch {
        leftover = 0;
      }
      stopPid(leftover);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unverified windows timeout rejects as treeSurvived, never a clean timeout', async () => {
    // The root is gone by the time the scan returns, but the scan can never
    // prove the descendant tree empty. A non-gone teardown must reject with
    // treeSurvived so on_timeout: skip cannot proceed past descendants that
    // were never confirmed dead. A closed root plus an unverified scan must
    // not report treeSurvived: false.
    setWindowsOwnedTreeControlForTests({
      descendants(rootPid: number): Promise<number[] | null> {
        // Close the root, then refuse to prove the tree empty.
        try {
          process.kill(rootPid, 'SIGKILL');
        } catch {
          // The root may already be gone.
        }
        return new Promise(resolve => {
          setTimeout(() => resolve(null), 50);
        });
      },
      taskkill(): Promise<boolean> {
        // The scan closes the root; taskkill itself reaches nothing.
        return Promise.resolve(false);
      },
    });
    const err = await execOwnedProcessGroup(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000000)'],
      {
        timeout: 50,
        onSpawn(pgid: number): void {
          remember(pgid);
        },
      }
    ).then(
      () => {
        throw new Error('unverified windows timeout resolved');
      },
      (caught: Error & { killed?: boolean; treeSurvived?: boolean }) => caught
    );
    expect(isTreeSurvivedError(err)).toBe(true);
    expect(err.treeSurvived).toBe(true);
    expect(err.killed).toBe(false);
    expect(err.message).toContain('still running');
    expect(err.message).not.toContain('Command timed out');
  });
});
