import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireInstanceLock, readRestartEvidence } from './instance-lock';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-death-log-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('instance-lock restart evidence', () => {
  test('Test 12: lock_reclaim_of_a_dead_pid_is_logged_before_the_lock_is_overwritten', async () => {
    const dir = await makeTempDir();
    const lockFile = join(dir, 'worker.lock');
    const deathLogFile = join(dir, 'worker.deaths.jsonl');

    // Run 1: a lock held by dead pid 4242 is reclaimed by a fresh pid.
    await writeFile(
      lockFile,
      JSON.stringify({ pid: 4242, started_at: '2026-09-28T21:00:00.000Z' }),
      'utf8'
    );
    const handle = await acquireInstanceLock({
      lockFile,
      deathLogFile,
      pid: 5000,
      isAlive: (pid: number) => pid !== 4242, // 4242 is dead
    });
    expect(handle.reclaimed).not.toBeNull();
    expect(handle.reclaimed?.previous_pid).toBe(4242);
    expect(handle.reclaimed?.previous_started_at).toBe('2026-09-28T21:00:00.000Z');
    expect(typeof handle.reclaimed?.reclaimed_at).toBe('string');

    // The death log holds exactly that one JSON line...
    const logAfter1 = (await readFile(deathLogFile, 'utf8')).trim().split('\n');
    expect(logAfter1.length).toBe(1);
    const logged = JSON.parse(logAfter1[0]) as Record<string, unknown>;
    expect(logged.previous_pid).toBe(4242);
    expect(logged.previous_started_at).toBe('2026-09-28T21:00:00.000Z');
    expect(logged).toEqual(handle.reclaimed as unknown as Record<string, unknown>);

    // ...written BEFORE the lock was overwritten: the lock now holds the fresh pid.
    const lockAfter1 = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
    expect(lockAfter1.pid).toBe(5000);

    // Run 2: no lock file -> reclaimed null, no new log line.
    await rm(lockFile, { force: true });
    const handle2 = await acquireInstanceLock({
      lockFile,
      deathLogFile,
      pid: 5001,
      isAlive: () => false,
    });
    expect(handle2.reclaimed).toBeNull();

    // Run 3: unparseable lock file -> reclaimed null, no new log line.
    await writeFile(lockFile, 'not-json{{{', 'utf8');
    const handle3 = await acquireInstanceLock({
      lockFile,
      deathLogFile,
      pid: 5002,
      isAlive: () => false,
    });
    expect(handle3.reclaimed).toBeNull();

    // Run 4: lock held by a LIVE pid -> throws, no new log line.
    await writeFile(
      lockFile,
      JSON.stringify({ pid: 6000, started_at: '2026-09-28T22:00:00.000Z' }),
      'utf8'
    );
    await expect(
      acquireInstanceLock({
        lockFile,
        deathLogFile,
        pid: 5003,
        isAlive: (pid: number) => pid === 6000, // 6000 is alive
      })
    ).rejects.toThrow('dispatch_worker_already_running');

    // After runs 2-4 the death log still holds exactly one line (only run 1 wrote).
    const logFinal = (await readFile(deathLogFile, 'utf8')).trim().split('\n');
    expect(logFinal.length).toBe(1);
  });

  test('Test 13: two_restarts_before_any_poll_keep_both_deaths_and_old_ones_expire', async () => {
    const dir = await makeTempDir();
    const lockFile = join(dir, 'worker.lock');
    const deathLogFile = join(dir, 'worker.deaths.jsonl');

    const now = Date.parse('2026-09-28T22:00:00.000Z');
    const nowIso = new Date(now).toISOString();
    const HOUR = 60 * 60 * 1000;

    // Pre-seed: one 25-hour-old line (must expire) + 25 recent lines (within 24h).
    const seedLines: string[] = [
      JSON.stringify({
        previous_pid: 111,
        previous_started_at: '2026-09-27T00:00:00.000Z',
        reclaimed_at: new Date(now - 25 * HOUR).toISOString(),
      }),
    ];
    for (let i = 0; i < 25; i += 1) {
      seedLines.push(
        JSON.stringify({
          previous_pid: 2000 + i,
          previous_started_at: '2026-09-28T20:00:00.000Z',
          reclaimed_at: new Date(now - 1 * HOUR).toISOString(),
        })
      );
    }
    await writeFile(deathLogFile, `${seedLines.join('\n')}\n`, 'utf8');

    // First reclaim: dead pid 4242 -> appends its death.
    await writeFile(
      lockFile,
      JSON.stringify({ pid: 4242, started_at: '2026-09-28T21:00:00.000Z' }),
      'utf8'
    );
    await acquireInstanceLock({
      lockFile,
      deathLogFile,
      pid: 4343,
      isAlive: (pid: number) => pid !== 4242 && pid !== 4343,
    });

    // Second death before any poll: the pid-4343 lock is itself reclaimed.
    await writeFile(
      lockFile,
      JSON.stringify({ pid: 4343, started_at: '2026-09-28T21:30:00.000Z' }),
      'utf8'
    );
    await acquireInstanceLock({
      lockFile,
      deathLogFile,
      pid: 4444,
      isAlive: (pid: number) => pid !== 4242 && pid !== 4343,
    });

    const evidence = await readRestartEvidence(deathLogFile, nowIso);

    // Both deaths present, oldest first -> the second registration carries the first death too.
    const pids = evidence.map(e => e.previous_pid);
    expect(pids).toContain(4242);
    expect(pids).toContain(4343);
    expect(pids.indexOf(4242)).toBeLessThan(pids.indexOf(4343));

    // The 25-hour-old line (pid 111) is dropped.
    expect(pids).not.toContain(111);

    // At most 20 entries returned (the newest window).
    expect(evidence.length).toBe(20);

    // A garbage line is skipped, not thrown.
    await appendFile(deathLogFile, 'not-json{{{\n', 'utf8');
    const afterGarbage = await readRestartEvidence(deathLogFile, nowIso);
    expect(afterGarbage.length).toBe(20);

    // A missing file returns [].
    expect(await readRestartEvidence(join(dir, 'nope.jsonl'), nowIso)).toEqual([]);
  });
});
