import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execOwnedProcessGroup, procStatInGroup, setVerifiedTeardownForTests } from './exec';

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
  setVerifiedTeardownForTests(null);
  while (strayPids.length > 0) {
    const pid = strayPids.pop();
    if (pid !== undefined) stopPid(pid);
  }
});

describe('procStatInGroup', () => {
  test('a zombie with the owned pgrp still occupies the group', () => {
    const zombieMember = '4243 (worker) Z 4242 4242 4242 0 -1';
    expect(procStatInGroup(zombieMember, 4242)).toBe(true);
  });

  test('a live member occupies the group and an empty state does not', () => {
    expect(procStatInGroup('7 (bash) S 1 99 99 0 -1', 99)).toBe(true);
    expect(procStatInGroup('7 (bash) S 1 99 99 0 -1', 100)).toBe(false);
    expect(procStatInGroup('7 (a) b) R 1 99 99', 99)).toBe(true);
    expect(procStatInGroup('7 (bash)', 7)).toBe(false);
  });
});

describe('execOwnedProcessGroup spawn errors', () => {
  test('owned_spawn_error_rejects: missing executable and invalid cwd reject with the original error', async () => {
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

  test('owned_output_bounded_bytes: stdout past the byte cap stops the group and rejects', async () => {
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

  test('overflow that cannot end the group rejects treeSurvived, not max-buffer', async () => {
    problems.length = 0;
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
    let spawned = 0;
    let exitCalls = 0;
    try {
      const err = await execOwnedProcessGroup(process.execPath, ['-e', writer], {
        maxBuffer: 4,
        verifiedTeardown: false,
        onSpawn(pgid: number): void {
          spawned = pgid;
          remember(pgid);
        },
        onExit(): void {
          exitCalls += 1;
        },
      }).then(
        () => {
          throw new Error('unverifiable overflow resolved');
        },
        (
          caught: NodeJS.ErrnoException & {
            treeSurvived?: boolean;
            killed?: boolean;
          }
        ) => caught
      );
      expect(err.treeSurvived).toBe(true);
      expect(err.killed).toBe(false);
      expect(err.code).not.toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      expect(exitCalls).toBe(0);
      expect(spawned).toBeGreaterThan(0);
      expect(problems).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
      stopPid(spawned);
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
