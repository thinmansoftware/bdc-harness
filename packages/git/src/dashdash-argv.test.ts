/**
 * Real-git check that the argv shapes introduced by clone/fetch/worktree
 * hardening are accepted by git.
 */
import { describe, test, expect } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<void> {
  try {
    await execFileAsync('git', args, { cwd });
  } catch (error) {
    const err = error as Error & { stderr?: string; stdout?: string };
    const detail = err.stderr || err.stdout || err.message;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

describe('git accepts dashdash argv forms', () => {
  test('clone, fetch, and worktree add with -- succeed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-dashdash-'));
    try {
      const origin = join(root, 'origin.git');
      const seed = join(root, 'seed');
      const cloneDir = join(root, 'clone');
      const worktreePath = join(root, 'wt');

      await git(['init', '--bare', origin]);
      await git(['init', '-b', 'dev', seed]);
      await git(['config', 'user.email', 'dashdash@example.com'], seed);
      await git(['config', 'user.name', 'dashdash-test'], seed);
      await writeFile(join(seed, 'README'), 'seed\n');
      await git(['add', 'README'], seed);
      await git(['commit', '-m', 'seed'], seed);
      await git(['remote', 'add', 'origin', origin], seed);
      await git(['push', 'origin', 'dev'], seed);
      await git(['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/dev']);

      await git(['clone', '--', origin, cloneDir]);
      await git(['-C', cloneDir, 'fetch', '--', 'origin', 'dev']);
      await git(['-C', cloneDir, 'worktree', 'add', '-b', 't1', '--', worktreePath, 'origin/dev']);

      await access(join(worktreePath, '.git'));
      expect(true).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
