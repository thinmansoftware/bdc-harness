import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireWorktreeOwnershipLock,
  isWorktreeOwnershipLockHeldByThisProcess,
  releaseWorktreeOwnershipLock,
  WorktreeOwnershipLockBusyError,
} from './worktree-ownership-lock';

const roots: string[] = [];

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function makeWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-lock-'));
  roots.push(root);
  const main = join(root, 'main');
  const worktree = join(root, 'wt');
  runGit(root, ['init', '-b', 'main', main]);
  runGit(main, ['config', 'user.email', 'test@test.com']);
  runGit(main, ['config', 'user.name', 'Test']);
  writeFileSync(join(main, 'README.md'), 'init\n');
  runGit(main, ['add', 'README.md']);
  runGit(main, ['commit', '-m', 'init']);
  runGit(main, ['worktree', 'add', '-b', 'feat', worktree]);
  return worktree;
}

interface LockHolder {
  release(): Promise<void>;
}

async function readUntil(stream: ReadableStream<Uint8Array>, marker: string): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (!buf.includes(marker)) {
    const next = await reader.read();
    if (next.done) return buf;
    buf += decoder.decode(next.value, { stream: true });
  }
  return buf;
}

async function holdLockInOtherProcess(worktreePath: string): Promise<LockHolder> {
  const modulePath = join(import.meta.dir, 'worktree-ownership-lock.ts');
  const script = `
    const mod = await import(${JSON.stringify(modulePath)});
    await mod.acquireWorktreeOwnershipLock(process.argv[1]);
    process.stdout.write('HELD\\n');
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    await mod.releaseWorktreeOwnershipLock(process.argv[1]);
    process.stdout.write('RELEASED\\n');
  `;
  const proc = Bun.spawn(['bun', '-e', script, worktreePath], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let stderr = '';
  const stderrTask = (async (): Promise<void> => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      stderr += decoder.decode(next.value, { stream: true });
    }
  })();
  const ready = await readUntil(proc.stdout, 'HELD\n');
  if (!ready.includes('HELD\n')) {
    proc.kill();
    await proc.exited;
    await stderrTask;
    throw new Error(`lock holder failed to start: ${stderr}`);
  }
  return {
    release: async (): Promise<void> => {
      proc.stdin.end();
      const code = await proc.exited;
      await stderrTask;
      if (code !== 0) {
        throw new Error(`lock holder exited ${code}: ${stderr}`);
      }
    },
  };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('worktree ownership lock', () => {
  test('another process cannot acquire while this process holds the lock, and can after release', async () => {
    const worktree = makeWorktree();
    await acquireWorktreeOwnershipLock(worktree);
    const holderScript = `
      const mod = await import(${JSON.stringify(join(import.meta.dir, 'worktree-ownership-lock.ts'))});
      try {
        await mod.acquireWorktreeOwnershipLock(process.argv[1]);
        process.stdout.write('ACQUIRED\\n');
        await mod.releaseWorktreeOwnershipLock(process.argv[1]);
      } catch (err) {
        if (err instanceof mod.WorktreeOwnershipLockBusyError) {
          process.stdout.write('BUSY\\n');
          process.exit(0);
        }
        process.stderr.write(String(err));
        process.exit(1);
      }
    `;
    const busy = Bun.spawnSync(['bun', '-e', holderScript, worktree], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(busy.stdout.toString(), busy.stderr.toString()).toContain('BUSY');

    await releaseWorktreeOwnershipLock(worktree);
    expect(await isWorktreeOwnershipLockHeldByThisProcess(worktree)).toBe(false);

    const free = Bun.spawnSync(['bun', '-e', holderScript, worktree], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(free.stdout.toString(), free.stderr.toString()).toContain('ACQUIRED');
    expect(free.exitCode).toBe(0);
  });

  test('same-process acquire refcounts and the lock drops only at zero', async () => {
    const worktree = makeWorktree();
    await acquireWorktreeOwnershipLock(worktree);
    await acquireWorktreeOwnershipLock(worktree);
    expect(await isWorktreeOwnershipLockHeldByThisProcess(worktree)).toBe(true);
    await releaseWorktreeOwnershipLock(worktree);
    expect(await isWorktreeOwnershipLockHeldByThisProcess(worktree)).toBe(true);
    await releaseWorktreeOwnershipLock(worktree);
    expect(await isWorktreeOwnershipLockHeldByThisProcess(worktree)).toBe(false);
    await acquireWorktreeOwnershipLock(worktree);
    await releaseWorktreeOwnershipLock(worktree);
  });

  test('a separate process holding the helper blocks a bash flock of the same canonical path', async () => {
    const worktree = makeWorktree();
    const holder = await holdLockInOtherProcess(worktree);
    try {
      await expect(acquireWorktreeOwnershipLock(worktree)).rejects.toBeInstanceOf(
        WorktreeOwnershipLockBusyError
      );
      const probe = Bun.spawnSync(
        [
          'bash',
          '-c',
          `
          set -euo pipefail
          canon=$(readlink -f "$1")
          common_raw=$(git -C "$canon" rev-parse --git-common-dir)
          case "$common_raw" in
            /*) common=$common_raw ;;
            *) common=$(readlink -f "$canon/$common_raw") ;;
          esac
          digest=$(printf '%s' "$canon" | sha256sum | awk '{print $1}')
          lock="$common/archon-worktree-ownership/$digest.lock"
          if flock -n "$lock" -c 'echo ACQUIRED'; then
            echo ACQUIRED
            exit 0
          fi
          echo BUSY
          `,
          'bash',
          worktree,
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      expect(probe.stdout.toString(), probe.stderr.toString()).toContain('BUSY');
      expect(probe.stdout.toString()).not.toContain('ACQUIRED');
    } finally {
      await holder.release();
    }
  });
});
