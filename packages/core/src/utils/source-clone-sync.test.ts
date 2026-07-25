/**
 * Unit tests for syncSourceCloneBeforeResolve
 * (WO-HARNESS-DISPATCH-SYNC-BEFORE-RESOLVE-01).
 *
 * Uses REAL git repositories in temp directories -- no mock.module() -- so the
 * managed-clone reset behavior, fetch-only behavior for local repos, and the
 * fail-open fetch-failure path are all asserted against actual git state.
 *
 * ARCHON_HOME is set to a per-process temp dir by the global test preload
 * (packages/core/src/test/setup.ts), so getArchonWorkspacesPath() resolves to
 * an isolated workspaces root -- clones created under it are "managed clones".
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileAsync } from '@archon/git';
import { getArchonWorkspacesPath } from '@archon/paths';
import { syncSourceCloneBeforeResolve } from './source-clone-sync';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: 30000,
    env: GIT_ENV,
  });
  return stdout.trim();
}

let baseDir: string;
let originPath: string;
let scratchPath: string;

/** Commit a file in the scratch clone and push it to origin main */
async function pushCommit(filename: string, content: string): Promise<string> {
  writeFileSync(join(scratchPath, filename), content);
  await git(scratchPath, 'add', '-A');
  await git(scratchPath, 'commit', '-m', `add ${filename}`);
  await git(scratchPath, 'push', 'origin', 'main');
  return git(scratchPath, 'rev-parse', 'HEAD');
}

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'source-clone-sync-test-'));
  originPath = join(baseDir, 'origin.git');
  scratchPath = join(baseDir, 'scratch');

  mkdirSync(originPath, { recursive: true });
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', originPath], {
    timeout: 30000,
    env: GIT_ENV,
  });
  await execFileAsync('git', ['clone', originPath, scratchPath], {
    timeout: 30000,
    env: GIT_ENV,
  });
  await pushCommit('README.md', 'initial\n');
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

async function cloneTo(targetPath: string): Promise<void> {
  mkdirSync(join(targetPath, '..'), { recursive: true });
  await execFileAsync('git', ['clone', originPath, targetPath], {
    timeout: 30000,
    env: GIT_ENV,
  });
}

describe('syncSourceCloneBeforeResolve', () => {
  test('managed clone behind origin is hard-reset to origin tip and reports its full sha', async () => {
    const clonePath = join(getArchonWorkspacesPath(), 'test-owner', 'managed-sync', 'source');
    await cloneTo(clonePath);

    // Advance origin AFTER the managed clone was created -> clone is stale
    const originTip = await pushCommit('new-file.txt', 'from origin\n');
    const staleHead = await git(clonePath, 'rev-parse', 'HEAD');
    expect(staleHead).not.toBe(originTip);

    const outcome = await syncSourceCloneBeforeResolve({
      id: 'cb-managed',
      default_cwd: clonePath,
    });

    expect(outcome.syncError).toBeUndefined();
    expect(outcome.syncResult?.synced).toBe(true);
    // Full 40-char sha of the post-sync HEAD == origin tip
    expect(outcome.headSha).toBe(originTip);
    expect(outcome.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(clonePath, 'rev-parse', 'HEAD')).toBe(originTip);
  });

  test('locally-registered repo (outside workspaces) gets fetch-only: HEAD unchanged, no reset', async () => {
    const localPath = join(baseDir, 'local-repo');
    await cloneTo(localPath);
    const localHead = await git(localPath, 'rev-parse', 'HEAD');

    // Advance origin; the local repo must NOT be reset (uncommitted-work safety)
    const originTip = await pushCommit('local-mode.txt', 'origin ahead\n');
    expect(originTip).not.toBe(localHead);

    const outcome = await syncSourceCloneBeforeResolve({ id: 'cb-local', default_cwd: localPath });

    expect(outcome.syncError).toBeUndefined();
    expect(outcome.syncResult?.synced).toBe(true);
    // Fetch-only: definitions still resolve from the local HEAD, and that is
    // exactly the sha reported as evidence.
    expect(outcome.headSha).toBe(localHead);
    expect(await git(localPath, 'rev-parse', 'HEAD')).toBe(localHead);
  });

  test('fetch failure is fail-open: syncError set, current HEAD still reported, no throw', async () => {
    const clonePath = join(getArchonWorkspacesPath(), 'test-owner', 'broken-remote', 'source');
    await cloneTo(clonePath);
    const currentHead = await git(clonePath, 'rev-parse', 'HEAD');

    // Simulate an unreachable remote
    await git(clonePath, 'remote', 'set-url', 'origin', join(baseDir, 'does-not-exist.git'));

    const outcome = await syncSourceCloneBeforeResolve({
      id: 'cb-broken',
      default_cwd: clonePath,
    });

    expect(outcome.syncError).toBeDefined();
    expect(outcome.syncResult).toBeUndefined();
    expect(outcome.headSha).toBe(currentHead);
  });

  test('non-git path never throws: syncError set, headSha undefined', async () => {
    const notARepo = join(baseDir, 'not-a-repo');
    mkdirSync(notARepo, { recursive: true });

    const outcome = await syncSourceCloneBeforeResolve({ id: 'cb-none', default_cwd: notARepo });

    expect(outcome.syncError).toBeDefined();
    expect(outcome.headSha).toBeUndefined();
  });
});
