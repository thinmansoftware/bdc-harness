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

interface RestartCleanupOperations {
  list(canonicalRepo: string): Promise<string>;
  remove(canonicalRepo: string, worktree: string): Promise<void>;
  removeRoot(root: string): Promise<void>;
  observe(record: Record<string, unknown>): void;
}

const restartCleanupOperations: RestartCleanupOperations = {
  async list(canonicalRepo) {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', canonicalRepo, 'worktree', 'list', '--porcelain'],
      { windowsHide: true }
    );
    return stdout;
  },
  async remove(canonicalRepo, worktree) {
    await execFileAsync('git', ['-C', canonicalRepo, 'worktree', 'remove', '--force', worktree], {
      windowsHide: true,
    });
  },
  async removeRoot(root) {
    await rm(root, { recursive: true, force: true });
  },
  observe(record) {
    process.stderr.write('WORKROOM_RESTART_CLEANUP_FAILURE ' + JSON.stringify(record) + '\n');
  },
};

function observeRestartCleanupFailure(
  root: string,
  canonicalRepo: string,
  attemptedTarget: string,
  phase: string,
  error: unknown,
  emit: RestartCleanupOperations['observe']
): void {
  try {
    const bounded = (value: string) => value.slice(0, 1024);
    const metadata: Record<string, string> = {};
    if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
      for (const key of ['code', 'path', 'syscall']) {
        const descriptor = Object.getOwnPropertyDescriptor(error, key);
        if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') {
          metadata[key] = bounded(descriptor.value);
        }
      }
    }
    const nativeObservation = (path: string) => {
      try {
        if (typeof realpathSync.native !== 'function') return { status: 'native-unavailable' };
        return { status: 'resolved', value: bounded(realpathSync.native(path)) };
      } catch {
        return { status: 'lookup-unavailable' };
      }
    };
    const record = {
      phase,
      testProcessPid: process.pid,
      recordedRoot: bounded(root),
      canonicalRepo: bounded(canonicalRepo),
      attemptedTarget: bounded(attemptedTarget),
      error: metadata,
      native: {
        root: nativeObservation(root),
        canonical: nativeObservation(canonicalRepo),
        target: nativeObservation(attemptedTarget),
      },
      testOwnedChildCompletion:
        phase === 'root-remove' ? 'git-operations-awaited-or-not-created' : 'UNKNOWN',
      lockOwner: 'UNKNOWN',
      nestedPathAttribution: metadata.path ? 'original-error-only' : 'UNKNOWN',
    };
    if (JSON.stringify(record).length <= 8192) emit(record);
  } catch {
    // Diagnostics never replace the original failure or grant cleanup permission.
  }
}

async function cleanupRestartRoot(
  root: string,
  operations: RestartCleanupOperations = restartCleanupOperations
): Promise<void> {
  const canonicalRepo = join(root, 'canonical');
  let phase = 'ownership';
  let attemptedTarget = root;
  try {
    assertOwnedPath(tmpdir(), root);
    if (!basename(root).startsWith('archon-worktree-restart-')) {
      throw new Error('Unexpected restart fixture root');
    }
    // Only tolerate setup stopping before git init; real cleanup failures must propagate.
    if (existsSync(join(canonicalRepo, '.git'))) {
      phase = 'git-list';
      attemptedTarget = canonicalRepo;
      const stdout = await operations.list(canonicalRepo);
      phase = 'git-selection';
      const worktrees = selectOwnedWorktrees(root, canonicalRepo, stdout);
      for (const worktree of worktrees) {
        phase = 'git-remove';
        attemptedTarget = worktree;
        await operations.remove(canonicalRepo, worktree);
      }
    }
    phase = 'root-remove';
    attemptedTarget = root;
    await operations.removeRoot(root);
    phase = 'root-absence';
    expect(existsSync(root)).toBe(false);
  } catch (error) {
    observeRestartCleanupFailure(
      root,
      canonicalRepo,
      attemptedTarget,
      phase,
      error,
      operations.observe
    );
    throw error;
  }
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await cleanupRestartRoot(root);
  }
});

