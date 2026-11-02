import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { createHarness } from './test-harness';
import { TrackedTree } from './tracked-tree';
import { searchTree, wikiRead } from './tools/wiki';

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key !== 'GIT_DIR' &&
      key !== 'GIT_WORK_TREE' &&
      key !== 'GIT_INDEX_FILE'
    ) {
      env[key] = value;
    }
  }
  return env;
}

async function git(root: string, args: string[]): Promise<void> {
  const code = await gitCode(root, args);
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${code}`);
  }
}

async function gitCode(root: string, args: string[]): Promise<number> {
  const proc = Bun.spawn(['git', '-C', root, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: gitEnv(),
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  if (code !== 0 && code !== 1) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
  return code;
}

async function gitText(root: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', root, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: gitEnv(),
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
  return stdout;
}

async function withCleanClone(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tracked-tree-'));
  const root = join(dir, 'wiki');
  try {
    await mkdir(join(root, 'xo-wiki/wiki'), { recursive: true });
    await writeFile(join(root, 'xo-wiki/wiki/a.md'), 'committed page\n', 'utf8');
    await commitTracked(root);
    await fn(root);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withCommittedBlob(
  content: string,
  fn: (root: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tracked-precondition-'));
  const root = join(dir, 'wiki');
  try {
    await mkdir(join(root, 'xo-wiki/wiki'), { recursive: true });
    await writeFile(join(root, 'xo-wiki/wiki/a.md'), content, 'utf8');
    await commitTracked(root);
    await fn(root);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function commitTracked(root: string): Promise<void> {
  const locked = ['-c', 'core.autocrlf=false'];
  await git(root, [...locked, 'init', '-b', 'main']);
  await git(root, [
    ...locked,
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    'add',
    '--',
    'xo-wiki/wiki/a.md',
  ]);
  await git(root, [
    ...locked,
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-m',
    'init',
  ]);
}

/**
 * Operator deployment precondition. Not used by TrackedTree.start or refresh.
 * Both diffs must be quiet. A single diff against HEAD can hide a staged
 * change that was reversed only in the worktree.
 */
async function trackedTreeIsClean(root: string): Promise<boolean> {
  const worktree = await gitCode(root, ['-c', 'core.autocrlf=false', 'diff', '--quiet', '--']);
  const index = await gitCode(root, [
    '-c',
    'core.autocrlf=false',
    'diff',
    '--cached',
    '--quiet',
    'HEAD',
    '--',
  ]);
  return worktree === 0 && index === 0;
}

describe('tracked tree provisioned reads', () => {
  test('reads a clean tracked page', async () => {
    await withCleanClone(async root => {
      const tree = new TrackedTree(root, 60_000);
      try {
        await tree.start();
        expect(tree.has('xo-wiki/wiki/a.md')).toBe(true);
        const page = await wikiRead(root, tree, 'xo-wiki/wiki/a.md');
        expect(page.text).toBe('committed page\n');
      } finally {
        tree.stop();
      }
    });
  });

  test('untracked secret before startup stays not_tracked across refresh', async () => {
    const harness = await createHarness();
    const tree = new TrackedTree(harness.wikiRoot, 60_000);
    try {
      await tree.start();
      expect(tree.has('xo-wiki/wiki/a.md')).toBe(true);
      expect(tree.has('xo-wiki/wiki/secret.md')).toBe(false);
      const page = await wikiRead(harness.wikiRoot, tree, 'xo-wiki/wiki/a.md');
      expect(page.text).toContain('alpha tracked page');
      await expect(
        wikiRead(harness.wikiRoot, tree, 'xo-wiki/wiki/secret.md')
      ).rejects.toMatchObject({
        code: 'not_tracked',
      });
      const hidden = await searchTree(
        harness.wikiRoot,
        tree,
        'xo-wiki/wiki',
        'UNTRACKED-SECRET-CONTENT',
        20
      );
      expect(JSON.stringify(hidden)).not.toContain('UNTRACKED-SECRET-CONTENT');
      expect(tree.list('xo-wiki/wiki').length).toBeGreaterThan(0);

      await tree.refresh();
      expect(tree.has('xo-wiki/wiki/a.md')).toBe(true);
      expect(tree.has('xo-wiki/wiki/secret.md')).toBe(false);
      expect(tree.list('xo-wiki/wiki').length).toBeGreaterThan(0);
      const again = await wikiRead(harness.wikiRoot, tree, 'xo-wiki/wiki/a.md');
      expect(again.text).toContain('alpha tracked page');
      await expect(
        wikiRead(harness.wikiRoot, tree, 'xo-wiki/wiki/secret.md')
      ).rejects.toMatchObject({
        code: 'not_tracked',
      });
      const hiddenAgain = await searchTree(
        harness.wikiRoot,
        tree,
        'xo-wiki/wiki',
        'UNTRACKED-SECRET-CONTENT',
        20
      );
      expect(JSON.stringify(hiddenAgain)).not.toContain('UNTRACKED-SECRET-CONTENT');
    } finally {
      tree.stop();
      await harness.cleanup();
    }
  });
});

describe('tracked tree deployment precondition', () => {
  test('fails for an unstaged tracked edit', async () => {
    await withCleanClone(async root => {
      expect(await trackedTreeIsClean(root)).toBe(true);
      await writeFile(join(root, 'xo-wiki/wiki/a.md'), 'MODIFIED-TRACKED-CONTENT\n', 'utf8');
      expect(await trackedTreeIsClean(root)).toBe(false);
    });
  });

  test('fails for a staged tracked edit', async () => {
    await withCleanClone(async root => {
      await writeFile(join(root, 'xo-wiki/wiki/a.md'), 'STAGED-TRACKED-CONTENT\n', 'utf8');
      await git(root, ['-c', 'core.autocrlf=false', 'add', '--', 'xo-wiki/wiki/a.md']);
      expect(await trackedTreeIsClean(root)).toBe(false);
    });
  });

  test('fails when a staged edit is reversed only in the worktree', async () => {
    await withCleanClone(async root => {
      await writeFile(join(root, 'xo-wiki/wiki/a.md'), 'STAGED-THEN-REVERSED\n', 'utf8');
      await git(root, ['-c', 'core.autocrlf=false', 'add', '--', 'xo-wiki/wiki/a.md']);
      await writeFile(join(root, 'xo-wiki/wiki/a.md'), 'committed page\n', 'utf8');
      const againstHead = await gitCode(root, [
        '-c',
        'core.autocrlf=false',
        'diff',
        '--quiet',
        'HEAD',
        '--',
      ]);
      expect(againstHead).toBe(0);
      expect(await trackedTreeIsClean(root)).toBe(false);
    });
  });

  test('passes with unrelated untracked files', async () => {
    await withCleanClone(async root => {
      await writeFile(join(root, 'xo-wiki/wiki/secret.md'), 'UNTRACKED-SECRET-CONTENT\n', 'utf8');
      expect(await trackedTreeIsClean(root)).toBe(true);
    });
  });

  test('passes for clean committed LF and CRLF blobs', async () => {
    await withCommittedBlob('committed page\n', async root => {
      const blob = await gitText(root, [
        '-c',
        'core.autocrlf=false',
        'show',
        'HEAD:xo-wiki/wiki/a.md',
      ]);
      expect(blob.includes('\r')).toBe(false);
      expect(await trackedTreeIsClean(root)).toBe(true);
    });
    await withCommittedBlob('committed page\r\n', async root => {
      const blob = await gitText(root, [
        '-c',
        'core.autocrlf=false',
        'show',
        'HEAD:xo-wiki/wiki/a.md',
      ]);
      expect(blob.includes('\r\n')).toBe(true);
      expect(await trackedTreeIsClean(root)).toBe(true);
    });
  });
});
