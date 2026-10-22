import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquireInstanceLock,
  parseWindowsProcessIdentity,
  type ProcessIdentity,
} from './instance-lock';

const HOLDER_PID = 4220;
const ACQUIRER_PID = 9001;
const OLD_STARTED_AT = '2026-10-15T02:32:00.543Z';
const OLD_START_TIME = '2026-10-15T02:32:00.000Z';
const REUSED_START_TIME = '2026-10-19T07:49:00.000Z';
const ACQUIRER_START_TIME = '2026-10-19T17:07:00.000Z';

function identity(startTime: string, executable: string | null): ProcessIdentity {
  return { start_time: startTime, executable };
}

async function withTempLock(
  run: (paths: { dir: string; lockFile: string; deathLogFile: string }) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-lock-'));
  try {
    await run({
      dir,
      lockFile: join(dir, 'worker.lock'),
      deathLogFile: join(dir, 'worker.deaths.jsonl'),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('dispatch worker instance lock', () => {
  test('acquires a fresh lock and writes the current pid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-lock-'));
    const lockFile = join(dir, 'worker.lock');
    try {
      const handle = await acquireInstanceLock({ lockFile, pid: 111 });
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
      expect(raw.pid).toBe(111);
      await handle.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses to start when another live pid holds the lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-lock-'));
    const lockFile = join(dir, 'worker.lock');
    try {
      const holder = identity(OLD_START_TIME, 'bun.exe');
      const lookupProcess = (procPid: number): ProcessIdentity =>
        procPid === 222 ? holder : identity(ACQUIRER_START_TIME, 'bun.exe');
      await acquireInstanceLock({ lockFile, pid: 222, isAlive: () => true, lookupProcess });
      await expect(
        acquireInstanceLock({ lockFile, pid: 333, isAlive: () => true, lookupProcess })
      ).rejects.toThrow('dispatch_worker_already_running');
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as {
        pid: number;
        start_time: string;
        executable: string;
      };
      expect(raw.pid).toBe(222);
      expect(raw.start_time).toBe(holder.start_time);
      expect(raw.executable).toBe('bun.exe');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reclaims a stale lock left by a dead pid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-lock-'));
    const lockFile = join(dir, 'worker.lock');
    try {
      const seen: number[] = [];
      const lookupProcess = (procPid: number): ProcessIdentity => {
        seen.push(procPid);
        return identity(ACQUIRER_START_TIME, 'bun.exe');
      };
      await acquireInstanceLock({ lockFile, pid: 444, isAlive: () => false, lookupProcess });
      seen.length = 0;
      const handle = await acquireInstanceLock({
        lockFile,
        pid: 555,
        isAlive: () => false,
        lookupProcess,
      });
      // The dead holder is not an identity lookup. Only the new pid is recorded.
      expect(seen).toEqual([555]);
      expect(handle.reclaimed?.previous_pid).toBe(444);
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
      expect(raw.pid).toBe(555);
      await handle.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('release is a no-op once another instance has reclaimed the lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-lock-'));
    const lockFile = join(dir, 'worker.lock');
    try {
      const first = await acquireInstanceLock({ lockFile, pid: 666, isAlive: () => false });
      // Simulate a second instance reclaiming after the first went stale.
      await acquireInstanceLock({ lockFile, pid: 777, isAlive: () => false });
      await first.release();
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
      expect(raw.pid).toBe(777); // first.release() must not remove the newer owner's lock
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('same pid re-acquiring its own lock does not throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-lock-'));
    const lockFile = join(dir, 'worker.lock');
    try {
      await acquireInstanceLock({ lockFile, pid: 888, isAlive: () => true });
      const handle = await acquireInstanceLock({ lockFile, pid: 888, isAlive: () => true });
      await handle.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reused_pid_lock_is_reclaimed', async () => {
    await withTempLock(async ({ lockFile, deathLogFile }) => {
      await writeFile(
        lockFile,
        JSON.stringify({
          pid: HOLDER_PID,
          started_at: OLD_STARTED_AT,
          start_time: OLD_START_TIME,
          executable: 'bun.exe',
        }),
        'utf8'
      );
      const logs: string[] = [];
      const lookupProcess = (procPid: number): ProcessIdentity | null => {
        if (procPid === HOLDER_PID) return identity(REUSED_START_TIME, 'atkexComSvc.exe');
        if (procPid === ACQUIRER_PID) return identity(ACQUIRER_START_TIME, 'bun.exe');
        return null;
      };
      const handle = await acquireInstanceLock({
        lockFile,
        deathLogFile,
        pid: ACQUIRER_PID,
        isAlive: () => true,
        lookupProcess,
        log: message => {
          logs.push(message);
        },
      });
      expect(handle.reclaimed).toBeNull();
      expect(logs).toEqual([`dispatch_worker_lock_stale pid=${HOLDER_PID} reason=start_time`]);
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as {
        pid: number;
        start_time: string;
        executable: string;
      };
      expect(raw.pid).toBe(ACQUIRER_PID);
      expect(raw.start_time).toBe(ACQUIRER_START_TIME);
      expect(raw.executable).toBe('bun.exe');
      await expect(readFile(deathLogFile, 'utf8')).rejects.toThrow();
      await handle.release();
    });
  });

  test('same start_time with a different executable is reclaimed', async () => {
    await withTempLock(async ({ lockFile, deathLogFile }) => {
      await writeFile(
        lockFile,
        JSON.stringify({
          pid: HOLDER_PID,
          started_at: OLD_STARTED_AT,
          start_time: REUSED_START_TIME,
          executable: 'bun.exe',
        }),
        'utf8'
      );
      const logs: string[] = [];
      const handle = await acquireInstanceLock({
        lockFile,
        deathLogFile,
        pid: ACQUIRER_PID,
        isAlive: () => true,
        lookupProcess: procPid =>
          procPid === HOLDER_PID
            ? identity(REUSED_START_TIME, 'atkexComSvc.exe')
            : identity(ACQUIRER_START_TIME, 'bun.exe'),
        log: message => {
          logs.push(message);
        },
      });
      expect(handle.reclaimed).toBeNull();
      expect(logs).toEqual([`dispatch_worker_lock_stale pid=${HOLDER_PID} reason=executable`]);
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
      expect(raw.pid).toBe(ACQUIRER_PID);
      await expect(readFile(deathLogFile, 'utf8')).rejects.toThrow();
      await handle.release();
    });
  });

  test('different start_time with the same executable is reclaimed', async () => {
    await withTempLock(async ({ lockFile }) => {
      await writeFile(
        lockFile,
        JSON.stringify({
          pid: HOLDER_PID,
          started_at: OLD_STARTED_AT,
          start_time: OLD_START_TIME,
          executable: 'bun.exe',
        }),
        'utf8'
      );
      const logs: string[] = [];
      const handle = await acquireInstanceLock({
        lockFile,
        pid: ACQUIRER_PID,
        isAlive: () => true,
        lookupProcess: procPid =>
          procPid === HOLDER_PID
            ? identity(REUSED_START_TIME, 'bun.exe')
            : identity(ACQUIRER_START_TIME, 'bun.exe'),
        log: message => {
          logs.push(message);
        },
      });
      expect(handle.reclaimed).toBeNull();
      expect(logs).toEqual([`dispatch_worker_lock_stale pid=${HOLDER_PID} reason=start_time`]);
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as {
        pid: number;
        start_time: string;
      };
      expect(raw.pid).toBe(ACQUIRER_PID);
      expect(raw.start_time).toBe(ACQUIRER_START_TIME);
      await handle.release();
    });
  });

  test('genuine_live_worker_still_blocks', async () => {
    await withTempLock(async ({ lockFile }) => {
      const holder = identity(REUSED_START_TIME, 'bun.exe');
      const before = JSON.stringify({
        pid: HOLDER_PID,
        started_at: OLD_STARTED_AT,
        start_time: holder.start_time,
        executable: holder.executable,
      });
      await writeFile(lockFile, before, 'utf8');
      const logs: string[] = [];
      await expect(
        acquireInstanceLock({
          lockFile,
          pid: ACQUIRER_PID,
          isAlive: () => true,
          lookupProcess: () => holder,
          log: message => {
            logs.push(message);
          },
        })
      ).rejects.toThrow('dispatch_worker_already_running');
      expect(logs).toEqual([]);
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
      expect(raw.pid).toBe(HOLDER_PID);
    });
  });

  test('legacy_lock_without_identity', async () => {
    await withTempLock(async ({ lockFile, deathLogFile }) => {
      await writeFile(
        lockFile,
        JSON.stringify({ pid: HOLDER_PID, started_at: OLD_STARTED_AT }),
        'utf8'
      );
      const logs: string[] = [];
      const handle = await acquireInstanceLock({
        lockFile,
        deathLogFile,
        pid: ACQUIRER_PID,
        isAlive: () => true,
        lookupProcess: procPid =>
          procPid === HOLDER_PID
            ? identity(REUSED_START_TIME, 'atkexComSvc.exe')
            : identity(ACQUIRER_START_TIME, 'bun.exe'),
        log: message => {
          logs.push(message);
        },
      });
      expect(handle.reclaimed).toBeNull();
      expect(logs).toEqual([`dispatch_worker_lock_stale pid=${HOLDER_PID} reason=legacy_lock`]);
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as {
        pid: number;
        start_time: string;
      };
      expect(raw.pid).toBe(ACQUIRER_PID);
      expect(raw.start_time).toBe(ACQUIRER_START_TIME);
      await expect(readFile(deathLogFile, 'utf8')).rejects.toThrow();
      await handle.release();
    });
  });

  test('legacy lock with an earlier live start time still blocks', async () => {
    await withTempLock(async ({ lockFile }) => {
      await writeFile(
        lockFile,
        JSON.stringify({ pid: HOLDER_PID, started_at: ACQUIRER_START_TIME }),
        'utf8'
      );
      await expect(
        acquireInstanceLock({
          lockFile,
          pid: ACQUIRER_PID,
          isAlive: () => true,
          lookupProcess: () => identity(REUSED_START_TIME, 'atkexComSvc.exe'),
        })
      ).rejects.toThrow('dispatch_worker_already_running');
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
      expect(raw.pid).toBe(HOLDER_PID);
    });
  });

  test('legacy lock with an equal live start time still blocks', async () => {
    await withTempLock(async ({ lockFile }) => {
      await writeFile(
        lockFile,
        JSON.stringify({ pid: HOLDER_PID, started_at: REUSED_START_TIME }),
        'utf8'
      );
      await expect(
        acquireInstanceLock({
          lockFile,
          pid: ACQUIRER_PID,
          isAlive: () => true,
          lookupProcess: () => identity(REUSED_START_TIME, 'bun.exe'),
        })
      ).rejects.toThrow('dispatch_worker_already_running');
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
      expect(raw.pid).toBe(HOLDER_PID);
    });
  });

  test('unparseable recorded start_time fails closed', async () => {
    await withTempLock(async ({ lockFile }) => {
      await writeFile(
        lockFile,
        JSON.stringify({
          pid: HOLDER_PID,
          started_at: OLD_STARTED_AT,
          start_time: 'not-a-time',
          executable: 'bun.exe',
        }),
        'utf8'
      );
      await expect(
        acquireInstanceLock({
          lockFile,
          pid: ACQUIRER_PID,
          isAlive: () => true,
          lookupProcess: () => identity(REUSED_START_TIME, 'atkexComSvc.exe'),
        })
      ).rejects.toThrow('dispatch_worker_already_running');
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
      expect(raw.pid).toBe(HOLDER_PID);
    });
  });

  test('matching start time with a missing executable still blocks', async () => {
    await withTempLock(async ({ lockFile }) => {
      await writeFile(
        lockFile,
        JSON.stringify({
          pid: HOLDER_PID,
          started_at: OLD_STARTED_AT,
          start_time: REUSED_START_TIME,
        }),
        'utf8'
      );
      await expect(
        acquireInstanceLock({
          lockFile,
          pid: ACQUIRER_PID,
          isAlive: () => true,
          lookupProcess: () => identity(REUSED_START_TIME, 'bun.exe'),
        })
      ).rejects.toThrow('dispatch_worker_already_running');
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
      expect(raw.pid).toBe(HOLDER_PID);
    });
  });

  test('parseWindowsProcessIdentity reads CIM JSON and rejects malformed output', () => {
    const stdout = JSON.stringify({
      Name: 'atkexComSvc.exe',
      ExecutablePath: 'C:\\Windows\\System32\\atkexComSvc.exe',
      CreationDate: '/Date(1729324140000)/',
    });
    expect(parseWindowsProcessIdentity(stdout)).toEqual({
      executable: 'atkexComSvc.exe',
      start_time: new Date(1729324140000).toISOString(),
    });

    const withOffset = JSON.stringify({
      Name: 'atkexComSvc.exe',
      ExecutablePath: 'C:\\Windows\\System32\\atkexComSvc.exe',
      CreationDate: '/Date(1729324140000-0400)/',
    });
    expect(parseWindowsProcessIdentity(withOffset)?.start_time).toBe(
      new Date(1729324140000).toISOString()
    );

    const iso = JSON.stringify({
      Name: 'bun.exe',
      CreationDate: '2026-10-19T17:07:00.000Z',
    });
    expect(parseWindowsProcessIdentity(iso)).toEqual({
      executable: 'bun.exe',
      start_time: '2026-10-19T17:07:00.000Z',
    });

    const oneRow = JSON.stringify([{ Name: 'bun.exe', CreationDate: '2026-10-19T17:07:00.000Z' }]);
    expect(parseWindowsProcessIdentity(oneRow)?.executable).toBe('bun.exe');

    expect(parseWindowsProcessIdentity('not-json')).toBeNull();
    expect(parseWindowsProcessIdentity('')).toBeNull();
    expect(parseWindowsProcessIdentity('null')).toBeNull();
    expect(parseWindowsProcessIdentity('{}')).toBeNull();
    expect(
      parseWindowsProcessIdentity(
        JSON.stringify([
          { Name: 'bun.exe', CreationDate: '2026-10-19T17:07:00.000Z' },
          { Name: 'other.exe', CreationDate: '2026-10-19T17:08:00.000Z' },
        ])
      )
    ).toBeNull();
  });
});
