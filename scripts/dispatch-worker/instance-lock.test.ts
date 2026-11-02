import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireInstanceLock } from './instance-lock';

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
