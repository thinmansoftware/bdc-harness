import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'path';
import { promisify } from 'util';

import type { IsolationRequest } from '../types';
import { WorktreeProvider } from './worktree';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
}

function normalizedPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function assertOwnedPath(root: string, target: string): void {
  const child = relative(normalizedPath(root), normalizedPath(target));
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('Restart fixture cleanup target is outside its recorded root');
  }
}

function selectOwnedWorktrees(root: string, canonicalRepo: string, porcelain: string): string[] {
  const worktrees = porcelain
    .split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => resolve(line.slice('worktree '.length)))
    .filter(path => normalizedPath(path) !== normalizedPath(canonicalRepo));
  for (const worktree of worktrees) assertOwnedPath(root, worktree);
  return worktrees;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    assertOwnedPath(tmpdir(), root);
    if (!basename(root).startsWith('archon-worktree-restart-')) {
      throw new Error('Unexpected restart fixture root');
    }
    const canonicalRepo = join(root, 'canonical');
    // Only tolerate setup stopping before git init; real cleanup failures must propagate.
    if (existsSync(join(canonicalRepo, '.git'))) {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', canonicalRepo, 'worktree', 'list', '--porcelain'],
        { windowsHide: true }
      );
      const worktrees = selectOwnedWorktrees(root, canonicalRepo, stdout);
      for (const worktree of worktrees) {
        await execFileAsync(
          'git',
          ['-C', canonicalRepo, 'worktree', 'remove', '--force', worktree],
          {
            windowsHide: true,
          }
        );
      }
    }
    await rm(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
});

describe('WorktreeProvider restart persistence', () => {
  test('cleanup excludes primary separator variants and retains owned linked worktrees', () => {
    const root = join(tmpdir(), 'archon-worktree-restart-selection');
    const canonicalRepo = join(root, 'canonical');
    const linked = join(canonicalRepo, '.worktrees', 'linked');
    const primary = canonicalRepo.replaceAll('\\', '/');
    expect(
      selectOwnedWorktrees(root, canonicalRepo, `worktree ${primary}\nworktree ${linked}\n`)
    ).toEqual([resolve(linked)]);
    if (process.platform === 'win32') {
      expect(
        selectOwnedWorktrees(root, canonicalRepo, `worktree ${primary.toUpperCase()}\n`)
      ).toEqual([]);
    }
  });

  test('cleanup rejects sibling-prefix, root and outside targets before removal', () => {
    const root = join(tmpdir(), 'archon-worktree-restart-selection');
    const canonicalRepo = join(root, 'canonical');
    for (const target of [root, `${root}-sibling`, join(root, '..', 'outside')]) {
      expect(() => selectOwnedWorktrees(root, canonicalRepo, `worktree ${target}\n`)).toThrow(
        'outside its recorded root'
      );
    }
  });

  test('a new provider process adopts the same identity without losing uncommitted changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-worktree-restart-'));
    temporaryRoots.push(root);
    const origin = join(root, 'origin.git');
    const canonicalRepo = join(root, 'canonical');

    await mkdir(origin);
    await mkdir(canonicalRepo);
    await execFileAsync('git', ['init', '--bare', origin], { windowsHide: true });
    await git(canonicalRepo, 'init');
    await git(canonicalRepo, 'config', 'user.email', 'cauldron-test@example.invalid');
    await git(canonicalRepo, 'config', 'user.name', 'Cauldron Test');
    await mkdir(join(canonicalRepo, '.archon'));
    await writeFile(join(canonicalRepo, '.archon', 'fixture.txt'), 'fixture\n', 'utf8');
    await writeFile(join(canonicalRepo, 'tracked.txt'), 'committed\n', 'utf8');
    await git(canonicalRepo, 'add', '.archon/fixture.txt', 'tracked.txt');
    await git(canonicalRepo, 'commit', '-m', 'fixture');
    await git(canonicalRepo, 'branch', '-M', 'main');
    await git(canonicalRepo, 'remote', 'add', 'origin', origin);
    await git(canonicalRepo, 'push', '-u', 'origin', 'main');

    const loadConfig = async () => ({
      baseBranch: 'main',
      path: '.worktrees',
      copyFiles: [],
      initSubmodules: false,
    });
    const request: IsolationRequest = {
      codebaseId: 'restart-fixture-codebase',
      canonicalRepoPath: canonicalRepo as IsolationRequest['canonicalRepoPath'],
      workflowType: 'task',
      identifier: 'restart-fixture',
    };

    const firstProcess = new WorktreeProvider(loadConfig);
    const created = await firstProcess.create(request);
    const uncommittedPath = join(created.workingPath, 'survives-restart.txt');
    await writeFile(uncommittedPath, 'uncommitted and preserved\n', 'utf8');

    const restartedProcess = new WorktreeProvider(loadConfig);
    const adopted = await restartedProcess.create(request);

    expect(adopted.id).toBe(created.id);
    expect(adopted.workingPath).toBe(created.workingPath);
    expect(adopted.metadata.adopted).toBe(true);
    expect(await readFile(uncommittedPath, 'utf8')).toBe('uncommitted and preserved\n');
  });
});
