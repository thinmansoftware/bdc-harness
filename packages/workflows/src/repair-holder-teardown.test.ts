/**
 * WO-HARNESS-REPAIR-HOLDER-TEARDOWN-01: rtw core cases (holder wait, dirty
 * holder backup, no forced removal, scan hardening, lane identity).
 *
 * Reuses the extraction harness of repair-target-worktree-reclaim.test.ts: a
 * fake RTW_PROC_ROOT, a real temp git repo and a temp sqlite runs db.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
const CODEX_LANE = join(LANES_DIR, 'bdc-feature-development-codex.yaml');
const LANES = [
  'bdc-feature-development-astra.yaml',
  'bdc-feature-development-codex-only.yaml',
  'bdc-feature-development-codex.yaml',
  'bdc-feature-development-cursor.yaml',
  'bdc-feature-development-fable.yaml',
  'bdc-feature-development-fusion-cx-kimi.yaml',
  'bdc-feature-development-fusion-cx-qwen.yaml',
  'bdc-feature-development-grok.yaml',
  'bdc-feature-development-kimi-k3.yaml',
  'bdc-feature-development-zero-claude.yaml',
  'bdc-feature-development-zero-open.yaml',
  'bdc-feature-development-zero.yaml',
  'bdc-feature-development.yaml',
];

function extractRtwCore(yaml: string): string {
  const begin = '# ---- BEGIN rtw core';
  const end = '# ---- END rtw core ----';
  const marker = yaml.indexOf(begin);
  const finish = yaml.indexOf(end, marker);
  if (marker < 0 || finish < 0) throw new Error('rtw core markers missing');
  const lineStart = yaml.lastIndexOf('\n', marker) + 1;
  const endLine = yaml.indexOf('\n', finish);
  const block = yaml.slice(lineStart, endLine === -1 ? yaml.length : endLine);
  return (
    block
      .replace(/\r/g, '')
      .split('\n')
      .map(line => (line.startsWith('      ') ? line.slice(6) : line))
      .join('\n') + '\n'
  );
}

const RTW_CORE = extractRtwCore(readFileSync(CODEX_LANE, 'utf8'));

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...GIT_ENV },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function utcSecondsAgo(seconds: number): string {
  const d = new Date(Date.now() - seconds * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

interface Fixture {
  readonly root: string;
  readonly origin: string;
  readonly caller: string;
  readonly holder: string;
  readonly dbPath: string;
  readonly procRoot: string;
  readonly artifacts: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'rtw-repo-'));
  const origin = join(root, 'origin.git');
  const main = join(root, 'main');
  const holderDir = join(root, 'A');
  const caller = join(root, 'B');
  const procRoot = join(root, 'proc');
  const artifacts = join(root, 'artifacts');
  mkdirSync(procRoot);
  mkdirSync(artifacts);
  git(['init', '--bare', '--initial-branch=main', origin], root);
  git(['clone', origin, main], root);
  git(['config', 'user.email', 'test@test.com'], main);
  git(['config', 'user.name', 'Test'], main);
  writeFileSync(join(main, 'README.md'), 'init\n');
  writeFileSync(join(main, 'tracked.txt'), 'base\n');
  git(['add', 'README.md', 'tracked.txt'], main);
  git(['commit', '-m', 'init'], main);
  git(['push', 'origin', 'main'], main);
  git(['branch', 'feat/x'], main);
  git(['push', 'origin', 'feat/x'], main);
  git(['branch', 'caller'], main);
  git(['worktree', 'add', holderDir, 'feat/x'], main);
  git(['worktree', 'add', caller, 'caller'], main);
  const holder = git(['rev-parse', '--show-toplevel'], holderDir).trim();
  return {
    root,
    origin,
    caller,
    holder,
    dbPath: join(root, 'runs.db'),
    procRoot,
    artifacts,
  };
}

function writeRuns(
  dbPath: string,
  rows: ReadonlyArray<{
    id: string;
    status: string;
    working_path: string;
    completed_at: string | null;
    started_at: string | null;
  }>
): void {
  const db = new Database(dbPath);
  db.run(`CREATE TABLE remote_agent_workflow_runs (
    id TEXT PRIMARY KEY, status TEXT, working_path TEXT, completed_at TEXT, started_at TEXT)`);
  const insert = db.query(
    'INSERT INTO remote_agent_workflow_runs (id, status, working_path, completed_at, started_at) VALUES (?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(row.id, row.status, row.working_path, row.completed_at, row.started_at);
  }
  db.close();
}

const SELF_UID = Bun.spawnSync(['bash', '-c', 'id -u'], { stdout: 'pipe' })
  .stdout.toString()
  .trim();

function fakeProc(
  procRoot: string,
  pid: number,
  cwdTarget: string,
  opts: { startSecondsAgo?: number; uid?: string; comm?: string; noStatus?: boolean } = {}
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const bootSec = nowSec - 100000;
  writeFileSync(join(procRoot, 'stat'), `cpu 0 0 0 0\nbtime ${String(bootSec)}\n`);
  const pidDir = join(procRoot, String(pid));
  mkdirSync(pidDir, { recursive: true });
  symlinkSync(cwdTarget, join(pidDir, 'cwd'));
  const startSec = nowSec - (opts.startSecondsAgo ?? 60);
  const ticks = (startSec - bootSec) * 100;
  const zeros = Array.from({ length: 17 }, () => '0').join(' ');
  writeFileSync(
    join(pidDir, 'stat'),
    `${String(pid)} (${opts.comm ?? 'sleep'}) S 1 ${zeros} ${String(ticks)} 0 0\n`
  );
  if (!opts.noStatus) {
    writeFileSync(join(pidDir, 'status'), `Name:\tx\nUid:\t${opts.uid ?? SELF_UID}\t0\t0\t0\n`);
  }
  return pidDir;
}

function script(prelude = ''): string {
  return `set -euo pipefail\n${RTW_CORE}\n${prelude}\nrtw_checkout_repair_branch "$1"\n`;
}

function envFor(fixture: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...GIT_ENV,
    RTW_RUNS_DB: fixture.dbPath,
    RTW_PROC_ROOT: fixture.procRoot,
    RTW_HOLDER_WAIT_SECONDS: '0',
    RTW_CLK_TCK: '100',
    ARTIFACTS_DIR: '',
    ...extra,
  };
}

function writeScript(body: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rtw-sh-'));
  const path = join(dir, 'rtw.sh');
  writeFileSync(path, body);
  return { path, dir };
}

function runSync(fixture: Fixture, body: string, env: Record<string, string>): RunResult {
  git(['fetch', 'origin', 'refs/heads/feat/x'], fixture.caller);
  const { path, dir } = writeScript(body);
  try {
    const result = Bun.spawnSync(['bash', path, 'feat/x'], {
      cwd: fixture.caller,
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runAsync(
  fixture: Fixture,
  body: string,
  env: Record<string, string>
): Promise<RunResult> {
  git(['fetch', 'origin', 'refs/heads/feat/x'], fixture.caller);
  const { path, dir } = writeScript(body);
  try {
    const proc = Bun.spawn(['bash', path, 'feat/x'], {
      cwd: fixture.caller,
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function show(result: RunResult): string {
  return `exit=${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** sha256 of every regular file under dir (excluding .git dirs), keyed by relative path. */
