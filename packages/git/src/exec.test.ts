import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execOwnedProcessGroup } from './exec';

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
