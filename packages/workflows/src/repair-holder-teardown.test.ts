import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setProcessGroupControlForTests } from '@archon/git';
import type { DagNode, WorkflowRun } from './schemas';
import type { IWorkflowPlatform, WorkflowConfig, WorkflowDeps } from './deps';
import type { IWorkflowStore } from './store';
import { parseWorkflow } from './loader';
import { executeDagWorkflow, resetRunTeardownStateForTests } from './dag-executor';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const DEFAULTS = join(REPO_ROOT, '.archon/workflows/defaults');
const LANES = [
  'bdc-feature-development.yaml',
  'bdc-feature-development-astra.yaml',
  'bdc-feature-development-codex.yaml',
  'bdc-feature-development-codex-only.yaml',
  'bdc-feature-development-cursor.yaml',
  'bdc-feature-development-fable.yaml',
  'bdc-feature-development-fusion-cx-kimi.yaml',
  'bdc-feature-development-fusion-cx-qwen.yaml',
  'bdc-feature-development-grok.yaml',
  'bdc-feature-development-kimi-k3.yaml',
  'bdc-feature-development-zero.yaml',
  'bdc-feature-development-zero-claude.yaml',
  'bdc-feature-development-zero-open.yaml',
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
      .split('\n')
      .map(line => (line.startsWith('      ') ? line.slice(6) : line))
      .join('\n') + '\n'
  );
}

const RTW_CORE = extractRtwCore(
  readFileSync(join(DEFAULTS, 'bdc-feature-development.yaml'), 'utf8')
);

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Fixture {
  readonly root: string;
  readonly origin: string;
  readonly caller: string;
  readonly holder: string;
  readonly dbPath: string;
  readonly procRoot: string;
}

const roots: string[] = [];

