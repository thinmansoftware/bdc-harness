import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'yaml';

const LANE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '.archon',
  'workflows',
  'defaults',
  'bdc-feature-development-codex.yaml'
);

function extractCore(): string {
  const parsed = parse(readFileSync(LANE, 'utf8')) as {
    nodes?: Array<{ id: string; bash?: string }>;
  };
  const bash = parsed.nodes?.find(node => node.id === 'checkout-repair-target')?.bash ?? '';
  const beginMarker =
    '# ---- BEGIN rtw core (byte-identical across lanes; extracted by unit test) ----';
  const endMarker = '# ---- END rtw core ----';
  const begin = bash.indexOf(beginMarker);
  const end = bash.indexOf(endMarker, begin);
  if (begin < 0 || end < 0) throw new Error('rtw core markers missing');
  return bash.slice(begin, end + endMarker.length);
}

const CORE = extractCore();

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync(args, {
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
}

function git(args: string[], cwd: string): string {
  const result = run(['git', ...args], cwd, {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function utcSql(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

let fixture: string;
let origin: string;
let main: string;
let holder: string;
let runner: string;
let other: string;
let procRoot: string;
let dbPath: string;

function resetRows(rows: Array<[string, string, string, string | null]>): void {
  rmSync(dbPath, { force: true });
  const db = new Database(dbPath);
  db.run(
    'CREATE TABLE remote_agent_workflow_runs (id TEXT, status TEXT, working_path TEXT, completed_at TEXT)'
  );
  const insert = db.prepare(
    'INSERT INTO remote_agent_workflow_runs (id, status, working_path, completed_at) VALUES (?, ?, ?, ?)'
  );
  for (const row of rows) insert.run(...row);
  db.close();
}

function invoke(): ReturnType<typeof run> {
  git(['fetch', 'origin', 'refs/heads/feat/x'], runner);
  const script = `set -u\n${CORE}\nrtw_checkout_repair_branch feat/x\n`;
  const scriptPath = join(fixture, 'invoke.sh');
  writeFileSync(scriptPath, script);
  return run(['bash', scriptPath], runner, {
    RTW_RUNS_DB: dbPath,
    RTW_PROC_ROOT: procRoot,
    RTW_MIN_AGE_SECONDS: '600',
  });
}

function worktrees(): string {
  return git(['worktree', 'list', '--porcelain'], main);
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'rtw-'));
  origin = join(fixture, 'origin.git');
  main = join(fixture, 'main');
  holder = join(fixture, 'holder with spaces');
  runner = join(fixture, 'runner');
  other = join(fixture, 'other');
  procRoot = join(fixture, 'proc');
  dbPath = join(fixture, 'runs.db');
  mkdirSync(procRoot);

  git(['init', '--bare', '--initial-branch=main', origin], fixture);
  git(['clone', origin, main], fixture);
  git(['config', 'user.name', 'Test'], main);
  git(['config', 'user.email', 'test@example.com'], main);
  writeFileSync(join(main, 'README.md'), 'initial\n');
  git(['add', 'README.md'], main);
  git(['commit', '-m', 'initial'], main);
  git(['push', 'origin', 'main'], main);
  git(['branch', 'feat/x'], main);
  git(['push', 'origin', 'feat/x'], main);
  git(['worktree', 'add', holder, 'feat/x'], main);
  git(['worktree', 'add', '-b', 'runner', runner, 'main'], main);
  git(['worktree', 'add', '-b', 'other', other, 'main'], main);
  resetRows([['12345678-dead-run', 'failed', holder, utcSql(1200)]]);
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('repair-target worktree reclaim core', () => {
  it('reclaims one clean worktree held by an old terminal run', () => {
    const result = invoke();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('repair_target_worktree_reclaimed:');
    expect(result.stdout).toContain('(run 12345678 status failed completed_at ');
    expect(worktrees()).not.toContain(holder);
    expect(worktrees()).toContain(other);
    expect(git(['branch', '--show-current'], runner)).toBe('feat/x');
  });

  for (const scenario of ['running', 'recent', 'process-active'] as const) {
    it(`refuses a ${scenario} holder`, () => {
      if (scenario === 'running') {
        resetRows([['live-run', 'running', holder, utcSql(1200)]]);
      } else if (scenario === 'recent') {
        resetRows([['recent-run', 'failed', holder, utcSql(120)]]);
      } else {
        const processDir = join(procRoot, '123');
        mkdirSync(processDir);
        symlinkSync(holder, join(processDir, 'cwd'));
      }
      const result = invoke();
      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('repair_target_branch_held:');
      expect(worktrees()).toContain(holder);
    });
  }

  it('refuses unknown, unreadable, malformed-time, and dirty holders', () => {
    resetRows([]);
    let result = invoke();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('repair_target_branch_held:');

    dbPath = join(fixture, 'missing', 'runs.db');
    result = invoke();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('repair_target_branch_held:');

    dbPath = join(fixture, 'malformed.db');
    resetRows([['bad-time', 'failed', holder, 'not-a-time']]);
    result = invoke();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('repair_target_branch_held:');

    dbPath = join(fixture, 'dirty.db');
    resetRows([['dirty-run', 'failed', holder, utcSql(1200)]]);
    writeFileSync(join(holder, 'dirty.txt'), 'dirty\n');
    result = invoke();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('holder is dirty');
    expect(worktrees()).toContain(holder);
  });

  it('backs up an unpushed holder commit before reclaiming it', () => {
    writeFileSync(join(holder, 'local.txt'), 'local-only\n');
    git(['add', 'local.txt'], holder);
    git(['commit', '-m', 'local holder commit'], holder);
    const holderTip = git(['rev-parse', 'HEAD'], holder);
    const result = invoke();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('backup_branch: refs/heads/backup/feat/x-');
    const backup = result.stdout.match(
      /backup_branch: (refs\/heads\/backup\/feat\/x-[0-9a-f]{7}-\d{8}T\d{6}Z)/
    )?.[1];
    expect(backup).toBeDefined();
    expect(git(['ls-remote', 'origin', backup!], runner).split(/\s+/)[0]).toBe(holderTip);
    expect(worktrees()).not.toContain(holder);
  });

  it('is idempotent without a holder and preserves unrelated worktrees', () => {
    git(['worktree', 'remove', holder], main);
    const first = invoke();
    const second = invoke();
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(`${first.stdout}${second.stdout}`).not.toContain('repair_target_worktree_reclaimed:');
    expect(worktrees()).toContain(other);
    expect(CORE).not.toContain('worktree prune');
    expect(CORE).not.toContain('remove --force');
  });

  it('fails closed when process inspection is unavailable', () => {
    procRoot = join(fixture, 'missing-proc');
    const result = invoke();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('process root is unavailable');
    expect(worktrees()).toContain(holder);
  });
});
