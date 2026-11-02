/**
 * M-51 AMEND-9 gap 4 verification script.
 *
 * This does NOT reboot the Windows host and does NOT touch the real
 * \BlueDevil-Dispatch-Worker Scheduled Task or the live drop-box server. Both
 * of those require a real machine reboot / a live SSH tunnel + operator token
 * against Hetzner, which cannot be exercised honestly from this sandboxed
 * build session. See the "WHAT STILL NEEDS A LIVE CHECK" section printed at
 * the end for exactly what remains.
 *
 * What this DOES verify, against the real instance-lock and worker-log
 * modules (no mocks) using real child processes and a real filesystem:
 *
 *   1. Duplicate-instance refusal: while a lock-holding process is alive, a
 *      second attempt to acquire the same lock is refused.
 *   2. Reboot-recovery-shaped crash simulation: kill the lock-holding process
 *      (simulating an unclean worker death, the closest same-machine analog
 *      to "the process is gone and something needs to start fresh"), then
 *      confirm a new process can acquire the now-stale lock cleanly -- this
 *      is the exact mechanic a Scheduled Task restart-after-failure or an
 *      AtLogOn trigger-after-reboot depends on: the new instance must not be
 *      locked out by a dead process's leftover lockfile.
 *   3. Log rotation stays bounded under repeated writes across process
 *      restarts (append-only across runs, never unbounded).
 *
 * Run with: bun run scripts/dispatch-worker/verify-reboot-recovery.ts
 */

import { spawn } from 'bun';
import { mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorkerLog } from './worker-log';

// NOTE on Windows process identity: `Bun.spawn({ cmd: ['bun', 'run', file] })`
// on Windows does NOT guarantee the pid it returns is the same pid the child
// script sees as its own `process.pid` -- observed directly during this
// verification build (Bun.spawn reported one pid; the child process reported
// a different, higher pid as its own; killing the Bun.spawn-reported pid left
// the real worker process running as an orphan). Anything that needs to kill
// "the process holding the lock" -- this script, and in production a future
// external supervisor/watchdog -- must kill the PID the process itself wrote
// into the lockfile (or reported over stdout), never the pid returned by the
// thing that launched it.
function buildRunnerSource(instanceLockPath: string): string {
  const importSpecifier = instanceLockPath.replace(/\\/g, '/');
  return `
import { acquireInstanceLock } from ${JSON.stringify(importSpecifier)};
const lockFile = process.argv[2];
try {
  const handle = await acquireInstanceLock({ lockFile });
  process.stdout.write('ACQUIRED:' + process.pid + '\\n');
  await new Promise(() => {}); // hold the lock until killed
} catch (error) {
  process.stdout.write('REFUSED:' + (error instanceof Error ? error.message : String(error)) + '\\n');
  process.exit(1);
}
`;
}

function killByRealPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already dead; nothing to do.
  }
}

async function waitForLine(
  stream: ReadableStream<Uint8Array>,
  predicate: (line: string) => boolean,
  timeoutMs: number
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (predicate(line)) return line;
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`timed out waiting for matching line; buffer so far: ${buffer}`);
}

