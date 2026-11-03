/**
 * Host cleanup deletion guards (cauldron-worktree-prune.sh, cauldron-disk-cleanup.sh).
 *
 * Lifts the real is_abandoned() out of each script (no re-typed copy) and runs it
 * with bash against a real git worktree whose files are all back-dated past the
 * retention window. `docker exec -u appuser <container> git ...` is replaced by a
 * shell function that runs the same git command locally, with the container
 * workspace root mapped onto the temp workspace root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = [
  { file: 'cauldron-worktree-prune.sh', rootVar: 'WTROOT', daysVar: 'RETENTION_DAYS' },
  { file: 'cauldron-disk-cleanup.sh', rootVar: 'WORKSPACES_ROOT', daysVar: 'STAGING_MAX_AGE_DAYS' },
];

function extractGuard(file: string): string {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  const start = source.indexOf('is_abandoned() {');
  const end = source.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`is_abandoned not found in ${file}`);
  return source.slice(start, end + 2);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

let root: string;
let wt: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleanup-guards-'));
  const src = join(root, 'owner', 'repo', 'source');
  mkdirSync(src, { recursive: true });
  git(src, 'init', '-q', '-b', 'main');
  git(src, 'config', 'user.email', 'test@example.com');
  git(src, 'config', 'user.name', 'test');
  writeFileSync(join(src, 'README.md'), 'x\n');
  git(src, 'add', 'README.md');
  git(src, 'commit', '-q', '-m', 'init');
  wt = join(root, 'owner', 'repo', 'worktrees', 'archon', 'thread-00000001');
  git(src, 'worktree', 'add', '-q', wt);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runGuard(
  file: string,
  rootVar: string,
  daysVar: string
): { status: number; reason: string } {
  const script = [
    `${rootVar}="$1"`,
    `${daysVar}=3`,
    'CONTAINER=test',
    'CWT_ROOT="$1"',
    // docker exec -u appuser <container> git ... -> git ...
    'docker() { shift 4; "$@"; }',
    extractGuard(file),
    // Back-date every file, including git metadata, past the retention window.
    'find "$1" -exec touch -h -d "10 days ago" {} +',
    'is_abandoned "$2"',
  ].join('\n');
  // Forward slashes so the guard's "${wt#"$root"/}" suffix strip also works on Windows.
  const posix = (p: string): string => p.replace(/\\/g, '/');
  const result = spawnSync('bash', ['-c', script, 'guard', posix(root), posix(wt)], {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return { status: result.status ?? -1, reason: result.stdout.trim() };
}

for (const { file, rootVar, daysVar } of SCRIPTS) {
  describe(`${file} is_abandoned`, () => {
    it('removes a clean, old, idle worktree', () => {
      expect(runGuard(file, rootVar, daysVar)).toEqual({ status: 0, reason: '' });
    });

    it('keeps untracked work when status.showUntrackedFiles=no', () => {
      git(wt, 'config', 'status.showUntrackedFiles', 'no');
      writeFileSync(join(wt, 'untracked-work.ts'), 'export const x = 1;\n');
      // Plain `git status --porcelain` hides the file under this setting.
      expect(git(wt, 'status', '--porcelain')).toBe('');
      expect(runGuard(file, rootVar, daysVar)).toEqual({
        status: 1,
        reason: 'uncommitted-changes',
      });
    });

    it('keeps a worktree with a tracked edit', () => {
      writeFileSync(join(wt, 'README.md'), 'edited\n');
      expect(runGuard(file, rootVar, daysVar)).toEqual({
        status: 1,
        reason: 'uncommitted-changes',
      });
    });
  });
}
