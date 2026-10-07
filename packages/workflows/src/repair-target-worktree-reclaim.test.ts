import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const CODEX_LANE = join(REPO_ROOT, '.archon/workflows/defaults/bdc-feature-development-codex.yaml');

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

function bash(script: string, cwd: string, args: string[], env: Record<string, string>): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'rtw-sh-'));
  const scriptPath = join(dir, 'rtw.sh');
  try {
    writeFileSync(scriptPath, script);
    const result = Bun.spawnSync(['bash', scriptPath, ...args], {
      cwd,
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

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function utcMinutesAgo(minutes: number): string {
  const d = new Date(Date.now() - minutes * 60 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

interface Fixture {
  readonly root: string;
  readonly origin: string;
  readonly caller: string;
  readonly holder: string;
  readonly other: string;
  readonly dbPath: string;
  readonly procRoot: string;
}

function makeFixture(opts: { hold: boolean; withOther: boolean }): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'rtw-repo-'));
  const origin = join(root, 'origin.git');
  const main = join(root, 'main');
  const holder = join(root, 'A');
  const caller = join(root, 'B');
  const other = join(root, 'C');
  const dbPath = join(root, 'runs.db');
  const procRoot = join(root, 'proc');
  mkdirSync(procRoot);
  git(['init', '--bare', '--initial-branch=main', origin], root);
  git(['clone', origin, main], root);
  git(['config', 'user.email', 'test@test.com'], main);
  git(['config', 'user.name', 'Test'], main);
  writeFileSync(join(main, 'README.md'), 'init\n');
  git(['add', 'README.md'], main);
  git(['commit', '-m', 'init'], main);
  git(['push', 'origin', 'main'], main);
  git(['branch', 'feat/x'], main);
  git(['push', 'origin', 'feat/x'], main);
  git(['branch', 'other'], main);
  git(['push', 'origin', 'other'], main);
  git(['branch', 'caller'], main);
  if (opts.hold) git(['worktree', 'add', holder, 'feat/x'], main);
  git(['worktree', 'add', caller, 'caller'], main);
  if (opts.withOther) git(['worktree', 'add', other, 'other'], main);
  return { root, origin, caller, holder, other, dbPath, procRoot };
}

function holderPath(holder: string): string {
  return git(['rev-parse', '--show-toplevel'], holder).trim();
}

function writeRuns(
  dbPath: string,
  rows: ReadonlyArray<{
    id: string;
    status: string;
    working_path: string;
    completed_at: string | null;
  }>
): void {
  const db = new Database(dbPath);
  db.run(
    `CREATE TABLE remote_agent_workflow_runs (
      id TEXT PRIMARY KEY,
      status TEXT,
      working_path TEXT,
      completed_at TEXT
    )`
  );
  const insert = db.query(
    'INSERT INTO remote_agent_workflow_runs (id, status, working_path, completed_at) VALUES (?, ?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(row.id, row.status, row.working_path, row.completed_at);
  }
  db.close();
}

function runCheckout(fixture: Fixture, dbPath: string): RunResult {
  git(['fetch', 'origin', 'refs/heads/feat/x'], fixture.caller);
  const script = `set -euo pipefail\n${RTW_CORE}\nrtw_checkout_repair_branch "$1"\n`;
  return bash(script, fixture.caller, ['feat/x'], {
    RTW_RUNS_DB: dbPath,
    RTW_PROC_ROOT: fixture.procRoot,
  });
}

function worktrees(cwd: string): string {
  return git(['worktree', 'list'], cwd);
}

function show(result: RunResult): string {
  return `exit=${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
}

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('repair-target worktree reclaim', () => {
  it('Test 6: a dead holder worktree is reclaimed once', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    writeRuns(fixture.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'failed',
        working_path: holder,
        completed_at: utcMinutesAgo(20),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath);
    if (result.exitCode !== 0) throw new Error(show(result));
    expect(result.stdout).toContain('repair_target_worktree_reclaimed:');
    expect(worktrees(fixture.caller)).not.toContain(holder);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], fixture.caller).trim()).toBe('feat/x');
  }, 30000);

  it('Test 7a: a running holder is refused', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    writeRuns(fixture.dbPath, [
      { id: 'abcd1234ef567890', status: 'running', working_path: holder, completed_at: null },
    ]);
    const result = runCheckout(fixture, fixture.dbPath);
    expect(result.exitCode, show(result)).toBe(1);
    expect(result.stdout).toContain('repair_target_branch_held:');
    expect(worktrees(fixture.caller)).toContain(holder);
  }, 30000);

  it('Test 7b: a terminal holder only two minutes old is refused', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    writeRuns(fixture.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'failed',
        working_path: holder,
        completed_at: utcMinutesAgo(2),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath);
    expect(result.exitCode, show(result)).toBe(1);
    expect(result.stdout).toContain('repair_target_branch_held:');
    expect(worktrees(fixture.caller)).toContain(holder);
  }, 30000);

  it('Test 7c: a live process cwd inside the holder is refused', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    const nested = join(holder, 'nested');
    mkdirSync(nested);
    const pidDir = join(fixture.procRoot, '4242');
    mkdirSync(pidDir);
    symlinkSync(nested, join(pidDir, 'cwd'));
    writeRuns(fixture.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'failed',
        working_path: holder,
        completed_at: utcMinutesAgo(20),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath);
    expect(result.exitCode, show(result)).toBe(1);
    expect(result.stdout).toContain('repair_target_branch_held:');
    expect(worktrees(fixture.caller)).toContain(holder);
  }, 30000);

  it('Test 8a: a holder with no run row is refused', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    writeRuns(fixture.dbPath, []);
    const result = runCheckout(fixture, fixture.dbPath);
    expect(result.exitCode, show(result)).toBe(1);
    expect(result.stdout).toContain('repair_target_branch_held:');
    expect(worktrees(fixture.caller)).toContain(holder);
  }, 30000);

  it('Test 8b: an unreadable runs db is refused', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    const result = runCheckout(fixture, join(fixture.root, 'missing', 'runs.db'));
    expect(result.exitCode, show(result)).toBe(1);
    expect(result.stdout).toContain('repair_target_branch_held:');
    expect(worktrees(fixture.caller)).toContain(holder);
  }, 30000);

  it('Test 8c: a dirty holder is refused', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    writeFileSync(join(holder, 'dirty.txt'), 'dirty\n');
    writeRuns(fixture.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'failed',
        working_path: holder,
        completed_at: utcMinutesAgo(20),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath);
    expect(result.exitCode, show(result)).toBe(1);
    expect(result.stdout).toContain('repair_target_branch_held:');
    expect(worktrees(fixture.caller)).toContain(holder);
  }, 30000);

  it('Test 8d: an unpushed commit is backed up before reclaim', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    writeFileSync(join(holder, 'extra.txt'), 'extra\n');
    git(['add', 'extra.txt'], holder);
    git(['commit', '-m', 'unpushed'], holder);
    const holderSha = git(['rev-parse', 'HEAD'], holder).trim();
    writeRuns(fixture.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'failed',
        working_path: holder,
        completed_at: utcMinutesAgo(20),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath);
    if (result.exitCode !== 0) throw new Error(show(result));
    expect(result.stdout).toContain('backup_branch:');
    expect(worktrees(fixture.caller)).not.toContain(holder);
    const refs = git(['show-ref'], fixture.origin);
    const sha7 = holderSha.slice(0, 7);
    const matched = refs
      .split('\n')
      .find(line =>
        new RegExp(`^${holderSha} refs/heads/backup/feat/x-${sha7}-[0-9]{8}T[0-9]{6}Z$`).test(line)
      );
    expect(matched, refs).toBeTruthy();
  }, 30000);

  it('Test 9: idempotent checkout does not reclaim and leaves the other worktree', () => {
    expect(RTW_CORE).not.toContain('worktree prune');
    expect(RTW_CORE).not.toContain('--force');
    const fixture = makeFixture({ hold: false, withOther: true });
    roots.push(fixture.root);
    const other = holderPath(fixture.other);
    const first = runCheckout(fixture, fixture.dbPath);
    const second = runCheckout(fixture, fixture.dbPath);
    if (first.exitCode !== 0) throw new Error(show(first));
    if (second.exitCode !== 0) throw new Error(show(second));
    expect(first.stdout).not.toContain('repair_target_worktree_reclaimed:');
    expect(second.stdout).not.toContain('repair_target_worktree_reclaimed:');
    expect(worktrees(fixture.caller)).toContain(other);
  }, 30000);
});
