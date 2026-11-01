import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
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

function utcSecondsAgo(seconds: number): string {
  const d = new Date(Date.now() - seconds * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function utcMinutesAgo(minutes: number): string {
  return utcSecondsAgo(minutes * 60);
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

function runCheckout(
  fixture: Fixture,
  dbPath: string,
  extraEnv: Record<string, string> = {}
): RunResult {
  git(['fetch', 'origin', 'refs/heads/feat/x'], fixture.caller);
  const script = `set -euo pipefail\n${RTW_CORE}\nrtw_checkout_repair_branch "$1"\n`;
  return bash(script, fixture.caller, ['feat/x'], {
    RTW_RUNS_DB: dbPath,
    RTW_PROC_ROOT: fixture.procRoot,
    ...extraEnv,
  });
}

function sleepShim(fixture: Fixture): {
  readonly env: Record<string, string>;
  readonly logFile: string;
} {
  const bin = join(fixture.root, 'sleep-bin');
  mkdirSync(bin);
  const logFile = join(fixture.root, 'sleep.log');
  writeFileSync(
    join(bin, 'sleep'),
    `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(logFile)}\n`,
    { mode: 0o755 }
  );
  chmodSync(join(bin, 'sleep'), 0o755);
  return { env: { PATH: `${bin}:${process.env.PATH ?? ''}` }, logFile };
}

function sleepTotal(logFile: string): number {
  if (!existsSync(logFile)) return 0;
  const raw = readFileSync(logFile, 'utf8').trim();
  if (raw.length === 0) return 0;
  let total = 0;
  for (const line of raw.split('\n')) {
    const value = Number(line);
    if (!Number.isFinite(value)) throw new Error(`bad sleep log line: ${line}`);
    total += value;
  }
  return total;
}

function quarantineFiles(dir: string, suffix: string): string[] {
  return readdirSync(dir)
    .filter(name => name.endsWith(suffix))
    .map(name => join(dir, name));
}

function worktrees(cwd: string): string {
  return git(['worktree', 'list'], cwd);
}

function show(result: RunResult): string {
  return `exit=${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
}

const roots: string[] = [];

afterEach(() => {
  Bun.gc(true);
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      expect(root.startsWith(join(tmpdir(), 'rtw-repo-'))).toBe(true);
      removeTempDirWithRetry(root);
    }
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

  it('Test 7b: a completed holder only two minutes old is refused by the age gate', () => {
    // The age gate stays in force for `completed` holders (only escalated/failed/
    // cancelled skip it, per WO-HARNESS-REPAIR-PATH-HOTFIX-01 F3a / item 1e).
    // Max grace wait 0 keeps the refusal immediate, with no wall-clock sleep.
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    writeRuns(fixture.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'completed',
        working_path: holder,
        completed_at: utcMinutesAgo(2),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath, { RTW_MAX_GRACE_WAIT_SECONDS: '0' });
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
    // A dirty terminal holder is quarantined, then reclaimed.
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    const qdir = join(fixture.root, 'quarantine');
    mkdirSync(qdir);
    writeFileSync(join(holder, 'dirty.txt'), 'dirty\n');
    writeRuns(fixture.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'failed',
        working_path: holder,
        completed_at: utcMinutesAgo(20),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath, { RTW_QUARANTINE_DIR: qdir });
    if (result.exitCode !== 0) throw new Error(show(result));
    expect(result.stdout).toContain('repair_target_quarantined:');
    expect(result.stdout).toContain(qdir);
    expect(result.stdout).toContain('repair_target_worktree_reclaimed:');
    expect(worktrees(fixture.caller)).not.toContain(holder);
    expect(quarantineFiles(qdir, '.patch').length).toBe(1);
    const tarPath = quarantineFiles(qdir, '.tar');
    expect(tarPath.length).toBe(1);
    const listed = Bun.spawnSync(['tar', '-tf', tarPath[0]], { stdout: 'pipe', stderr: 'pipe' });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.toString()).toContain('dirty.txt');
    expect(git(['stash', 'list'], fixture.caller)).toContain('reclaim-');
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

  // WO-HARNESS-REPAIR-PATH-HOTFIX-01 F3a / item 1e: escalated/failed/cancelled holders
  // skip the RTW_MIN_AGE_SECONDS age gate (a conductor climbs ~11-26s after the prior
  // rung ends), while the completed age gate and the live-cwd/dirty safety checks remain.
  it('Test 3: an escalated holder 15s old with no live cwd and a clean tree is reclaimed', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    writeRuns(fixture.dbPath, [
      {
        id: 'older-completed-row',
        status: 'completed',
        working_path: holder,
        completed_at: utcMinutesAgo(20),
      },
      {
        id: 'abcd1234ef567890',
        status: 'escalated',
        working_path: holder,
        completed_at: utcSecondsAgo(15),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath);
    if (result.exitCode !== 0) throw new Error(show(result));
    expect(result.stdout).toContain('repair_target_worktree_reclaimed:');
    expect(result.stdout).not.toContain('completed_at is only');
    expect(worktrees(fixture.caller)).not.toContain(holder);
  }, 30000);

  it('Test 4: a completed holder 15s old stays age-gated and prints the reason on STDERR', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    writeRuns(fixture.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'completed',
        working_path: holder,
        completed_at: utcSecondsAgo(15),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath, { RTW_MAX_GRACE_WAIT_SECONDS: '0' });
    expect(result.exitCode, show(result)).toBe(1);
    expect(result.stderr).toContain('repair_target_branch_held:');
    expect(result.stderr).toContain('completed_at is only');
    expect(worktrees(fixture.caller)).toContain(holder);
  }, 30000);

  it('Test 5a: a failed holder 15s old is still refused when a live process cwd is under it', () => {
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
        completed_at: utcSecondsAgo(15),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath);
    expect(result.exitCode, show(result)).toBe(1);
    expect(result.stderr).toContain('live process cwd under holder');
    expect(worktrees(fixture.caller)).toContain(holder);
  }, 30000);

  it('Test 5b: a failed holder 15s old is still refused when the worktree is dirty', () => {
    // A dirty terminal holder is quarantined, then reclaimed.
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    const qdir = join(fixture.root, 'quarantine');
    mkdirSync(qdir);
    writeFileSync(join(holder, 'dirty.txt'), 'dirty\n');
    writeRuns(fixture.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'failed',
        working_path: holder,
        completed_at: utcSecondsAgo(15),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath, { RTW_QUARANTINE_DIR: qdir });
    if (result.exitCode !== 0) throw new Error(show(result));
    expect(result.stdout).toContain('repair_target_quarantined:');
    expect(result.stdout).toContain('repair_target_worktree_reclaimed:');
    expect(worktrees(fixture.caller)).not.toContain(holder);
    expect(git(['stash', 'list'], fixture.caller)).toContain('reclaim-');
  }, 30000);

  function dirtyEscalated(fixture: Fixture): { holder: string; head: string; qdir: string } {
    const holder = holderPath(fixture.holder);
    writeFileSync(join(holder, 'gone.txt'), 'gone\n');
    git(['add', 'gone.txt'], holder);
    git(['commit', '-m', 'add gone'], holder);
    const head = git(['rev-parse', 'HEAD'], holder).trim();
    git(['rm', 'gone.txt'], holder);
    writeFileSync(join(holder, 'README.md'), 'init\nedited\n');
    writeFileSync(join(holder, 'keep me.txt'), 'untracked-body\n');
    const qdir = join(fixture.root, 'quarantine');
    mkdirSync(qdir);
    writeRuns(fixture.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'escalated',
        working_path: holder,
        completed_at: utcSecondsAgo(15),
      },
    ]);
    return { holder, head, qdir };
  }

  it('Test 1: young completed holder is waited out, then reclaimed', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    const shim = sleepShim(fixture);
    writeRuns(fixture.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'completed',
        working_path: holder,
        completed_at: utcSecondsAgo(397),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath, shim.env);
    if (result.exitCode !== 0) throw new Error(show(result));
    const waited = sleepTotal(shim.logFile);
    expect(waited).toBeGreaterThanOrEqual(190);
    expect(waited).toBeLessThanOrEqual(210);
    const logged = result.stdout.match(/repair_target_grace_wait: (\d+)s/);
    expect(logged, result.stdout).not.toBeNull();
    expect(Number(logged?.[1])).toBe(waited);
    expect(result.stdout).not.toContain('repair_target_branch_held');
    expect(result.stdout).toContain('repair_target_worktree_reclaimed:');
    expect(worktrees(fixture.caller)).not.toContain(holder);
  }, 30000);

  it('Test 2: grace wait is bounded', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    const shim = sleepShim(fixture);
    writeRuns(fixture.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'completed',
        working_path: holder,
        completed_at: utcSecondsAgo(397),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath, {
      ...shim.env,
      RTW_MAX_GRACE_WAIT_SECONDS: '10',
    });
    expect(result.exitCode, show(result)).toBe(1);
    expect(sleepTotal(shim.logFile)).toBe(0);
    expect(result.stdout).toContain('completed_at is only');
    expect(result.stdout).toContain('repair_target_branch_held:');
    expect(result.stdout).not.toContain('repair_target_worktree_reclaimed:');
    expect(worktrees(fixture.caller)).toContain(holder);
  }, 30000);

  it('Test 3: dirty holder of an escalated run is quarantined, then reclaimed', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const dirty = dirtyEscalated(fixture);
    const result = runCheckout(fixture, fixture.dbPath, { RTW_QUARANTINE_DIR: dirty.qdir });
    if (result.exitCode !== 0) throw new Error(show(result));
    expect(result.stdout).toContain('repair_target_quarantined:');
    expect(result.stdout).toContain(dirty.qdir);
    expect(result.stdout).not.toContain('repair_target_branch_held');
    expect(result.stdout).toContain('repair_target_worktree_reclaimed:');
    expect(worktrees(fixture.caller)).not.toContain(dirty.holder);
    const patches = quarantineFiles(dirty.qdir, '.patch');
    expect(patches.length).toBe(1);
    const patch = readFileSync(patches[0], 'utf8');
    expect(patch).toContain('gone.txt');
    expect(patch).toContain('README.md');
    expect(patch).toContain('+edited');
    const tars = quarantineFiles(dirty.qdir, '.tar');
    expect(tars.length).toBe(1);
    const extracted = join(fixture.root, 'extracted');
    mkdirSync(extracted);
    const unpack = Bun.spawnSync(['tar', '-xf', tars[0], '-C', extracted], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(unpack.exitCode, unpack.stderr.toString()).toBe(0);
    expect(readFileSync(join(extracted, 'keep me.txt'), 'utf8')).toBe('untracked-body\n');
    expect(git(['stash', 'list'], fixture.caller)).toContain('reclaim-');
  }, 30000);

  it('Test 4: quarantined patch round-trips', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const dirty = dirtyEscalated(fixture);
    const result = runCheckout(fixture, fixture.dbPath, { RTW_QUARANTINE_DIR: dirty.qdir });
    if (result.exitCode !== 0) throw new Error(show(result));
    const patches = quarantineFiles(dirty.qdir, '.patch');
    expect(patches.length).toBe(1);
    const fresh = join(fixture.root, 'fresh');
    git(['worktree', 'add', '--detach', fresh, dirty.head], fixture.caller);
    const apply = Bun.spawnSync(['git', 'apply', patches[0]], {
      cwd: fresh,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(apply.exitCode, apply.stderr.toString()).toBe(0);
    expect(existsSync(join(fresh, 'gone.txt'))).toBe(false);
    expect(readFileSync(join(fresh, 'README.md'), 'utf8')).toBe('init\nedited\n');
  }, 30000);

  it('Test 5: patch write failure refuses', () => {
    const fixture = makeFixture({ hold: true, withOther: false });
    roots.push(fixture.root);
    const holder = holderPath(fixture.holder);
    const blocker = join(fixture.root, 'not-a-dir');
    writeFileSync(blocker, 'x\n');
    const qdir = join(blocker, 'quarantine');
    writeFileSync(join(holder, 'dirty.txt'), 'still-here\n');
    writeRuns(fixture.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'failed',
        working_path: holder,
        completed_at: utcMinutesAgo(20),
      },
    ]);
    const result = runCheckout(fixture, fixture.dbPath, { RTW_QUARANTINE_DIR: qdir });
    expect(result.exitCode, show(result)).toBe(1);
    expect(result.stdout).toContain('quarantine');
    expect(result.stdout).toContain('repair_target_branch_held:');
    expect(result.stdout).not.toContain('repair_target_worktree_reclaimed:');
    expect(worktrees(fixture.caller)).toContain(holder);
    expect(readFileSync(join(holder, 'dirty.txt'), 'utf8')).toBe('still-here\n');
    expect(git(['stash', 'list'], fixture.caller)).not.toContain('reclaim-');
  }, 30000);

  it('Test 6: live or running holders still refused', () => {
    const running = makeFixture({ hold: true, withOther: false });
    roots.push(running.root);
    const runningHolder = holderPath(running.holder);
    writeRuns(running.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'running',
        working_path: runningHolder,
        completed_at: null,
      },
    ]);
    const runningResult = runCheckout(running, running.dbPath);
    expect(runningResult.exitCode, show(runningResult)).toBe(1);
    expect(runningResult.stdout).toContain('status running is not terminal');
    expect(worktrees(running.caller)).toContain(runningHolder);

    const live = makeFixture({ hold: true, withOther: false });
    roots.push(live.root);
    const liveHolder = holderPath(live.holder);
    const nested = join(liveHolder, 'nested');
    mkdirSync(nested);
    const pidDir = join(live.procRoot, '4242');
    mkdirSync(pidDir);
    symlinkSync(nested, join(pidDir, 'cwd'));
    writeRuns(live.dbPath, [
      {
        id: 'abcd1234ef567890',
        status: 'failed',
        working_path: liveHolder,
        completed_at: utcMinutesAgo(20),
      },
    ]);
    const liveResult = runCheckout(live, live.dbPath);
    expect(liveResult.exitCode, show(liveResult)).toBe(1);
    expect(liveResult.stdout).toContain('live process cwd under holder');
    expect(liveResult.stdout).not.toContain('repair_target_worktree_reclaimed:');
    expect(worktrees(live.caller)).toContain(liveHolder);
  }, 30000);

  it('Test 7: every lane carries the change', () => {
    const lanesDir = join(REPO_ROOT, '.archon/workflows/defaults');
    const lanes = readdirSync(lanesDir).filter(name => name.endsWith('.yaml'));
    const held = lanes.filter(name =>
      readFileSync(join(lanesDir, name), 'utf8').includes('repair_target_branch_held')
    );
    expect(held.length).toBeGreaterThan(0);
    for (const name of held) {
      const text = readFileSync(join(lanesDir, name), 'utf8');
      expect(text, name).toContain('repair_target_quarantined');
      expect(text, name).toContain('repair_target_grace_wait');
    }
    const bundle = readFileSync(
      join(REPO_ROOT, 'packages/workflows/src/defaults/bundled-defaults.generated.ts'),
      'utf8'
    );
    expect(bundle).toContain('repair_target_quarantined');
    expect(bundle).toContain('repair_target_grace_wait');
  });
});