function treeHashes(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, treeHashes(full, `${prefix}${name}/`));
    else out[`${prefix}${name}`] = sha(full);
  }
  return out;
}

function gitDirOf(worktree: string): string {
  return git(['rev-parse', '--absolute-git-dir'], worktree).trim();
}

const roots: string[] = [];
afterEach(() => {
  Bun.gc(true);
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) removeTempDirWithRetry(root);
  }
});

function terminalRow(fixture: Fixture, status: string, completedAgo: number, startedAgo = 600) {
  return {
    id: 'abcd1234ef567890',
    status,
    working_path: fixture.holder,
    completed_at: utcSecondsAgo(completedAgo),
    started_at: utcSecondsAgo(startedAgo),
  };
}

describe('repair holder teardown -- rtw core (WO-HARNESS-REPAIR-HOLDER-TEARDOWN-01)', () => {
  it('Test 1: terminal_holder_reclaimed_after_owned_process_exits', async () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    writeRuns(fixture.dbPath, [terminalRow(fixture, 'escalated', 30)]);
    const nested = join(fixture.holder, 'nested');
    mkdirSync(nested);
    // Same uid, started after the holder's started_at (10 min ago).
    const pidDir = fakeProc(fixture.procRoot, 4242, nested, { startSecondsAgo: 60 });
    let removedAt = 0;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      rmSync(pidDir, { recursive: true, force: true });
      removedAt = Date.now();
    }, 6000);
    const result = await runAsync(
      fixture,
      script(),
      envFor(fixture, { RTW_HOLDER_WAIT_SECONDS: '20' })
    );
    clearTimeout(timer);
    if (result.exitCode !== 0) throw new Error(show(result));
    expect(removedAt).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(6000);
    expect(result.stdout).toContain('repair_target_worktree_reclaimed:');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], fixture.caller).trim()).toBe('feat/x');
    expect(git(['worktree', 'list'], fixture.caller)).not.toContain(fixture.holder);
  }, 60000);

  it('Test 2: nonterminal_owner_never_evicted', () => {
    for (const rows of [
      (f: Fixture) => [{ ...terminalRow(f, 'running', 0), completed_at: null as string | null }],
      (f: Fixture) => [
        terminalRow(f, 'failed', 30),
        {
          id: 'second-row',
          status: 'running',
          working_path: f.holder,
          completed_at: null as string | null,
          started_at: utcSecondsAgo(20),
        },
      ],
    ]) {
      const fixture = makeFixture();
      roots.push(fixture.root);
      writeRuns(fixture.dbPath, rows(fixture));
      writeFileSync(join(fixture.holder, 'work.txt'), 'in progress\n');
      fakeProc(fixture.procRoot, 4242, fixture.holder, { startSecondsAgo: 5 });
      const before = treeHashes(fixture.holder);
      const t0 = Date.now();
      const result = runSync(fixture, script(), envFor(fixture, { RTW_HOLDER_WAIT_SECONDS: '20' }));
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(result.exitCode, show(result)).not.toBe(0);
      expect(result.stdout).toContain('status running is not terminal');
      expect(treeHashes(fixture.holder)).toEqual(before);
      expect(git(['worktree', 'list'], fixture.caller)).toContain(fixture.holder);
    }
  }, 60000);

  it('Test 3: dirty_holder_backed_up_never_removed', () => {
    // Fixture 1: staged-only change, modified tracked file, odd untracked names.
    const fixture = makeFixture();
    roots.push(fixture.root);
    writeRuns(fixture.dbPath, [terminalRow(fixture, 'failed', 30)]);
    const holder = fixture.holder;
    writeFileSync(join(holder, 'staged.txt'), 'staged only\n');
    git(['add', 'staged.txt'], holder);
    writeFileSync(join(holder, 'tracked.txt'), 'modified\n');
    writeFileSync(join(holder, 'notes.txt'), 'notes\n');
    writeFileSync(join(holder, ' notes.txt'), 'leading space\n');
    writeFileSync(join(holder, '--version'), 'dashdash\n');
    const tip = git(['rev-parse', 'HEAD'], holder).trim();
    const gitDir = gitDirOf(holder);
    const indexBefore = sha(join(gitDir, 'index'));
    const filesBefore = treeHashes(holder);
    const result = runSync(
      fixture,
      script(),
      envFor(fixture, { ARTIFACTS_DIR: fixture.artifacts })
    );
    if (result.exitCode !== 0) throw new Error(show(result));
    expect(result.stdout).toContain('repair_target_holder_released:');
    expect(sha(join(gitDir, 'index'))).toBe(indexBefore);
    expect(treeHashes(holder)).toEqual(filesBefore);
    expect(git(['rev-parse', 'HEAD'], holder).trim()).toBe(tip);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], holder).trim()).toBe('HEAD');
    expect(git(['worktree', 'list'], fixture.caller)).toContain(holder);
    const refs = git(['show-ref'], fixture.origin);
    const backup = refs
      .split('\n')
      .map(line => line.split(' ')[1] ?? '')
      .find(ref => ref.startsWith('refs/heads/backup/feat/x-dirty-'));
    expect(backup, refs).toBeTruthy();
    const listing = git(['ls-tree', '-r', '--name-only', backup as string], fixture.origin);
    expect(listing.split('\n')).toEqual(
      expect.arrayContaining(['notes.txt', ' notes.txt', '--version', 'staged.txt'])
    );
    const releasedDir = join(fixture.artifacts, 'reclaimed-holder', 'abcd1234');
    const released = JSON.parse(readFileSync(join(releasedDir, 'released.json'), 'utf8')) as {
      cleanup: string;
      backup_ref: string;
    };
    expect(released.cleanup).toBe('overnight');
    expect(released.backup_ref).toBe(backup as string);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], fixture.caller).trim()).toBe('feat/x');

    // Fixture 2: unresolved merge conflict (MERGE_HEAD, three index stages).
    const conflict = makeFixture();
    roots.push(conflict.root);
    writeRuns(conflict.dbPath, [terminalRow(conflict, 'failed', 30)]);
    const ch = conflict.holder;
    git(['checkout', '-b', 'side'], ch);
    writeFileSync(join(ch, 'tracked.txt'), 'side\n');
    git(['commit', '-am', 'side'], ch);
    git(['checkout', 'feat/x'], ch);
    writeFileSync(join(ch, 'tracked.txt'), 'ours\n');
    git(['commit', '-am', 'ours'], ch);
    git(['push', 'origin', 'feat/x'], ch);
    Bun.spawnSync(['git', 'merge', 'side'], { cwd: ch, env: { ...process.env, ...GIT_ENV } });
    const cGitDir = gitDirOf(ch);
    expect(existsSync(join(cGitDir, 'MERGE_HEAD'))).toBe(true);
    const cIndex = sha(join(cGitDir, 'index'));
    const cFiles = treeHashes(ch);
    const cResult = runSync(
      conflict,
      script(),
      envFor(conflict, { ARTIFACTS_DIR: conflict.artifacts })
    );
    if (cResult.exitCode !== 0) throw new Error(show(cResult));
    expect(existsSync(join(cGitDir, 'MERGE_HEAD'))).toBe(true);
    expect(sha(join(cGitDir, 'index'))).toBe(cIndex);
    expect(treeHashes(ch)).toEqual(cFiles);
    expect(git(['worktree', 'list'], conflict.caller)).toContain(ch);

    // Refusals: ARTIFACTS_DIR unset, and the remote rejecting the push.
    const unset = makeFixture();
    roots.push(unset.root);
    writeRuns(unset.dbPath, [terminalRow(unset, 'failed', 30)]);
    writeFileSync(join(unset.holder, 'notes.txt'), 'notes\n');
    const unsetResult = runSync(unset, script(), envFor(unset));
    expect(unsetResult.exitCode, show(unsetResult)).not.toBe(0);
    expect(unsetResult.stdout).toContain('worktree is dirty');
    expect(git(['symbolic-ref', 'HEAD'], unset.holder).trim()).toBe('refs/heads/feat/x');

    const rejected = makeFixture();
    roots.push(rejected.root);
    writeRuns(rejected.dbPath, [terminalRow(rejected, 'failed', 30)]);
    writeFileSync(join(rejected.holder, 'notes.txt'), 'notes\n');
    const hook = join(rejected.origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const rejResult = runSync(
      rejected,
      script(),
      envFor(rejected, { ARTIFACTS_DIR: rejected.artifacts })
    );
    expect(rejResult.exitCode, show(rejResult)).not.toBe(0);
    expect(rejResult.stdout).toContain('worktree is dirty');
    expect(git(['symbolic-ref', 'HEAD'], rejected.holder).trim()).toBe('refs/heads/feat/x');
  }, 120000);

  it('Test 4: clean_holder_remove_is_never_forced', () => {
    expect(RTW_CORE).not.toContain('remove --force');
    expect(RTW_CORE).not.toMatch(/remove -f\b/);
    const fixture = makeFixture();
    roots.push(fixture.root);
    writeRuns(fixture.dbPath, [terminalRow(fixture, 'failed', 30)]);
    // Test hook: wrap git so late.txt lands after the status check, before removal.
    const prelude = [
      'git() {',
      '  if [ "${1:-}" = "worktree" ] && [ "${2:-}" = "remove" ]; then',
      '    printf "late content\\n" > "$3/late.txt"',
      '  fi',
      '  command git "$@"',
      '}',
    ].join('\n');
    const result = runSync(fixture, script(prelude), envFor(fixture));
    expect(result.exitCode, show(result)).not.toBe(0);
    expect(result.stdout).toContain('worktree remove failed');
    expect(readFileSync(join(fixture.holder, 'late.txt'), 'utf8')).toBe('late content\n');
    expect(git(['worktree', 'list'], fixture.caller)).toContain(fixture.holder);
  }, 60000);

  it('Test 9 (rtw core): an unreadable same-uid cwd refuses with process scan incomplete', () => {
    const fixture = makeFixture();
    roots.push(fixture.root);
    writeRuns(fixture.dbPath, [terminalRow(fixture, 'failed', 30)]);
    // cwd link that cannot be resolved (missing parent components), same uid.
    fakeProc(fixture.procRoot, 4545, join(fixture.root, 'no', 'such', 'dir', 'x'));
    const result = runSync(fixture, script(), envFor(fixture));
    expect(result.exitCode, show(result)).not.toBe(0);
    expect(result.stdout).toContain('process scan incomplete');
    expect(git(['worktree', 'list'], fixture.caller)).toContain(fixture.holder);
  }, 60000);

  it('Test 2b: reclaim_blocked_by_predates_run_and_foreign_uid_holders', () => {
    const otherUid = SELF_UID === '0' ? '1001' : '0';
    const cases: { reason: string; pid: number; opts: Parameters<typeof fakeProc>[3] }[] = [
      // Started 2 hours ago, before the holder run's started_at (10 min ago).
      { reason: 'predates_run', pid: 4646, opts: { startSecondsAgo: 7200, comm: 'tail' } },
      // Same age as a holder-owned process, different uid.
      {
        reason: 'foreign_uid',
        pid: 4747,
        opts: { startSecondsAgo: 60, uid: otherUid, comm: 'cat' },
      },
    ];
    for (const c of cases) {
      const fixture = makeFixture();
      roots.push(fixture.root);
      writeRuns(fixture.dbPath, [terminalRow(fixture, 'escalated', 30, 600)]);
      fakeProc(fixture.procRoot, c.pid, fixture.holder, c.opts);
      const before = treeHashes(fixture.holder);
      const t0 = Date.now();
      const result = runSync(fixture, script(), envFor(fixture, { RTW_HOLDER_WAIT_SECONDS: '20' }));
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(result.exitCode, show(result)).not.toBe(0);
      expect(result.stdout).toContain(`reason ${c.reason}`);
      expect(result.stdout).toContain(`pid ${String(c.pid)} comm ${c.opts?.comm ?? ''}`);
      expect(result.stdout).not.toContain('repair_target_worktree_reclaimed');
      expect(treeHashes(fixture.holder)).toEqual(before);
      expect(git(['worktree', 'list'], fixture.caller)).toContain(fixture.holder);
    }
  }, 60000);

  it('Test 18: rtw_core_identical_in_all_lanes', () => {
    expect(
      readdirSync(LANES_DIR)
        .filter(f => f.startsWith('bdc-feature-development') && f.endsWith('.yaml'))
        .sort()
    ).toEqual(LANES);
    const blocks = LANES.map(file => extractRtwCore(readFileSync(join(LANES_DIR, file), 'utf8')));
    for (const block of blocks) {
      expect(block).toBe(blocks[0] as string);
      expect(block).toContain('rtw_wait_for_holder_exit');
      expect(block).toContain('rtw_backup_dirty_holder');
      expect(block).not.toContain('remove --force');
      expect(block).not.toContain('rtw_save_dirty_patch');
    }
    const check = Bun.spawnSync(['bun', 'run', 'check:bundled'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(check.exitCode, check.stderr.toString() + check.stdout.toString()).toBe(0);
  }, 120000);
});
