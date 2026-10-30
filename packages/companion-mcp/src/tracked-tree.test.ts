import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { createHarness, startFromHarness } from './test-harness';
import { TrackedTree } from './tracked-tree';
import { wikiRead } from './tools/wiki';

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
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

async function withCleanClone(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tracked-tree-'));
  const root = join(dir, 'wiki');
  try {
    await mkdir(join(root, 'xo-wiki/wiki'), { recursive: true });
    await writeFile(join(root, 'xo-wiki/wiki/a.md'), 'committed page\n', 'utf8');
    await git(root, ['init', '-b', 'main']);
    await git(root, ['add', '--', 'xo-wiki/wiki/a.md']);
    await git(root, [
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
    await fn(root);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('tracked tree clean clone', () => {
  test('start fails closed before serving a modified tracked file', async () => {
    await withCleanClone(async root => {
      await writeFile(join(root, 'xo-wiki/wiki/a.md'), 'MODIFIED-TRACKED-CONTENT\n', 'utf8');
      const tree = new TrackedTree(root, 60_000);
      try {
        await expect(tree.start()).rejects.toThrow('wiki_root_dirty');
        expect(tree.has('xo-wiki/wiki/a.md')).toBe(false);
        await expect(wikiRead(root, tree, 'xo-wiki/wiki/a.md')).rejects.toMatchObject({
          code: 'not_tracked',
        });
      } finally {
        tree.stop();
      }
    });
  });

  test('start fails closed before serving when an untracked file exists', async () => {
    await withCleanClone(async root => {
      await writeFile(join(root, 'xo-wiki/wiki/secret.md'), 'UNTRACKED-SECRET-CONTENT\n', 'utf8');
      const tree = new TrackedTree(root, 60_000);
      try {
        await expect(tree.start()).rejects.toThrow('wiki_root_dirty');
        expect(tree.has('xo-wiki/wiki/a.md')).toBe(false);
        expect(tree.has('xo-wiki/wiki/secret.md')).toBe(false);
      } finally {
        tree.stop();
      }
    });
  });

  test('refresh fails closed on dirty and untracked clones', async () => {
    await withCleanClone(async root => {
      const tree = new TrackedTree(root, 60_000);
      await tree.start();
      try {
        const served = await wikiRead(root, tree, 'xo-wiki/wiki/a.md');
        expect(served.text).toBe('committed page\n');

        await writeFile(join(root, 'xo-wiki/wiki/a.md'), 'MODIFIED-TRACKED-CONTENT\n', 'utf8');
        await expect(tree.refresh()).rejects.toThrow('wiki_root_dirty');
        expect(tree.has('xo-wiki/wiki/a.md')).toBe(false);
        await expect(wikiRead(root, tree, 'xo-wiki/wiki/a.md')).rejects.toMatchObject({
          code: 'not_tracked',
        });

        await writeFile(join(root, 'xo-wiki/wiki/a.md'), 'committed page\n', 'utf8');
        await tree.refresh();
        expect(tree.has('xo-wiki/wiki/a.md')).toBe(true);

        await writeFile(join(root, 'xo-wiki/wiki/a.md'), 'STAGED-TRACKED-CONTENT\n', 'utf8');
        await git(root, ['add', '--', 'xo-wiki/wiki/a.md']);
        await expect(tree.refresh()).rejects.toThrow('wiki_root_dirty');
        expect(tree.has('xo-wiki/wiki/a.md')).toBe(false);

        await writeFile(join(root, 'xo-wiki/wiki/a.md'), 'committed page\n', 'utf8');
        await git(root, ['add', '--', 'xo-wiki/wiki/a.md']);
        await tree.refresh();
        expect(tree.has('xo-wiki/wiki/a.md')).toBe(true);

        await writeFile(join(root, 'xo-wiki/wiki/secret.md'), 'UNTRACKED-SECRET-CONTENT\n', 'utf8');
        await expect(tree.refresh()).rejects.toThrow('wiki_root_dirty');
        expect(tree.has('xo-wiki/wiki/a.md')).toBe(false);
        expect(tree.has('xo-wiki/wiki/secret.md')).toBe(false);
        await expect(wikiRead(root, tree, 'xo-wiki/wiki/secret.md')).rejects.toMatchObject({
          code: 'not_tracked',
        });
      } finally {
        tree.stop();
      }
    });
  });

  test('server startup fails closed on a dirty wiki clone', async () => {
    const harness = await createHarness();
    try {
      await writeFile(
        join(harness.wikiRoot, 'xo-wiki/wiki/a.md'),
        'MODIFIED-TRACKED-CONTENT\n',
        'utf8'
      );
      await expect(startFromHarness(harness)).rejects.toThrow('wiki_root_dirty');
    } finally {
      await harness.cleanup();
    }
  });

  test('server startup fails closed when the wiki clone has an untracked file', async () => {
    const harness = await createHarness();
    try {
      await writeFile(
        join(harness.wikiRoot, 'xo-wiki/wiki/secret.md'),
        'UNTRACKED-SECRET-CONTENT\n',
        'utf8'
      );
      await expect(startFromHarness(harness)).rejects.toThrow('wiki_root_dirty');
    } finally {
      await harness.cleanup();
    }
  });
});
