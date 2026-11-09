import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquireInstanceLock,
  classifyAliveHolder,
  defaultLookupIdentity,
  readLockContents,
  type ProcessIdentity,
} from './instance-lock';

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
      await acquireInstanceLock({ lockFile, pid: 222, isAlive: () => true });
      await expect(
        acquireInstanceLock({ lockFile, pid: 333, isAlive: () => true })
      ).rejects.toThrow('dispatch_worker_already_running');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reclaims a stale lock left by a dead pid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-lock-'));
    const lockFile = join(dir, 'worker.lock');
    try {
      await acquireInstanceLock({ lockFile, pid: 444, isAlive: () => false });
      const handle = await acquireInstanceLock({ lockFile, pid: 555, isAlive: () => false });
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
});

// WO-HARNESS-DISPATCH-WORKER-STALE-LOCK-01 Tests 1-3: a lock whose PID is alive is only a
// genuine holder if that PID is still the process that wrote it (2026-10-19: PID 4220 was
// reused by atkexComSvc.exe after a reboot and blocked every start for ten hours).
describe('dispatch worker instance lock: process identity', () => {
  const WORKER: ProcessIdentity = {
    start_time: '2026-10-15T02:32:00.000Z',
    executable: 'bun.exe',
  };

  async function withLock(
    contents: Record<string, unknown>,
    run: (lockFile: string, dir: string) => Promise<void>
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-lock-'));
    const lockFile = join(dir, 'worker.lock');
    try {
      await writeFile(lockFile, JSON.stringify(contents), 'utf8');
      await run(lockFile, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('Test 1: a lock whose PID was reused by an unrelated process is reclaimed', async () => {
    await withLock(
      {
        pid: 4220,
        started_at: '2026-10-15T02:32:00.543Z',
        start_time: WORKER.start_time,
        executable: WORKER.executable,
      },
      async (lockFile, dir) => {
        const lines: string[] = [];
        const deathLogFile = join(dir, 'deaths.jsonl');
        const table: Record<number, ProcessIdentity> = {
          4220: { start_time: '2026-10-19T07:49:00.000Z', executable: 'atkexComSvc.exe' },
          9001: { start_time: '2026-10-19T17:07:00.000Z', executable: 'bun.exe' },
        };
        const handle = await acquireInstanceLock({
          lockFile,
          pid: 9001,
          isAlive: pid => pid === 4220,
          lookupIdentity: pid => table[pid] ?? null,
          log: line => lines.push(line),
          deathLogFile,
        });
        const raw = JSON.parse(await readFile(lockFile, 'utf8')) as Record<string, unknown>;
        expect(raw.pid).toBe(9001);
        expect(raw.start_time).toBe('2026-10-19T17:07:00.000Z');
        expect(raw.executable).toBe('bun.exe');
        expect(handle.reclaimed?.previous_pid).toBe(4220);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('reused_pid');
        expect(lines[0]).toContain('holder_start_time_differs');
        const journal = (await readFile(deathLogFile, 'utf8')).trim().split('\n');
        expect(journal).toHaveLength(1);
        expect(JSON.parse(journal[0] as string).previous_pid).toBe(4220);
        await handle.release();
      }
    );
  });

  test('a reused PID is also caught by a different executable alone', async () => {
    await withLock(
      {
        pid: 4220,
        started_at: '2026-10-15T02:32:00.543Z',
        start_time: WORKER.start_time,
        executable: WORKER.executable,
      },
      async lockFile => {
        const handle = await acquireInstanceLock({
          lockFile,
          pid: 9001,
          isAlive: () => true,
          // same start time, different image name
          lookupIdentity: pid =>
            pid === 4220 ? { start_time: WORKER.start_time, executable: 'atkexComSvc.exe' } : null,
          log: () => undefined,
        });
        expect(handle.reclaimed?.previous_pid).toBe(4220);
        await handle.release();
      }
    );
  });

  test('Test 2: a genuine live worker (same start time and executable) still blocks a second instance', async () => {
    await withLock(
      {
        pid: 4220,
        started_at: '2026-10-15T02:32:00.543Z',
        start_time: WORKER.start_time,
        executable: WORKER.executable,
      },
      async lockFile => {
        const before = await readFile(lockFile, 'utf8');
        await expect(
          acquireInstanceLock({
            lockFile,
            pid: 9001,
            isAlive: () => true,
            // the lookup agrees to within a second, as two reads of one process do
            lookupIdentity: () => ({
              start_time: '2026-10-15T02:32:00.800Z',
              executable: 'BUN.EXE',
            }),
            log: () => undefined,
          })
        ).rejects.toThrow('dispatch_worker_already_running');
        expect(await readFile(lockFile, 'utf8')).toBe(before);
      }
    );
  });

  test('an unreadable holder identity never counts as proof: the lock still blocks', async () => {
    await withLock(
      {
        pid: 4220,
        started_at: '2026-10-15T02:32:00.543Z',
        start_time: WORKER.start_time,
        executable: WORKER.executable,
      },
      async lockFile => {
        await expect(
          acquireInstanceLock({
            lockFile,
            pid: 9001,
            isAlive: () => true,
            lookupIdentity: () => null,
            log: () => undefined,
          })
        ).rejects.toThrow('dispatch_worker_already_running');
      }
    );
  });

  test('Test 3: a legacy lock (pid and started_at only) is reclaimed when the holder started later', async () => {
    await withLock({ pid: 4220, started_at: '2026-10-15T02:32:00.543Z' }, async lockFile => {
      const lines: string[] = [];
      const handle = await acquireInstanceLock({
        lockFile,
        pid: 9001,
        isAlive: pid => pid === 4220,
        lookupIdentity: pid =>
          pid === 4220
            ? { start_time: '2026-10-19T07:49:00.000Z', executable: 'atkexComSvc.exe' }
            : { start_time: '2026-10-19T17:07:00.000Z', executable: 'bun.exe' },
        log: line => lines.push(line),
      });
      expect(handle.reclaimed?.previous_pid).toBe(4220);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('legacy_lock_holder_started_after_lock');
      await handle.release();
    });
  });

  test('a legacy lock whose holder started before the lock was written still blocks', async () => {
    await withLock({ pid: 4220, started_at: '2026-10-15T02:32:00.543Z' }, async lockFile => {
      await expect(
        acquireInstanceLock({
          lockFile,
          pid: 9001,
          isAlive: () => true,
          lookupIdentity: () => ({ start_time: '2026-10-15T02:31:59.900Z', executable: 'bun.exe' }),
          log: () => undefined,
        })
      ).rejects.toThrow('dispatch_worker_already_running');
    });
  });

  test('a fresh lock records the holder start_time and executable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-lock-'));
    const lockFile = join(dir, 'worker.lock');
    try {
      const handle = await acquireInstanceLock({
        lockFile,
        pid: 321,
        lookupIdentity: () => WORKER,
      });
      const raw = JSON.parse(await readFile(lockFile, 'utf8')) as Record<string, unknown>;
      expect(raw.start_time).toBe(WORKER.start_time);
      expect(raw.executable).toBe(WORKER.executable);
      await handle.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the real lookup identifies this very process, so a lock this process wrote reads as genuine', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-lock-'));
    const lockFile = join(dir, 'worker.lock');
    try {
      const handle = await acquireInstanceLock({ lockFile, pid: process.pid });
      const lock = await readLockContents(lockFile);
      expect(lock.start_time).not.toBeNull();
      expect(lock.executable).not.toBeNull();
      const observed = defaultLookupIdentity(process.pid);
      expect(observed).not.toBeNull();
      expect(classifyAliveHolder(lock, observed)).toEqual({ stale: false });
      await handle.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
