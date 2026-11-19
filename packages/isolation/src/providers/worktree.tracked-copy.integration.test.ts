import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';

import type { IsolationRequest } from '../types';
import { WorktreeProvider } from './worktree';

/**
 * WO-HARNESS-WORKTREE-SYNC-NO-TRACKED-OVERWRITE-01 (Test 5): creating a worktree copies `.archon`
 * from the canonical repo, which may be on another branch with older tracked content. A tracked
 * path must keep the worktree's own content, so the new worktree is clean and the lane
 * checkpoint step (`git add -A`) has nothing to commit.
 */
const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
  return stdout;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    const canonicalRepo = join(root, 'canonical');
    try {
      const stdout = await git(canonicalRepo, 'worktree', 'list', '--porcelain');
      const worktrees = stdout
        .split(/\r?\n/)
        .filter(line => line.startsWith('worktree '))
        .map(line => line.slice('worktree '.length))
        .filter(path => resolve(path) !== resolve(canonicalRepo));
      for (const worktree of worktrees) {
        await git(canonicalRepo, 'worktree', 'remove', '--force', worktree);
      }
    } catch {
      // Setup may have failed before the repository or worktree existed.
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 5 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')) throw error;
        await Bun.sleep(100 * (attempt + 1));
      }
    }
  }
});

describe('WorktreeProvider copy of .archon keeps tracked paths', () => {
  test('a tracked .archon file keeps the base branch content and the checkpoint stages nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-worktree-tracked-'));
    temporaryRoots.push(root);
    const origin = join(root, 'origin.git');
    const canonicalRepo = join(root, 'canonical');
    const OLD = 'text: old master wording\n';
    const NEW = 'text: new staging wording\n';

    await mkdir(origin);
    await mkdir(canonicalRepo);
    await execFileAsync('git', ['init', '--bare', origin], { windowsHide: true });
    await git(canonicalRepo, 'init');
    await git(canonicalRepo, 'config', 'user.email', 'cauldron-test@example.invalid');
    await git(canonicalRepo, 'config', 'user.name', 'Cauldron Test');
    await git(canonicalRepo, 'config', 'core.autocrlf', 'false');
    await mkdir(join(canonicalRepo, '.archon', 'workflows'), { recursive: true });
    await writeFile(join(canonicalRepo, '.archon', 'workflows', 'a.yaml'), OLD, 'utf8');
    await git(canonicalRepo, 'add', '.archon/workflows/a.yaml');
    await git(canonicalRepo, 'commit', '-m', 'master: old text');
    await git(canonicalRepo, 'branch', '-M', 'master');
    await git(canonicalRepo, 'remote', 'add', 'origin', origin);
    await git(canonicalRepo, 'push', '-u', 'origin', 'master');
    // staging carries the new text; the canonical checkout stays on master with the old text.
    await git(canonicalRepo, 'checkout', '-b', 'staging');
    await writeFile(join(canonicalRepo, '.archon', 'workflows', 'a.yaml'), NEW, 'utf8');
    await git(canonicalRepo, 'commit', '-am', 'staging: new text');
    await git(canonicalRepo, 'push', '-u', 'origin', 'staging');
    await git(canonicalRepo, 'checkout', 'master');

    const loadConfig = async () => ({
      baseBranch: 'staging',
      path: '.worktrees',
      copyFiles: [],
      initSubmodules: false,
    });
    const request: IsolationRequest = {
      codebaseId: 'tracked-copy-fixture-codebase',
      canonicalRepoPath: canonicalRepo as IsolationRequest['canonicalRepoPath'],
      workflowType: 'task',
      identifier: 'tracked-copy-fixture',
    };

    const created = await new WorktreeProvider(loadConfig).create(request);

    expect(
      await readFile(join(created.workingPath, '.archon', 'workflows', 'a.yaml'), 'utf8')
    ).toBe(NEW);
    expect((await git(created.workingPath, 'status', '--porcelain')).trim()).toBe('');
    // the lane's checkpoint step stages everything: nothing may be staged
    await git(created.workingPath, 'add', '-A');
    expect((await git(created.workingPath, 'diff', '--cached', '--name-only')).trim()).toBe('');
  });
});
