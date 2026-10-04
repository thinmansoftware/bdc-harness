import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises';
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

function assertOwnedPath(root: string, target: string, canonicalRepo?: string): void {
  const child = relative(normalizedPath(root), normalizedPath(target));
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    if (process.env.CI === 'true') {
      try {
        const strings = [root, target, child, ...(canonicalRepo ? [canonicalRepo] : [])];
        if (strings.every(value => value.length <= 2048)) {
          const record = {
            phase: 'ownership-rejection',
            pid: process.pid,
            root,
            target,
            relativeChild: child,
            rejectEmpty: !child,
            rejectParent: child === '..',
            rejectPrefix: child.startsWith(`..${sep}`),
            rejectAbsolute: isAbsolute(child),
            rootExists: existsSync(root),
            ...(canonicalRepo
              ? {
                  canonicalRepo,
                  primaryEqual: normalizedPath(target) === normalizedPath(canonicalRepo),
                }
              : {}),
          };
          const marker = 'WORKROOM_RESTART_OWNERSHIP_REJECTION ' + JSON.stringify(record);
          if (marker.length <= 8192) process.stderr.write(marker + '\n');
        }
      } catch {
        /* Observation must never replace the original cleanup rejection. */
      }
      try {
        const strings = [root, target, ...(canonicalRepo ? [canonicalRepo] : [])];
        if (strings.every(value => value.length <= 2048)) {
          const nativeAvailable = typeof realpathSync.native === 'function';
          const observe = (path: string) => {
            if (!nativeAvailable) return { status: 'native-unavailable' };
            try {
              const value = realpathSync.native(path);
              if (typeof value !== 'string' || value.length > 2048) {
                return { status: 'value-omitted' };
              }
              return { status: 'resolved', value };
            } catch {
              return { status: 'lookup-unavailable' };
            }
          };
          const rootResolution = observe(root);
          const targetResolution = observe(target);
          const canonicalResolution = canonicalRepo ? observe(canonicalRepo) : undefined;
          const realRelativeChild =
            rootResolution.value !== undefined && targetResolution.value !== undefined
              ? relative(
                  normalizedPath(rootResolution.value),
                  normalizedPath(targetResolution.value)
                )
              : undefined;
          const record = {
            phase: 'filesystem-observation',
            pid: process.pid,
            root,
            target,
            ...(canonicalRepo ? { canonicalRepo } : {}),
            nativeAvailable,
            rootResolution,
            targetResolution,
            ...(canonicalResolution ? { canonicalResolution } : {}),
            ...(realRelativeChild !== undefined && realRelativeChild.length <= 2048
              ? { realRelativeChild }
              : {}),
            ...(canonicalResolution?.value !== undefined && targetResolution.value !== undefined
              ? {
                  realPrimaryEqual:
                    normalizedPath(targetResolution.value) ===
                    normalizedPath(canonicalResolution.value),
                }
              : {}),
          };
          const marker = 'WORKROOM_RESTART_FILESYSTEM_OBSERVATION ' + JSON.stringify(record);
          if (marker.length <= 8192) process.stderr.write(marker + '\n');
        }
      } catch {
        /* Filesystem resolution is observation only, never cleanup permission. */
      }
    }
    throw new Error('Restart fixture cleanup target is outside its recorded root');
  }
}

function selectOwnedWorktrees(root: string, canonicalRepo: string, porcelain: string): string[] {
  if (typeof realpathSync.native !== 'function') {
    throw new Error('Restart fixture cleanup requires native filesystem resolution');
  }
  const resolvedRoot = realpathSync.native(root);
  const resolvedCanonical = realpathSync.native(canonicalRepo);
  assertOwnedPath(resolvedRoot, resolvedCanonical);
  const worktrees = porcelain
    .split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => resolve(line.slice('worktree '.length)));
  const selected: string[] = [];
  for (const worktree of worktrees) {
    const resolvedWorktree = realpathSync.native(worktree);
    if (normalizedPath(resolvedWorktree) === normalizedPath(resolvedCanonical)) continue;
    assertOwnedPath(resolvedRoot, resolvedWorktree, resolvedCanonical);
    selected.push(worktree);
  }
  return selected;
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
  async function selectionFixture() {
    const outer = await mkdtemp(join(tmpdir(), 'archon-worktree-restart-'));
    temporaryRoots.push(outer);
    const root = join(outer, 'selection');
    const canonicalRepo = join(root, 'canonical');
    await mkdir(canonicalRepo, { recursive: true });
    return { outer, root, canonicalRepo };
  }

  test('cleanup excludes primary separator variants and retains owned linked worktrees', async () => {
    const { root, canonicalRepo } = await selectionFixture();
    const linked = join(canonicalRepo, '.worktrees', 'linked');
    await mkdir(linked, { recursive: true });
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

  test('cleanup rejects sibling-prefix, root and outside targets before removal', async () => {
    const { outer, root, canonicalRepo } = await selectionFixture();
    const sibling = `${root}-sibling`;
    const outside = join(outer, 'outside');
    await mkdir(sibling);
    await mkdir(outside);
    for (const target of [root, sibling, outside]) {
      expect(() => selectOwnedWorktrees(root, canonicalRepo, `worktree ${target}\n`)).toThrow(
        'outside its recorded root'
      );
      expect(existsSync(target)).toBe(true);
    }
  });

  test('cleanup excludes a native primary alias and retains an owned linked alias', async () => {
    const { root, canonicalRepo } = await selectionFixture();
    const linked = join(canonicalRepo, '.worktrees', 'linked');
    await mkdir(linked, { recursive: true });
    const alias = join(root, 'primary-alias');
    await symlink(canonicalRepo, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedAlias = join(alias, '.worktrees', 'linked');
    expect(
      selectOwnedWorktrees(root, canonicalRepo, `worktree ${alias}\nworktree ${linkedAlias}\n`)
    ).toEqual([resolve(linkedAlias)]);
    expect(existsSync(canonicalRepo)).toBe(true);
    expect(existsSync(linked)).toBe(true);
  });

  test('cleanup rejects resolved target and canonical escapes without removal', async () => {
    const { outer, root, canonicalRepo } = await selectionFixture();
    const outside = join(outer, 'outside');
    await mkdir(outside);
    const alias = join(root, 'outside-alias');
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => selectOwnedWorktrees(root, canonicalRepo, `worktree ${alias}\n`)).toThrow(
      'outside its recorded root'
    );
    expect(() => selectOwnedWorktrees(root, alias, `worktree ${alias}\n`)).toThrow(
      'outside its recorded root'
    );
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(canonicalRepo)).toBe(true);
  });

  test('cleanup aborts selection when a later target cannot resolve', async () => {
    const { root, canonicalRepo } = await selectionFixture();
    const linked = join(canonicalRepo, '.worktrees', 'linked');
    await mkdir(linked, { recursive: true });
    const sentinel = join(linked, 'retained.txt');
    await writeFile(sentinel, 'still owned\n', 'utf8');
    const missing = join(root, 'missing');
    expect(() =>
      selectOwnedWorktrees(root, canonicalRepo, `worktree ${linked}\nworktree ${missing}\n`)
    ).toThrow();
    expect(await readFile(sentinel, 'utf8')).toBe('still owned\n');
    expect(existsSync(canonicalRepo)).toBe(true);
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