describe('WorktreeProvider restart persistence', () => {
  async function cleanupFailureFixture() {
    const root = await mkdtemp(join(tmpdir(), 'archon-worktree-restart-'));
    temporaryRoots.push(root);
    const sentinel = join(root, 'retained.txt');
    await writeFile(sentinel, 'retained\n');
    return { root, sentinel };
  }

  test('cleanup reports Git list and removal failures without attempting root removal', async () => {
    for (const phase of ['git-list', 'git-remove']) {
      const { root, sentinel } = await cleanupFailureFixture();
      const canonicalRepo = join(root, 'canonical');
      const linked = join(root, 'linked');
      await mkdir(canonicalRepo);
      await mkdir(linked);
      await git(canonicalRepo, 'init');
      const failure = Object.assign(new Error('synthetic Git failure'), { code: 'SYNTHETIC' });
      const observations: Record<string, unknown>[] = [];
      let rootAttempts = 0;
      let removeAttempts = 0;
      let caught: unknown;
      try {
        await cleanupRestartRoot(root, {
          async list() {
            if (phase === 'git-list') throw failure;
            return `worktree ${canonicalRepo}\nworktree ${linked}\n`;
          },
          async remove() {
            removeAttempts++;
            throw failure;
          },
          async removeRoot() {
            rootAttempts++;
          },
          observe(record) {
            observations.push(record);
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(rootAttempts).toBe(0);
      expect(removeAttempts).toBe(phase === 'git-list' ? 0 : 1);
      expect(await readFile(sentinel, 'utf8')).toBe('retained\n');
      expect(observations).toHaveLength(1);
      expect(observations[0]?.phase).toBe(phase);
      expect(observations[0]?.attemptedTarget).toBe(phase === 'git-list' ? canonicalRepo : linked);
      expect(observations[0]?.lockOwner).toBe('UNKNOWN');
    }
  });

  test('cleanup reports one root failure and retains its exact error and supplied nested path', async () => {
    const { root, sentinel } = await cleanupFailureFixture();
    const suppliedPath = join(root, 'synthetic-nested', 'locked.txt');
    const failure = Object.assign(new Error('synthetic root failure'), {
      code: 'EBUSY',
      path: suppliedPath,
      syscall: 'rmdir',
    });
    const observations: Record<string, unknown>[] = [];
    const attempts: string[] = [];
    let caught: unknown;
    try {
      await cleanupRestartRoot(root, {
        ...restartCleanupOperations,
        async removeRoot(target) {
          attempts.push(target);
          throw failure;
        },
        observe(record) {
          observations.push(record);
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(attempts).toEqual([root]);
    expect(await readFile(sentinel, 'utf8')).toBe('retained\n');
    expect(existsSync(suppliedPath)).toBe(false);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.phase).toBe('root-remove');
    expect(observations[0]?.error).toEqual({ code: 'EBUSY', path: suppliedPath, syscall: 'rmdir' });
    expect(observations[0]?.lockOwner).toBe('UNKNOWN');
    expect(observations[0]?.nestedPathAttribution).toBe('original-error-only');
  });

  test('cleanup preserves the original error when metadata getters and observation fail', async () => {
    const { root, sentinel } = await cleanupFailureFixture();
    const failure = new Error('original synthetic failure');
    let getterCalls = 0;
    Object.defineProperty(failure, 'code', {
      get() {
        getterCalls++;
        throw new Error('getter');
      },
    });
    let attempts = 0;
    let observationAttempts = 0;
    let caught: unknown;
    try {
      await cleanupRestartRoot(root, {
        ...restartCleanupOperations,
        async removeRoot() {
          attempts++;
          throw failure;
        },
        observe() {
          observationAttempts++;
          throw new Error('observation');
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(attempts).toBe(1);
    expect(getterCalls).toBe(0);
    expect(observationAttempts).toBe(1);
    expect(await readFile(sentinel, 'utf8')).toBe('retained\n');
  });

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