function bash(
  script: string,
  cwd: string,
  args: string[],
  env: Record<string, string>,
  stripArtifacts: boolean
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'rht-sh-'));
  const scriptPath = join(dir, 'rtw.sh');
  try {
    writeFileSync(scriptPath, script);
    const merged: Record<string, string | undefined> = { ...process.env, ...env };
    if (stripArtifacts) delete merged.ARTIFACTS_DIR;
    const result = Bun.spawnSync(['bash', scriptPath, ...args], {
      cwd,
      env: merged,
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

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'rht-repo-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const main = join(root, 'main');
  const holder = join(root, 'A');
  const caller = join(root, 'B');
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
  git(['branch', 'caller'], main);
  git(['worktree', 'add', holder, 'feat/x'], main);
  git(['worktree', 'add', caller, 'caller'], main);
  return { root, origin, caller, holder, dbPath, procRoot };
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

function plantCwd(procRoot: string, pid: number, target: string, comm: string): string {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  symlinkSync(target, join(dir, 'cwd'));
  writeFileSync(join(dir, 'comm'), `${comm}\n`);
  return dir;
}

function worktrees(cwd: string): string {
  return git(['worktree', 'list'], cwd);
}

function show(result: RunResult): string {
  return `exit=${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
}

function runCore(fixture: Fixture, extraEnv: Record<string, string>, preamble = ''): RunResult {
  git(['fetch', 'origin', 'refs/heads/feat/x'], fixture.caller);
  const script = `set -euo pipefail\n${preamble}\n${RTW_CORE}\nrtw_checkout_repair_branch "$1"\n`;
  const strip = !Object.prototype.hasOwnProperty.call(extraEnv, 'ARTIFACTS_DIR');
  return bash(
    script,
    fixture.caller,
    ['feat/x'],
    {
      RTW_RUNS_DB: fixture.dbPath,
      RTW_PROC_ROOT: fixture.procRoot,
      ...extraEnv,
    },
    strip
  );
}

function terminalRow(
  holder: string,
  status = 'failed'
): {
  id: string;
  status: string;
  working_path: string;
  completed_at: string;
} {
  return {
    id: 'abcd1234ef567890',
    status,
    working_path: holder,
    completed_at: utcSecondsAgo(30),
  };
}

const minimalConfig: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

function createMockStore(): IWorkflowStore {
  const methods = new Map<string, ReturnType<typeof mock>>();
  return new Proxy({} as IWorkflowStore, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      let fn = methods.get(prop);
      if (!fn) {
        fn = mock(async () => {
          if (prop === 'getWorkflowRunStatus') return 'running';
          if (prop === 'getCompletedDagNodeOutputs') return new Map<string, string>();
          if (prop === 'listProviderAttempts' || prop === 'listWorkflowEvents') return [];
          if (prop === 'createProviderAttempt') return true;
          return null;
        });
        methods.set(prop, fn);
      }
      return fn;
    },
  });
}

function createPlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

function makeRun(id: string, workingPath: string): WorkflowRun {
  return {
    id,
    workflow_name: 'teardown-test',
    conversation_id: 'conv-teardown',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'teardown',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: workingPath,
  };
}

async function runDag(
  dir: string,
  runId: string,
  nodes: DagNode[]
): Promise<{ store: IWorkflowStore; failMessage: string; order: string[] }> {
  const store = createMockStore();
  const order: string[] = [];
  let failMessage = '';
  (store.updateWorkflowRun as ReturnType<typeof mock>).mockImplementation(
    async (_id: string, updates: { metadata?: Record<string, unknown>; status?: string }) => {
      const metadata = updates.metadata ?? {};
      if (Object.prototype.hasOwnProperty.call(metadata, 'teardown_confirmed_at')) {
        order.push('teardown_confirmed_at');
      } else if (Object.prototype.hasOwnProperty.call(metadata, 'teardown_survivors')) {
        order.push('teardown_survivors');
      } else if (updates.status) {
        order.push(`status:${updates.status}`);
      } else {
        order.push('update');
      }
    }
  );
  (store.completeWorkflowRun as ReturnType<typeof mock>).mockImplementation(async () => {
    order.push('complete');
  });
  (store.failWorkflowRun as ReturnType<typeof mock>).mockImplementation(
    async (_id: string, message: string) => {
      failMessage = message;
      order.push('fail');
    }
  );
  const deps = {
    store,
    getAgentProvider: mock(() => {
      throw new Error('bash fixture must not call a provider');
    }),
    loadConfig: mock(async () => minimalConfig),
  } as unknown as WorkflowDeps;
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  await executeDagWorkflow(
    deps,
    createPlatform(),
    'conv-teardown',
    dir,
    { name: 'teardown-fixture', nodes },
    makeRun(runId, dir),
    'claude',
    undefined,
    join(dir, 'artifacts'),
    join(dir, 'logs'),
    'main',
    'docs/',
    minimalConfig
  );
  return { store, failMessage, order };
}

function eventError(store: IWorkflowStore, nodeId: string): string {
  const calls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
    [{ event_type?: string; step_name?: string; data?: { error?: string } }]
  >;
  const match = calls.find(
    call => call[0]?.event_type === 'node_failed' && call[0]?.step_name === nodeId
  );
  return match?.[0]?.data?.error ?? '';
}

function pidIsLive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state =
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[0] ?? '';
    return state !== '' && state !== 'Z';
  } catch {
    return false;
  }
}

function pidsIn(dir: string): number[] {
  const found: number[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const link = readlinkSync(join('/proc', entry, 'cwd'));
      if (link === dir || link.startsWith(`${dir}/`)) found.push(Number(entry));
    } catch {
      // The process exited between readdir and readlink.
    }
  }
  return found;
}

function nodeHasAbort(yaml: string, id: string): boolean {
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() !== `- id: ${id}`) continue;
    const window = lines.slice(i, i + 20).join('\n');
    if (window.includes('abort_run_on_failure: true')) return true;
  }
  return false;
}

afterEach(() => {
  setProcessGroupControlForTests(null);
  resetRunTeardownStateForTests();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe.serial('repair holder teardown', () => {
  it('Test 1: a terminal holder is reclaimed after its process exits', async () => {
    const fixture = makeFixture();
    const holder = holderPath(fixture.holder);
    writeRuns(fixture.dbPath, [terminalRow(holder, 'escalated')]);
    const pidDir = plantCwd(fixture.procRoot, 5151, holder, 'sleeper');
    git(['fetch', 'origin', 'refs/heads/feat/x'], fixture.caller);
    const dir = mkdtempSync(join(tmpdir(), 'rht-sh-'));
    const scriptPath = join(dir, 'rtw.sh');
    writeFileSync(scriptPath, `set -euo pipefail\n${RTW_CORE}\nrtw_checkout_repair_branch "$1"\n`);
    const env: Record<string, string | undefined> = {
      ...process.env,
      RTW_RUNS_DB: fixture.dbPath,
      RTW_PROC_ROOT: fixture.procRoot,
      RTW_HOLDER_WAIT_SECONDS: '20',
    };
    delete env.ARTIFACTS_DIR;
    const started = Date.now();
    const proc = Bun.spawn(['bash', scriptPath, 'feat/x'], {
      cwd: fixture.caller,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      await Bun.sleep(5500);
      expect(worktrees(fixture.caller)).toContain(holder);
      rmSync(pidDir, { recursive: true, force: true });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const elapsed = Date.now() - started;
      expect(elapsed, `${stdout}\n${stderr}`).toBeGreaterThanOrEqual(6000);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain('repair_target_worktree_reclaimed:');
      expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], fixture.caller).trim()).toBe('feat/x');
      expect(worktrees(fixture.caller)).not.toContain(holder);
    } finally {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('Test 2: a live non-terminal owner is never evicted', () => {
    const running = makeFixture();
    const runningHolder = holderPath(running.holder);
    writeFileSync(join(runningHolder, 'keep.txt'), 'keep\n');
    plantCwd(running.procRoot, 5151, runningHolder, 'sleeper');
    writeRuns(running.dbPath, [
      {
        id: 'running-row-0001',
        status: 'running',
        working_path: runningHolder,
        completed_at: null,
      },
    ]);
    const started = Date.now();
    const runningResult = runCore(running, { RTW_HOLDER_WAIT_SECONDS: '20' });
    expect(Date.now() - started, show(runningResult)).toBeLessThan(3000);
    expect(runningResult.exitCode, show(runningResult)).not.toBe(0);
    expect(runningResult.stdout).toContain('status running is not terminal');
    expect(worktrees(running.caller)).toContain(runningHolder);
    expect(readFileSync(join(runningHolder, 'keep.txt'), 'utf8')).toBe('keep\n');

    const mixed = makeFixture();
    const mixedHolder = holderPath(mixed.holder);
    writeFileSync(join(mixedHolder, 'keep.txt'), 'keep\n');
    plantCwd(mixed.procRoot, 5152, mixedHolder, 'sleeper');
    writeRuns(mixed.dbPath, [
      terminalRow(mixedHolder, 'failed'),
      {
        id: 'running-row-0002',
        status: 'running',
        working_path: mixedHolder,
        completed_at: null,
      },
    ]);
    const mixedStarted = Date.now();
    const mixedResult = runCore(mixed, { RTW_HOLDER_WAIT_SECONDS: '20' });
    expect(Date.now() - mixedStarted, show(mixedResult)).toBeLessThan(3000);
    expect(mixedResult.exitCode, show(mixedResult)).not.toBe(0);
    expect(mixedResult.stdout).toContain('status running is not terminal');
    expect(worktrees(mixed.caller)).toContain(mixedHolder);
    expect(readFileSync(join(mixedHolder, 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('Test 3: uncommitted changes are preserved as a patch before reclaim', () => {
    const saved = makeFixture();
    const holder = holderPath(saved.holder);
    const head = git(['rev-parse', 'HEAD'], holder).trim();
    writeFileSync(join(holder, 'README.md'), 'changed\n');
    writeFileSync(join(holder, 'notes.txt'), 'untracked\n');
    writeFileSync(join(holder, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    writeRuns(saved.dbPath, [terminalRow(holder)]);
    const artifacts = join(saved.root, 'artifacts');
    mkdirSync(artifacts);
    const result = runCore(saved, { ARTIFACTS_DIR: artifacts });
    expect(result.exitCode, show(result)).toBe(0);
    const match = result.stdout.match(/holder_patch_saved: (\S+) sha256 ([0-9a-f]{64})/);
    expect(match, show(result)).not.toBeNull();
    const patchPath = match?.[1] ?? '';
    const printed = match?.[2] ?? '';
    expect(patchPath).toContain(`${join('reclaimed-holder', 'abcd1234')}`);
    expect(createHash('sha256').update(readFileSync(patchPath)).digest('hex')).toBe(printed);
    expect(
      readFileSync(join(artifacts, 'reclaimed-holder', 'abcd1234', 'git-status.porcelain'), 'utf8')
    ).toContain('notes.txt');
    const fresh = join(saved.root, 'fresh');
    git(['worktree', 'add', '--detach', fresh, head], join(saved.root, 'main'));
    const check = Bun.spawnSync(['git', 'apply', '--check', patchPath], {
      cwd: fresh,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(check.exitCode, check.stderr.toString()).toBe(0);
    const applied = Bun.spawnSync(['git', 'apply', patchPath], {
      cwd: fresh,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(applied.exitCode, applied.stderr.toString()).toBe(0);
    expect(readFileSync(join(fresh, 'README.md'), 'utf8')).toBe('changed\n');
    expect(readFileSync(join(fresh, 'notes.txt'), 'utf8')).toBe('untracked\n');
    expect(readFileSync(join(fresh, 'blob.bin'))).toEqual(Buffer.from([0x00, 0x01, 0x02, 0xff]));
    expect(worktrees(saved.caller)).not.toContain(holder);

    const refused = makeFixture();
    const dirtyHolder = holderPath(refused.holder);
    writeFileSync(join(dirtyHolder, 'README.md'), 'changed\n');
    writeFileSync(join(dirtyHolder, 'notes.txt'), 'untracked\n');
    writeRuns(refused.dbPath, [terminalRow(dirtyHolder)]);
    const refusedResult = runCore(refused, {});
    expect(refusedResult.exitCode, show(refusedResult)).not.toBe(0);
    expect(`${refusedResult.stdout}\n${refusedResult.stderr}`).toContain('worktree is dirty');
    expect(worktrees(refused.caller)).toContain(dirtyHolder);
  });

  it('Test 4: waitForPriorTeardown is the conductor retry gate', () => {
    const source = readFileSync(join(REPO_ROOT, 'packages/smart-cauldron/src/cascade.ts'), 'utf8');
    expect(source).toContain('export async function waitForPriorTeardown');
    expect(source).toContain('teardown_unconfirmed');
    expect(source).toContain('SMART_CAULDRON_TEARDOWN_WAIT_MS');
  });

  it('Test 5: a terminal run ends its process tree before release', async () => {
    const backgroundDir = mkdtempSync(join(tmpdir(), 'rht-bg-'));
    roots.push(backgroundDir);
    const background = await runDag(backgroundDir, 'run-background-tree', [
      {
        id: 'bg',
        bash: 'sleep 300 >/dev/null 2>&1 &\necho $! > child.pid\necho done\n',
      },
    ]);
    const childPid = Number(readFileSync(join(backgroundDir, 'child.pid'), 'utf8').trim());
    expect(childPid).toBeGreaterThan(1);
    expect(pidIsLive(childPid)).toBe(false);
    expect(pidsIn(backgroundDir)).toEqual([]);
    const confirmedAt = background.order.indexOf('teardown_confirmed_at');
    const completedAt = background.order.indexOf('complete');
    expect(confirmedAt).toBeGreaterThanOrEqual(0);
    expect(completedAt).toBeGreaterThan(confirmedAt);
    expect(background.order).not.toContain('teardown_survivors');

    const timeoutDir = mkdtempSync(join(tmpdir(), 'rht-timeout-'));
    roots.push(timeoutDir);
    const timed = await runDag(timeoutDir, 'run-timeout-tree', [
      {
        id: 'hang',
        bash: 'sleep 300 &\nsleep 300\n',
        timeout: 400,
      },
    ]);
    expect(eventError(timed.store, 'hang')).toContain('timed out after 400ms');
    expect(pidsIn(timeoutDir)).toEqual([]);
    const timeoutConfirmed = timed.order.indexOf('teardown_confirmed_at');
    const timeoutFailed = timed.order.indexOf('fail');
    expect(timeoutConfirmed).toBeGreaterThanOrEqual(0);
    expect(timeoutFailed).toBeGreaterThan(timeoutConfirmed);

    setProcessGroupControlForTests({
      signal(pid, signal) {
        if (signal !== 0) {
          try {
            process.kill(-pid, signal);
          } catch {
            // The real child is already gone. The seam still reports a survivor.
          }
        }
        return true;
      },
      groupExists() {
        return true;
      },
    });
    const survivorDir = mkdtempSync(join(tmpdir(), 'rht-survivor-'));
    roots.push(survivorDir);
    const survived = await runDag(survivorDir, 'run-survivor-tree', [
      {
        id: 'unkillable',
        bash: 'sleep 300\n',
        timeout: 300,
      },
    ]);
    const survivedError = eventError(survived.store, 'unkillable');
    expect(survivedError).not.toContain('timed out');
    expect(survivedError).toContain('still running');
    const survivorsAt = survived.order.indexOf('teardown_survivors');
    const survivorFailed = survived.order.indexOf('fail');
    expect(survivorsAt).toBeGreaterThanOrEqual(0);
    expect(survivorFailed).toBeGreaterThan(survivorsAt);
    const failCalls = (survived.store.failWorkflowRun as ReturnType<typeof mock>).mock.calls;
    expect(failCalls.length).toBeGreaterThan(0);
  }, 30000);

  it('Test 6: the live-cwd check skips itself, ancestors, and pid 1', () => {
    const ignored = makeFixture();
    const holder = holderPath(ignored.holder);
    writeRuns(ignored.dbPath, [terminalRow(holder, 'failed')]);
    const preamble = [
      'self=$$',
      'stat_line=$(cat "/proc/${self}/stat")',
      'rest=${stat_line##*)}',
      'ppid=$(printf "%s\\n" "$rest" | awk \'{print $2}\')',
      'mkdir -p "$RTW_PROC_ROOT/$self" "$RTW_PROC_ROOT/$ppid" "$RTW_PROC_ROOT/1"',
      'ln -sfn "$HOLDER_FOR_SCAN" "$RTW_PROC_ROOT/$self/cwd"',
      'ln -sfn "$HOLDER_FOR_SCAN" "$RTW_PROC_ROOT/$ppid/cwd"',
      'ln -sfn "$HOLDER_FOR_SCAN" "$RTW_PROC_ROOT/1/cwd"',
      'printf "bash\\n" > "$RTW_PROC_ROOT/$self/comm"',
      'printf "SECRET_CMDLINE_SHOULD_NOT_LEAK\\n" > "$RTW_PROC_ROOT/$self/cmdline"',
      'printf "SECRET_ENV_SHOULD_NOT_LEAK\\n" > "$RTW_PROC_ROOT/$self/environ"',
    ].join('\n');
    const ignoredResult = runCore(ignored, { HOLDER_FOR_SCAN: holder }, preamble);
    expect(ignoredResult.exitCode, show(ignoredResult)).toBe(0);
    expect(ignoredResult.stdout).toContain('repair_target_worktree_reclaimed:');
    expect(ignoredResult.stdout).not.toContain('live process cwd');
    expect(ignoredResult.stdout).not.toContain('SECRET_CMDLINE_SHOULD_NOT_LEAK');
    expect(ignoredResult.stderr).not.toContain('SECRET_ENV_SHOULD_NOT_LEAK');

    const named = makeFixture();
    const namedHolder = holderPath(named.holder);
    writeRuns(named.dbPath, [terminalRow(namedHolder, 'failed')]);
    const pidDir = plantCwd(named.procRoot, 4242, namedHolder, 'codex');
    writeFileSync(join(pidDir, 'cmdline'), 'SECRET_CMDLINE_SHOULD_NOT_LEAK\n');
    writeFileSync(join(pidDir, 'environ'), 'SECRET_ENV_SHOULD_NOT_LEAK\n');
    const namedResult = runCore(named, { RTW_HOLDER_WAIT_SECONDS: '1' });
    const combined = `${namedResult.stdout}\n${namedResult.stderr}`;
    expect(namedResult.exitCode, show(namedResult)).not.toBe(0);
    expect(combined).toContain('pid 4242 comm codex');
    expect(combined).not.toContain('SECRET_CMDLINE_SHOULD_NOT_LEAK');
    expect(combined).not.toContain('SECRET_ENV_SHOULD_NOT_LEAK');
    expect(worktrees(named.caller)).toContain(namedHolder);
  });

  it('Test 7: a failed repair checkout ends the run at once', async () => {
    const parsed = parseWorkflow(
      [
        'name: abort-probe',
        'description: abort probe',
        'nodes:',
        '  - id: checkout-repair-target',
        '    abort_run_on_failure: true',
        '    bash: echo hi',
      ].join('\n'),
      'abort-probe.yaml'
    );
    expect(parsed.error).toBeNull();
    expect(parsed.workflow?.nodes[0]?.abort_run_on_failure).toBe(true);

    const failedDir = mkdtempSync(join(tmpdir(), 'rht-abort-'));
    roots.push(failedDir);
    const failed = await runDag(failedDir, 'run-abort-checkout', [
      {
        id: 'sibling',
        bash: 'echo sibling\n',
      },
      {
        id: 'checkout-repair-target',
        abort_run_on_failure: true,
        bash: 'echo "repair_target_branch_held: feat/x is checked out" >&2\nexit 1\n',
      },
      { id: 'plan-review', depends_on: ['sibling'], bash: 'echo PLAN_RAN\n' },
      { id: 'implement', depends_on: ['plan-review'], bash: 'echo IMPL_RAN\n' },
      { id: 'validation', depends_on: ['implement'], bash: 'echo VAL_RAN\n' },
      { id: 'test', depends_on: ['validation'], bash: 'echo TEST_RAN\n' },
    ]);
    const calls = (failed.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type?: string; step_name?: string; data?: { node_output?: string } }]
    >;
    const completedIds = calls
      .filter(call => call[0]?.event_type === 'node_completed')
      .map(call => call[0]?.step_name);
    expect(completedIds).not.toContain('plan-review');
    expect(completedIds).not.toContain('implement');
    expect(completedIds).not.toContain('validation');
    expect(completedIds).not.toContain('test');
    const outputs = calls.map(call => call[0]?.data?.node_output ?? '').join('\n');
    expect(outputs).not.toContain('PLAN_RAN');
    expect(outputs).not.toContain('IMPL_RAN');
    const failCalls = (failed.store.failWorkflowRun as ReturnType<typeof mock>).mock.calls as Array<
      [string, string, { metadata?: { terminal_cause?: string; repair_failure_reason?: string } }]
    >;
    const metadata = failCalls[0]?.[2]?.metadata;
    expect(metadata?.terminal_cause).toBe('repair_checkout_failed');
    expect(metadata?.repair_failure_reason ?? '').toStartWith('repair_target_branch_held');

    const clearDir = mkdtempSync(join(tmpdir(), 'rht-clear-'));
    roots.push(clearDir);
    const clear = await runDag(clearDir, 'run-non-repair', [
      { id: 'sibling', bash: 'echo sibling\n' },
      {
        id: 'checkout-repair-target',
        abort_run_on_failure: true,
        bash: 'echo REPAIR_TARGET=none\n',
      },
      { id: 'plan-review', depends_on: ['sibling'], bash: 'echo PLAN_RAN\n' },
    ]);
    const clearCalls = (clear.store.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type?: string; data?: { node_output?: string } }]>;
    const clearOutputs = clearCalls.map(call => call[0]?.data?.node_output ?? '').join('\n');
    expect(clearOutputs).toContain('PLAN_RAN');
    expect(clearOutputs).toContain('REPAIR_TARGET=none');
    expect((clear.store.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);

    for (const lane of LANES) {
      const yaml = readFileSync(join(DEFAULTS, lane), 'utf8');
      expect(nodeHasAbort(yaml, 'checkout-repair-target'), lane).toBe(true);
      expect(nodeHasAbort(yaml, 'repair-gate-fail'), lane).toBe(true);
    }
  });

  it('Test 8: checkout_failed_no_climb is the conductor stop', () => {
    const source = readFileSync(join(REPO_ROOT, 'packages/smart-cauldron/src/cascade.ts'), 'utf8');
    expect(source).toContain('checkout_failed_no_climb');
    expect(source).toContain('repair_checkout_failed');
    expect(source).toContain('repair_gate_closed: checkout_failed');
    expect(source).toContain('repair_target_branch_held');
  });

  it('Test 9: a holder that never exits is refused after the bounded wait', () => {
    const fixture = makeFixture();
    const holder = holderPath(fixture.holder);
    writeFileSync(join(holder, 'keep.txt'), 'keep\n');
    plantCwd(fixture.procRoot, 6161, holder, 'sleeper');
    writeRuns(fixture.dbPath, [terminalRow(holder, 'cancelled')]);
    const started = Date.now();
    const result = runCore(fixture, { RTW_HOLDER_WAIT_SECONDS: '6' });
    const elapsed = Date.now() - started;
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.exitCode, show(result)).not.toBe(0);
    expect(elapsed, show(result)).toBeGreaterThanOrEqual(6000);
    expect(elapsed, show(result)).toBeLessThan(20000);
    expect(combined).toContain('after 6s wait');
    expect(combined).toContain('pid');
    expect(worktrees(fixture.caller)).toContain(holder);
    expect(readFileSync(join(holder, 'keep.txt'), 'utf8')).toBe('keep\n');
  }, 30000);

  it('Test 10: the rtw core stays byte-identical and the bundle matches', () => {
    const blocks = LANES.map(lane => extractRtwCore(readFileSync(join(DEFAULTS, lane), 'utf8')));
    for (const block of blocks) {
      expect(block).toBe(blocks[0]);
      expect(block).toContain('rtw_wait_for_holder_exit');
      expect(block).toContain('rtw_save_dirty_patch');
    }
    const checked = Bun.spawnSync(['bun', 'run', 'check:bundled'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(checked.exitCode, `${checked.stdout.toString()}\n${checked.stderr.toString()}`).toBe(0);
  }, 120000);

  it('Test 11: concurrent abort kills a child that left the worktree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rht-abort-tree-'));
    const outside = mkdtempSync(join(tmpdir(), 'rht-outside-'));
    roots.push(dir, outside);
    const sibling = [
      'set -u',
      `outside=${JSON.stringify(outside)}`,
      'bash -c \'cd "$1" && pwd > "$1/cwd.txt" && echo $$ > "$2/child.pid" && exec sleep 300\' _ "$outside" "$PWD" &',
      'i=0',
      'while [ "$i" -lt 50 ]; do',
      '  if [ -s child.pid ]; then break; fi',
      '  i=$((i + 1))',
      '  sleep 0.05',
      'done',
      'if [ ! -s child.pid ]; then echo "child pid missing" >&2; exit 1; fi',
      'echo ready > ready.flag',
      'exec sleep 300',
    ].join('\n');
    const abort = [
      'i=0',
      'while [ "$i" -lt 100 ]; do',
      '  if [ -s ready.flag ]; then break; fi',
      '  i=$((i + 1))',
      '  sleep 0.05',
      'done',
      'echo "repair_target_branch_held: feat/x is checked out" >&2',
      'exit 1',
    ].join('\n');
    const started = Date.now();
    const result = await runDag(dir, 'run-abort-tree', [
      { id: 'sibling', bash: sibling },
      {
        id: 'checkout-repair-target',
        abort_run_on_failure: true,
        bash: abort,
      },
    ]);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(20000);
    const childPid = Number(readFileSync(join(dir, 'child.pid'), 'utf8').trim());
    expect(childPid).toBeGreaterThan(1);
    expect(readFileSync(join(outside, 'cwd.txt'), 'utf8').trim()).toBe(outside);
    expect(pidIsLive(childPid)).toBe(false);
    expect(pidsIn(outside)).toEqual([]);
    expect(pidsIn(dir)).toEqual([]);
    expect(result.order).toContain('fail');
    const failCalls = (result.store.failWorkflowRun as ReturnType<typeof mock>).mock.calls as Array<
      [string, string, { metadata?: { terminal_cause?: string } }]
    >;
    expect(failCalls[0]?.[2]?.metadata?.terminal_cause).toBe('repair_checkout_failed');
  }, 30000);
});