async function main(): Promise<void> {
  const results: { name: string; pass: boolean; detail?: string }[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-reboot-verify-'));
  const workerDir = resolveWorkerDir();
  const runnerPath = join(dir, 'runner.ts');
  await writeFile(runnerPath, buildRunnerSource(join(workerDir, 'instance-lock.ts')), 'utf8');
  const lockFile = join(dir, 'worker.lock');
  const spawnedRealPids: number[] = [];

  try {
    // --- Test 1: first instance acquires the lock cleanly ---
    const first = spawn({
      cmd: ['bun', 'run', runnerPath, lockFile],
      cwd: workerDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let firstRealPid: number | null = null;
    try {
      const line = await waitForLine(
        first.stdout,
        l => l.startsWith('ACQUIRED') || l.startsWith('REFUSED'),
        10_000
      );
      if (line.startsWith('ACQUIRED')) {
        firstRealPid = Number(line.split(':')[1]);
        spawnedRealPids.push(firstRealPid);
      }
      results.push({ name: 'first instance acquires lock', pass: line.startsWith('ACQUIRED') });
    } catch (error) {
      results.push({ name: 'first instance acquires lock', pass: false, detail: String(error) });
    }

    // --- Test 2: a second, concurrently-running instance is refused (gap 1) ---
    const second = spawn({
      cmd: ['bun', 'run', runnerPath, lockFile],
      cwd: workerDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const exitCode = await second.exited;
      const stdoutText = await new Response(second.stdout).text();
      const refused =
        exitCode !== 0 && stdoutText.includes('REFUSED:dispatch_worker_already_running');
      results.push({
        name: 'second concurrent instance is refused',
        pass: refused,
        detail: stdoutText.trim(),
      });
    } catch (error) {
      results.push({
        name: 'second concurrent instance is refused',
        pass: false,
        detail: String(error),
      });
    }

    // --- Test 3: kill the first instance BY ITS REAL PID (simulated
    //     crash/reboot loss), then a fresh instance must be able to reclaim
    //     the now-stale lock. See the killByRealPid comment above: killing
    //     Bun.spawn's own reported pid is NOT sufficient on Windows.
    if (firstRealPid !== null) {
      killByRealPid(firstRealPid);
    }
    await first.exited.catch(() => undefined);
    // Give the OS a beat to fully reap the pid before the liveness check runs.
    await Bun.sleep(500);

    const third = spawn({
      cmd: ['bun', 'run', runnerPath, lockFile],
      cwd: workerDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const line = await waitForLine(
        third.stdout,
        l => l.startsWith('ACQUIRED') || l.startsWith('REFUSED'),
        10_000
      );
      if (line.startsWith('ACQUIRED')) {
        spawnedRealPids.push(Number(line.split(':')[1]));
      }
      results.push({
        name: 'fresh instance reclaims lock after simulated crash',
        pass: line.startsWith('ACQUIRED'),
        detail: line,
      });
    } catch (error) {
      results.push({
        name: 'fresh instance reclaims lock after simulated crash',
        pass: false,
        detail: String(error),
      });
    }

    // --- Test 4: log rotation stays bounded across many writes ---
    const logFile = join(dir, 'worker.log');
    try {
      const log = createWorkerLog({ file: logFile, maxBytes: 200, maxFiles: 3 });
      for (let i = 0; i < 200; i += 1) {
        await log.info(`simulated restart cycle diagnostic line ${i} with padding text`);
      }
      const entries = await readdir(dir);
      const rotated = entries.filter((name: string) => /^worker\.log\.\d+$/.test(name));
      results.push({
        name: 'log rotation stays bounded under sustained writes',
        pass: rotated.length <= 3 && entries.includes('worker.log'),
        detail: `rotated files: ${rotated.join(', ') || 'none'}`,
      });
    } catch (error) {
      results.push({
        name: 'log rotation stays bounded under sustained writes',
        pass: false,
        detail: String(error),
      });
    }
  } finally {
    // Safety net: every ACQUIRED runner holds its lock in an infinite loop by
    // design, so every real pid we saw must be killed by its REAL pid before
    // this script exits, or it leaks as an orphan bun.exe process.
    for (const pid of spawnedRealPids) {
      killByRealPid(pid);
    }
    await rm(dir, { recursive: true, force: true });
  }

  console.log('\n=== M-51 AMEND-9 reboot-recovery verification ===\n');
  let allPass = true;
  for (const result of results) {
    allPass = allPass && result.pass;
    console.log(
      `[${result.pass ? 'PASS' : 'FAIL'}] ${result.name}${result.detail ? ` -- ${result.detail}` : ''}`
    );
  }

  console.log(
    '\n=== WHAT STILL NEEDS A LIVE CHECK (cannot be done from this sandboxed session) ==='
  );
  console.log('- An actual Windows reboot of the operator desktop, followed by confirming');
  console.log('  \\BlueDevil-Dispatch-Worker fires on AtLogOn and the worker re-registers and');
  console.log('  re-heartbeats against the real drop-box server within one poll interval.');
  console.log('- Killing the real worker process (not this simulated runner) while the real');
  console.log('  Scheduled Task is registered, and confirming Task Scheduler restarts it per');
  console.log('  the RestartCount=5 / RestartInterval=1min bound, and that the restarted');
  console.log('  process re-acquires its own real lockfile at');
  console.log('  C:/Users/pcmed/.config/bdc/dispatch-worker-dispatch-worker-ASUS-ROG-DSK-2T.lock');
  console.log('  cleanly (this script proves the lock mechanism itself works; it does not');
  console.log('  prove Task Scheduler is wired to restart the real task -- that requires the');
  console.log('  live host and cannot be faked here).');
  console.log('- Confirming the SSH tunnel in start-windows.ps1 re-establishes cleanly after a');
  console.log('  host reboot (network/DNS/credential state on a cold boot can differ from a');
  console.log('  warm manual run).');
  console.log('- Two CONSECUTIVE reboot cycles proving the above is not a one-off fluke.');
  console.log("These require a live pass from John's desktop and cannot be marked PASS here.");

  process.exit(allPass ? 0 : 1);
}

function resolveWorkerDir(): string {
  return import.meta.dir;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
