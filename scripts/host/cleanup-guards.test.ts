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

/**
 * prune_rollback_pins (cauldron-disk-cleanup.sh): the real function is lifted out
 * of the script and run with `docker` replaced by a shell function that serves
 * canned `images` / `ps` / `inspect` output and records every `rmi` call.
 */
function extractFunction(file: string, name: string): string {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`${name} not found in ${file}`);
  return source.slice(start, end + 2);
}

type Pin = { tag: string; created: string; id: string };

function runPrune(
  pins: Pin[],
  containerImageIds: string[],
  env: Record<string, string> = {},
  record?: string
): { status: number; out: string; rmi: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'rollback-pins-'));
  try {
    if (record !== undefined) {
      writeFileSync(join(dir, 'LAST_ROLLBACK_PIN'), record);
      env = { ...env, ROLLBACK_RECORD_FILE: join(dir, 'LAST_ROLLBACK_PIN').replace(/\\/g, '/') };
    }
    // Unrelated tags must never be touched.
    const images = [
      ...pins.map((p) => `${p.created}|${p.tag}|${p.id}`),
      '2026-11-03 09:00:00 +0000 UTC|archon:latest|sha256:latest',
      '2026-10-01 09:00:00 +0000 UTC|archon-rollback:m12|sha256:oldm12',
    ];
    writeFileSync(join(dir, 'images.txt'), images.join('\n') + '\n');
    writeFileSync(
      join(dir, 'ps.txt'),
      containerImageIds.map((_, i) => `c${i}`).join('\n') + (containerImageIds.length ? '\n' : '')
    );
    writeFileSync(
      join(dir, 'inspect.txt'),
      containerImageIds.join('\n') + (containerImageIds.length ? '\n' : '')
    );
    writeFileSync(join(dir, 'rmi.txt'), '');
    const script = [
      'D="$1"',
      'LOG="$D/log.txt"',
      'DRY_RUN="${DRY_RUN:-0}"',
      'KEEP_ROLLBACK_PINS="${KEEP_ROLLBACK_PINS:-3}"',
      'ROLLBACK_RECORD_FILE="${ROLLBACK_RECORD_FILE:-$D/no-such-record}"',
      'log() { echo "$*"; }',
      'docker() {',
      '  case "$1" in',
      '    images) cat "$D/images.txt";;',
      '    ps) cat "$D/ps.txt";;',
      '    inspect) cat "$D/inspect.txt";;',
      '    rmi) shift; echo "$*" >> "$D/rmi.txt";;',
      '    *) echo "unexpected docker $*" >&2; return 1;;',
      '  esac',
      '}',
      extractFunction('cauldron-disk-cleanup.sh', 'prune_rollback_pins'),
      'prune_rollback_pins',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script, 'prune', dir.replace(/\\/g, '/')], {
      encoding: 'utf8',
      env: { ...process.env, MSYS_NO_PATHCONV: '1', ...env },
    });
    const rmi = readFileSync(join(dir, 'rmi.txt'), 'utf8').split('\n').filter(Boolean);
    return { status: result.status ?? -1, out: result.stdout + result.stderr, rmi };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Tag stamps deliberately disagree with creation order, so a sort by tag text fails.
const SIX: Pin[] = [
  { tag: 'archon:rollback-20261103-0100', created: '2026-10-28 10:00:00 +0000 UTC', id: 'sha256:aaa1' },
  { tag: 'archon:rollback-20261102-0100', created: '2026-11-03 10:00:00 +0000 UTC', id: 'sha256:aaa2' },
  { tag: 'archon:rollback-20261101-0100', created: '2026-10-30 10:00:00 +0000 UTC', id: 'sha256:aaa3' },
  { tag: 'archon:rollback-20261031-0100', created: '2026-11-02 10:00:00 +0000 UTC', id: 'sha256:aaa4' },
  { tag: 'archon:rollback-20261030-0100', created: '2026-10-25 10:00:00 +0000 UTC', id: 'sha256:aaa5' },
  { tag: 'archon:rollback-20261029-0100', created: '2026-11-01 10:00:00 +0000 UTC', id: 'sha256:aaa6' },
];
// By creation time, newest first: aaa2, aaa4, aaa6 (kept); aaa3, aaa1, aaa5 (old).
const OLDEST_THREE = [
  'archon:rollback-20261101-0100',
  'archon:rollback-20261103-0100',
  'archon:rollback-20261030-0100',
];

describe('cauldron-disk-cleanup.sh prune_rollback_pins', () => {
  it('keeps_newest_three_pins', () => {
    const r = runPrune(SIX, []);
    expect(r.status).toBe(0);
    expect(r.rmi).toEqual(OLDEST_THREE);
    expect(r.out).toContain('keep rollback pin: archon:rollback-20261102-0100 (newest)');
    for (const tag of OLDEST_THREE) expect(r.out).toContain(`removing rollback pin: ${tag}`);
  });

  it('in_use_pin_is_never_removed', () => {
    // The oldest pin by creation time (aaa5) is used by a stopped container.
    const r = runPrune(SIX, ['sha256:unrelated', 'sha256:aaa5']);
    expect(r.status).toBe(0);
    expect(r.rmi).toEqual(['archon:rollback-20261101-0100', 'archon:rollback-20261103-0100']);
    expect(r.out).toContain('skip rollback pin: archon:rollback-20261030-0100 (in-use)');
  });

  it('dry_run_removes_nothing', () => {
    const r = runPrune(SIX, [], { DRY_RUN: '1' });
    expect(r.status).toBe(0);
    expect(r.rmi).toEqual([]);
    const planned = r.out.split('\n').filter((l) => l.startsWith('DRY_RUN would remove rollback pin: '));
    expect(planned.map((l) => l.replace('DRY_RUN would remove rollback pin: ', ''))).toEqual(OLDEST_THREE);
  });

  it('fewer_than_keep_is_a_noop', () => {
    const r = runPrune(SIX.slice(0, 2), []);
    expect(r.status).toBe(0);
    expect(r.rmi).toEqual([]);
  });

  it('recorded_rollback_pin_is_preserved', () => {
    // The record names the OLDEST pin by creation time (aaa5); no container uses any pin.
    const r = runPrune(SIX, [], {}, 'archon:rollback-20261030-0100\n');
    expect(r.status).toBe(0);
    expect(r.out).toContain('skip rollback pin: archon:rollback-20261030-0100 (rollback-record)');
    expect(r.rmi).toEqual(['archon:rollback-20261101-0100', 'archon:rollback-20261103-0100']);
  });

  it('keeps_the_newest_pin_even_when_keep_is_zero', () => {
    const r = runPrune(SIX, [], { KEEP_ROLLBACK_PINS: '0' });
    expect(r.rmi).toHaveLength(5);
    expect(r.rmi).not.toContain('archon:rollback-20261102-0100');
  });
});
