import { afterEach, describe, expect, it, mock } from 'bun:test';
import { spawn } from 'child_process';
import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setProcessGroupControlForTests } from '@archon/git';
import { registerBuiltinProviders } from '@archon/providers';
import { runCascade } from '../../smart-cauldron/src/cascade';
import type {
  CascadeDeps,
  PriorRunDetail,
  RunCascadeOptions,
} from '../../smart-cauldron/src/cascade';
import type { FireResult, GateVerdict, PollResult } from '../../smart-cauldron/src/types';
import type { DagNode, WorkflowRun } from './schemas';
import type { IWorkflowPlatform, WorkflowConfig, WorkflowDeps } from './deps';
import type { IWorkflowStore } from './store';
import { parseWorkflow } from './loader';
import { executeWorkflow } from './executor';
import {
  endRunProcessTree,
  executeDagWorkflow,
  recordOwnedProcessGroupForTests,
  recordTeardownBeforeStatus,
  resetRunTeardownStateForTests,
  setTeardownPlatformForTests,
  setTeardownProcRootForTests,
  teardownTerminalMetadata,
} from './dag-executor';

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

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function holderFileHashes(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue;
      const full = join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else if (info.isFile()) out.push(`${name}@${full.slice(root.length)}\t${sha256File(full)}`);
    }
  };
  walk(root);
  out.sort();
  return out;
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
  nodes: DagNode[],
  platform: IWorkflowPlatform = createPlatform()
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
    platform,
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

function processAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state =
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[0] ?? '';
    return state !== '' && state !== 'Z' && state !== 'X';
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}

function stopPid(pid: number): void {
  if (pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

function procScanAvailable(): boolean {
  try {
    readdirSync('/proc');
    return true;
  } catch {
    return false;
  }
}

function startForeignSleeper(cwd: string): number {
  const child = spawn('bash', ['-c', 'sleep 60'], {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  const pid = child.pid ?? 0;
  child.unref();
  return pid;
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

function hasSleepChild(parentPid: number): boolean {
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat = '';
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch {
      continue;
    }
    const after = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    if (Number(after[1]) !== parentPid) continue;
    try {
      if (readFileSync(`/proc/${entry}/comm`, 'utf8').trim() === 'sleep') return true;
    } catch {
      // The child exited between stat and comm.
    }
  }
  return false;
}

async function waitForSleepChild(parentPid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasSleepChild(parentPid)) return true;
    await Bun.sleep(50);
  }
  return false;
}

async function waitForCwdLink(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      readlinkSync(`/proc/${pid}/cwd`);
      return;
    } catch {
      await Bun.sleep(20);
    }
  }
  throw new Error(`cwd link for ${pid} did not appear`);
}

function virtualClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function makePollResult(overrides?: Partial<PollResult>): PollResult {
  return {
    runId: 'run-stub',
    terminalStatus: 'completed',
    validatorVerdict: 'satisfied',
    prUrl: null,
    prMergeable: null,
    servedModelId: null,
    rawMetadata: {},
    ...overrides,
  };
}

function makeFireOk(runId: string): FireResult {
  return { ok: true, runId, conversationId: 'conv-stub', infraError: null };
}

function makePassVerdict(): GateVerdict {
  return {
    pass: true,
    reason: 'all gate conditions passed',
    cancelled: false,
    validatorVerdict: 'satisfied',
    prOpened: true,
    prMergeable: true,
    terminalStatus: 'completed',
  };
}

function makeFailVerdict(reason: string): GateVerdict {
  return {
    pass: false,
    reason,
    cancelled: false,
    validatorVerdict: 'needs_revision',
    prOpened: false,
    prMergeable: null,
    terminalStatus: 'failed',
  };
}

function cascadeOpts(deps: CascadeDeps): RunCascadeOptions {
  const outDir = mkdtempSync(join(tmpdir(), 'rht-cascade-'));
  roots.push(outDir);
  return {
    woId: 'WO-RHT-001',
    woClass: 'CODE',
    tags: ['mechanical'],
    entryOverride: 'cursor',
    outDir,
    token: 'test-token',
    project: 'test-project',
    deps: {
      findWoClaim: async () => null,
      acquireWoLock: async (woId, project, cascadeId) => ({
        acquired: true,
        path: 'in-memory-test-lock',
        record: {
          woId,
          project,
          cascadeId,
          status: 'running',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      }),
      releaseWoLock: async () => {},
      writeRecord: async () => 'record.json',
      fetchNodeTimeouts: async () => ({}),
      sleep: async () => {},
      now: () => Date.now(),
      ...deps,
    },
  };
}

async function withTeardownWait<T>(waitMs: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.SMART_CAULDRON_TEARDOWN_WAIT_MS;
  process.env.SMART_CAULDRON_TEARDOWN_WAIT_MS = waitMs;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.SMART_CAULDRON_TEARDOWN_WAIT_MS;
    else process.env.SMART_CAULDRON_TEARDOWN_WAIT_MS = previous;
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
    const proc = Bun.spawn(['bash', scriptPath, 'feat/x'], {
      cwd: fixture.caller,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const bashPid = proc.pid ?? 0;
      const waiting = await waitForSleepChild(bashPid, 15000);
      expect(waiting).toBe(true);
      expect(worktrees(fixture.caller)).toContain(holder);
      rmSync(pidDir, { recursive: true, force: true });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
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

  it('Test 3: a dirty terminal holder releases the branch, not its files', () => {
    const saved = makeFixture();
    const holder = holderPath(saved.holder);
    const tip = git(['rev-parse', 'HEAD'], holder).trim();
    writeFileSync(join(holder, 'README.md'), 'changed\n');
    writeFileSync(join(holder, 'notes.txt'), 'untracked\n');
    const before = holderFileHashes(holder);
    const indexPath = git(
      ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
      holder
    ).trim();
    const indexBefore = sha256File(indexPath);
    writeRuns(saved.dbPath, [terminalRow(holder)]);
    const artifacts = join(saved.root, 'artifacts');
    mkdirSync(artifacts);
    const result = runCore(saved, { ARTIFACTS_DIR: artifacts });
    expect(result.exitCode, show(result)).toBe(0);
    expect(result.stdout).toContain(`repair_target_holder_released: ${holder} detached at ${tip}`);
    expect(git(['rev-parse', 'HEAD'], holder).trim()).toBe(tip);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], holder).trim()).toBe('HEAD');
    expect(holderFileHashes(holder)).toEqual(before);
    expect(sha256File(indexPath)).toBe(indexBefore);
    expect(readFileSync(join(holder, 'README.md'), 'utf8')).toBe('changed\n');
    expect(readFileSync(join(holder, 'notes.txt'), 'utf8')).toBe('untracked\n');
    expect(worktrees(saved.caller)).toContain(holder);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], saved.caller).trim()).toBe('feat/x');
    const savedDir = join(artifacts, 'reclaimed-holder', 'abcd1234');
    expect(existsSync(join(savedDir, 'released.json'))).toBe(true);
    expect(
      readdirSync(savedDir).some(name => name.endsWith('.patch') || name.endsWith('.tar'))
    ).toBe(false);
    expect(result.stdout).not.toContain('holder_patch_saved:');

    const refused = makeFixture();
    const dirtyHolder = holderPath(refused.holder);
    writeFileSync(join(dirtyHolder, 'README.md'), 'changed\n');
    writeFileSync(join(dirtyHolder, 'notes.txt'), 'untracked\n');
    writeRuns(refused.dbPath, [terminalRow(dirtyHolder)]);
    const refusedResult = runCore(refused, {});
    expect(refusedResult.exitCode, show(refusedResult)).not.toBe(0);
    expect(`${refusedResult.stdout}\n${refusedResult.stderr}`).toContain('worktree is dirty');
    expect(worktrees(refused.caller)).toContain(dirtyHolder);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], dirtyHolder).trim()).toBe('feat/x');
  });

  it('dirty_holder_released_lossless: a dirty holder is released without touching a byte', () => {
    const saved = makeFixture();
    const holder = holderPath(saved.holder);
    writeFileSync(join(holder, 'a.txt'), 'tracked\n');
    git(['add', 'a.txt'], holder);
    git(['commit', '-m', 'track a'], holder);
    git(['push', 'origin', 'HEAD:feat/x'], holder);
    const tip = git(['rev-parse', 'HEAD'], holder).trim();
    writeFileSync(join(holder, 'a.txt'), 'staged-only\n');
    git(['add', 'a.txt'], holder);
    writeFileSync(join(holder, 'a.txt'), 'tracked\n');
    writeFileSync(join(holder, 'notes.txt'), 'plain\n');
    writeFileSync(join(holder, ' notes.txt'), 'leading space\n');
    writeFileSync(join(holder, '--version'), 'option-like\n');
    const before = holderFileHashes(holder);
    const indexPath = git(
      ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
      holder
    ).trim();
    const indexBefore = sha256File(indexPath);
    writeRuns(saved.dbPath, [terminalRow(holder)]);
    const artifacts = join(saved.root, 'artifacts');
    mkdirSync(artifacts);
    const result = runCore(saved, { ARTIFACTS_DIR: artifacts });
    expect(result.exitCode, show(result)).toBe(0);
    expect(result.stdout).toContain(`repair_target_holder_released: ${holder} detached at ${tip}`);
    expect(holderFileHashes(holder)).toEqual(before);
    expect(sha256File(indexPath)).toBe(indexBefore);
    expect(readFileSync(join(holder, 'a.txt'))).toEqual(Buffer.from('tracked\n'));
    expect(readFileSync(join(holder, 'notes.txt'), 'utf8')).toBe('plain\n');
    expect(readFileSync(join(holder, ' notes.txt'), 'utf8')).toBe('leading space\n');
    expect(readFileSync(join(holder, '--version'), 'utf8')).toBe('option-like\n');
    expect(git(['diff', '--cached', '--', 'a.txt'], holder)).toContain('staged-only');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], holder).trim()).toBe('HEAD');
    expect(git(['rev-parse', 'HEAD'], holder).trim()).toBe(tip);
    const released = JSON.parse(
      readFileSync(join(artifacts, 'reclaimed-holder', 'abcd1234', 'released.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(Object.keys(released).sort()).toEqual([
      'branch',
      'holder',
      'porcelain_line_count',
      'tip_sha',
    ]);
    expect(released.holder).toBe(holder);
    expect(released.branch).toBe('feat/x');
    expect(released.tip_sha).toBe(tip);
    expect(released.porcelain_line_count).toBeGreaterThan(0);
    expect(worktrees(saved.caller)).toContain(holder);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], saved.caller).trim()).toBe('feat/x');
    expect(result.stdout).not.toContain('holder_patch_saved:');

    const conflicted = makeFixture();
    const conflictHolder = holderPath(conflicted.holder);
    const conflictTip = git(['rev-parse', 'HEAD'], conflictHolder).trim();
    const stages = [
      { stage: 1, body: 'BASE stage content\n' },
      { stage: 2, body: 'OURS stage content\n' },
      { stage: 3, body: 'THEIRS stage content\n' },
    ];
    const shas = stages.map(stage => {
      const hashed = Bun.spawnSync(['git', 'hash-object', '-w', '--stdin'], {
        cwd: conflictHolder,
        stdin: Buffer.from(stage.body),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (hashed.exitCode !== 0) throw new Error(hashed.stderr.toString());
      return hashed.stdout.toString().trim();
    });
    const indexInfo = stages
      .map((stage, index) => `100644 ${shas[index] ?? ''} ${String(stage.stage)}\tconflict.txt\n`)
      .join('');
    const updated = Bun.spawnSync(['git', 'update-index', '--index-info'], {
      cwd: conflictHolder,
      stdin: Buffer.from(indexInfo),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (updated.exitCode !== 0) throw new Error(updated.stderr.toString());
    writeFileSync(
      join(conflictHolder, 'conflict.txt'),
      '<<<<<<< ours\nOURS stage content\n=======\nTHEIRS stage content\n>>>>>>> theirs\n'
    );
    const mergeHead = git(
      ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'],
      conflictHolder
    ).trim();
    writeFileSync(mergeHead, `${conflictTip}\n`);
    const conflictBefore = holderFileHashes(conflictHolder);
    const conflictIndex = git(
      ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
      conflictHolder
    ).trim();
    const conflictIndexBefore = sha256File(conflictIndex);
    writeRuns(conflicted.dbPath, [terminalRow(conflictHolder)]);
    const conflictArtifacts = join(conflicted.root, 'artifacts');
    mkdirSync(conflictArtifacts);
    const conflictResult = runCore(conflicted, { ARTIFACTS_DIR: conflictArtifacts });
    expect(conflictResult.exitCode, show(conflictResult)).toBe(0);
    expect(holderFileHashes(conflictHolder)).toEqual(conflictBefore);
    expect(sha256File(conflictIndex)).toBe(conflictIndexBefore);
    expect(readFileSync(mergeHead, 'utf8').trim()).toBe(conflictTip);
    expect(git(['ls-files', '-u'], conflictHolder)).toContain('conflict.txt');
    expect(git(['rev-parse', 'HEAD'], conflictHolder).trim()).toBe(conflictTip);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], conflictHolder).trim()).toBe('HEAD');
    expect(worktrees(conflicted.caller)).toContain(conflictHolder);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], conflicted.caller).trim()).toBe('feat/x');
    expect(
      existsSync(join(conflictArtifacts, 'reclaimed-holder', 'abcd1234', 'released.json'))
    ).toBe(true);
    expect(conflictResult.stdout).not.toContain('holder_patch_saved:');

    const refused = makeFixture();
    const dirtyHolder = holderPath(refused.holder);
    writeFileSync(join(dirtyHolder, 'notes.txt'), 'x\n');
    writeFileSync(join(dirtyHolder, ' notes.txt'), 'y\n');
    writeFileSync(join(dirtyHolder, '--version'), 'z\n');
    writeRuns(refused.dbPath, [terminalRow(dirtyHolder)]);
    const refusedResult = runCore(refused, {});
    expect(refusedResult.exitCode, show(refusedResult)).not.toBe(0);
    expect(`${refusedResult.stdout}\n${refusedResult.stderr}`).toContain('worktree is dirty');
    expect(worktrees(refused.caller)).toContain(dirtyHolder);
  }, 30000);

  it('Test 4: the conductor polls prior teardown before the next fire', async () => {
    const emptyDetail: PriorRunDetail = {
      completedAt: '2026-10-27T00:00:00.000Z',
      metadata: {},
      error: null,
    };

    await withTeardownWait('20000', async () => {
      const clock = virtualClock();
      let reads = 0;
      const fireAtRead: number[] = [];
      const record = await runCascade(
        cascadeOpts({
          readRunDetail: async () => {
            reads += 1;
            if (reads >= 3) {
              return {
                completedAt: '2026-10-27T00:00:00.000Z',
                metadata: { teardown_confirmed_at: '2026-10-27T00:00:01.000Z' },
                error: null,
              };
            }
            return emptyDetail;
          },
          sleep: clock.sleep,
          now: clock.now,
          fire: async () => {
            fireAtRead.push(reads);
            return makeFireOk(`run-${fireAtRead.length}`);
          },
          poll: async () => makePollResult(),
          judge: () =>
            fireAtRead.length === 1 ? makeFailVerdict('needs revision') : makePassVerdict(),
          escalate: async () => undefined,
        })
      );
      expect(fireAtRead).toEqual([0, 3]);
      expect(record.status).toBe('won');
      expect(record.attempts).toHaveLength(2);
    });

    await withTeardownWait('20000', async () => {
      const clock = virtualClock();
      let fires = 0;
      const reasons: string[] = [];
      const record = await runCascade(
        cascadeOpts({
          readRunDetail: async () => emptyDetail,
          sleep: clock.sleep,
          now: clock.now,
          fire: async () => {
            fires += 1;
            return makeFireOk(`run-${fires}`);
          },
          poll: async () => makePollResult({ terminalStatus: 'failed' }),
          judge: () => makeFailVerdict('needs revision'),
          escalate: async ctx => {
            reasons.push(ctx.reason);
          },
        })
      );
      expect(fires).toBe(1);
      expect(record.status).toBe('blocked');
      expect(record.attempts[1]?.gateFailReason).toBe('teardown_unconfirmed');
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain('teardown_unconfirmed');
    });

    await withTeardownWait('20000', async () => {
      const clock = virtualClock();
      let fires = 0;
      const reasons: string[] = [];
      const record = await runCascade(
        cascadeOpts({
          readRunDetail: async () => ({
            completedAt: '2026-10-27T00:00:00.000Z',
            metadata: { teardown_survivors: [{ pid: 9, comm: 'sleep' }] },
            error: null,
          }),
          sleep: clock.sleep,
          now: clock.now,
          fire: async () => {
            fires += 1;
            return makeFireOk(`run-${fires}`);
          },
          poll: async () => makePollResult({ terminalStatus: 'failed' }),
          judge: () => makeFailVerdict('needs revision'),
          escalate: async ctx => {
            reasons.push(ctx.reason);
          },
        })
      );
      expect(fires).toBe(1);
      expect(record.status).toBe('blocked');
      expect(record.attempts[1]?.gateFailReason).toBe('teardown_unconfirmed');
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain('teardown_unconfirmed');
    });
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

  it('Test 8: a two-tier cascade fires once when repair checkout fails', async () => {
    let fires = 0;
    const fired: string[] = [];
    const reasons: string[] = [];
    const record = await runCascade(
      cascadeOpts({
        readRunDetail: async () => ({
          completedAt: '2026-10-27T00:00:00.000Z',
          metadata: { teardown_confirmed_at: '2026-10-27T00:00:01.000Z' },
          error: null,
        }),
        fire: async opts => {
          fires += 1;
          fired.push(opts.workflowName);
          return makeFireOk('run-repair');
        },
        poll: async () =>
          makePollResult({
            terminalStatus: 'failed',
            rawMetadata: {
              terminal_cause: 'repair_checkout_failed',
              error: 'repair_target_branch_held: feat/x is checked out',
            },
          }),
        judge: () => makeFailVerdict('validator needs revision'),
        escalate: async ctx => {
          reasons.push(ctx.reason);
        },
      })
    );
    expect(fires).toBe(1);
    expect(fired).toEqual(['bdc-feature-development-cursor']);
    expect(record.status).toBe('blocked');
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]?.gateFailReason).toBe('checkout_failed_no_climb');
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('checkout_failed_no_climb');
    expect(reasons[0]).toContain('run-repair');
    expect(reasons[0]).toContain('repair_target_branch_held');
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
      expect(block).toContain('rtw_release_dirty_holder');
      expect(block).not.toContain('rtw_save_dirty_patch');
    }
    const checked = Bun.spawnSync(['bun', 'run', 'check:bundled'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(checked.exitCode, `${checked.stdout.toString()}\n${checked.stderr.toString()}`).toBe(0);
  }, 120000);

  it('does not signal an unrelated cwd holder when the run owns no process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rht-foreign-only-'));
    roots.push(dir);
    const foreignPid = startForeignSleeper(dir);
    try {
      expect(foreignPid).toBeGreaterThan(1);
      expect(processAlive(foreignPid)).toBe(true);
      const report = await endRunProcessTree('run-no-owned-foreign', dir);
      expect(processAlive(foreignPid)).toBe(true);
      if (procScanAvailable()) {
        expect(report.confirmedAt).toBeNull();
        expect(report.survivors.some(item => item.pid === foreignPid)).toBe(true);
      }
    } finally {
      stopPid(foreignPid);
    }
  });

  it('terminates a verified owned child and leaves a foreign holder alive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rht-owned-foreign-'));
    roots.push(dir);
    const foreignPid = startForeignSleeper(dir);
    try {
      expect(foreignPid).toBeGreaterThan(1);
      const result = await runDag(dir, 'run-owned-and-foreign', [
        {
          id: 'bg',
          bash: 'sleep 300 >/dev/null 2>&1 &\necho $! > owned.pid\necho done\n',
        },
      ]);
      const ownedPid = Number(readFileSync(join(dir, 'owned.pid'), 'utf8').trim());
      expect(ownedPid).toBeGreaterThan(1);
      expect(processAlive(ownedPid)).toBe(false);
      expect(processAlive(foreignPid)).toBe(true);
      if (procScanAvailable()) {
        expect(result.order).toContain('teardown_survivors');
        expect(result.order).not.toContain('teardown_confirmed_at');
        const updates = (result.store.updateWorkflowRun as ReturnType<typeof mock>).mock
          .calls as Array<[string, { metadata?: { teardown_survivors?: Array<{ pid: number }> } }]>;
        const survivors = updates.flatMap(call => call[1]?.metadata?.teardown_survivors ?? []);
        expect(survivors.some(item => item.pid === foreignPid)).toBe(true);
        expect(survivors.some(item => item.pid === ownedPid)).toBe(false);
      }
    } finally {
      stopPid(foreignPid);
    }
  });

  it('a failed repair checkout stops a same-layer sibling before the layer finishes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rht-abort-sibling-'));
    roots.push(dir);
    const started = Date.now();
    const failed = await runDag(dir, 'run-abort-sibling', [
      {
        id: 'sibling',
        bash: 'echo $$ > sibling.pid\nsleep 30\necho SIBLING_DONE\n',
      },
      {
        id: 'checkout-repair-target',
        abort_run_on_failure: true,
        bash: [
          'for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40; do',
          '  if [ -f sibling.pid ]; then break; fi',
          '  sleep 0.05',
          'done',
          'echo "repair_target_branch_held: feat/x is checked out" >&2',
          'exit 1',
        ].join('\n'),
      },
      { id: 'plan-review', depends_on: ['checkout-repair-target'], bash: 'echo PLAN_RAN\n' },
      { id: 'implement', depends_on: ['plan-review'], bash: 'echo IMPL_RAN\n' },
      { id: 'validation', depends_on: ['implement'], bash: 'echo VAL_RAN\n' },
      { id: 'test', depends_on: ['validation'], bash: 'echo TEST_RAN\n' },
    ]);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10000);
    const siblingPid = Number(readFileSync(join(dir, 'sibling.pid'), 'utf8').trim());
    expect(siblingPid).toBeGreaterThan(1);
    expect(processAlive(siblingPid)).toBe(false);
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
    expect(outputs).not.toContain('SIBLING_DONE');
    expect(outputs).not.toContain('PLAN_RAN');
    const failCalls = (failed.store.failWorkflowRun as ReturnType<typeof mock>).mock.calls as Array<
      [string, string, { metadata?: { terminal_cause?: string; repair_failure_reason?: string } }]
    >;
    const metadata = failCalls[0]?.[2]?.metadata;
    expect(metadata?.terminal_cause).toBe('repair_checkout_failed');
    expect(metadata?.repair_failure_reason ?? '').toStartWith('repair_target_branch_held');
  }, 15000);

  it('a pre-execution abort_run_on_failure stops a same-layer sibling before the layer finishes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rht-abort-pre-exec-'));
    roots.push(dir);
    const pidPath = join(dir, 'sibling.pid');
    const platform = createPlatform();
    (platform.sendMessage as ReturnType<typeof mock>).mockImplementation(
      async (_conversationId: string, message: string) => {
        // Hold the pre-execution failure until the sibling group is registered,
        // so settlement has a live owned process to stop.
        if (message.includes('failed before execution')) {
          const deadline = Date.now() + 5000;
          while (!existsSync(pidPath) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
      }
    );
    const started = Date.now();
    const failed = await runDag(
      dir,
      'run-abort-pre-exec',
      [
        {
          id: 'sibling',
          bash: 'echo $$ > sibling.pid\nsleep 30\necho SIBLING_DONE\n',
        },
        {
          id: 'checkout-repair-target',
          abort_run_on_failure: true,
          prompt: 'fail before execution',
          provider: 'not-a-registered-provider',
        },
        { id: 'plan-review', depends_on: ['checkout-repair-target'], bash: 'echo PLAN_RAN\n' },
        { id: 'implement', depends_on: ['plan-review'], bash: 'echo IMPL_RAN\n' },
        { id: 'validation', depends_on: ['implement'], bash: 'echo VAL_RAN\n' },
        { id: 'test', depends_on: ['validation'], bash: 'echo TEST_RAN\n' },
      ],
      platform
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10000);
    expect(eventError(failed.store, 'checkout-repair-target')).toContain('failed before execution');
    expect(existsSync(pidPath)).toBe(true);
    const siblingPid = Number(readFileSync(pidPath, 'utf8').trim());
    expect(siblingPid).toBeGreaterThan(1);
    expect(processAlive(siblingPid)).toBe(false);
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
    expect(outputs).not.toContain('SIBLING_DONE');
    expect(outputs).not.toContain('PLAN_RAN');
    const failCalls = (failed.store.failWorkflowRun as ReturnType<typeof mock>).mock.calls as Array<
      [string, string, { metadata?: { terminal_cause?: string } }]
    >;
    expect(failCalls[0]?.[2]?.metadata?.terminal_cause).toBe('repair_checkout_failed');
  }, 15000);

  it('rescans cwd before reusing a cached confirmation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rht-cache-race-'));
    roots.push(dir);
    const runId = 'run-cache-race';
    const first = await endRunProcessTree(runId, dir);
    expect(first.confirmedAt).not.toBeNull();
    expect(first.survivors).toEqual([]);
    if (!procScanAvailable()) return;
    const foreignPid = startForeignSleeper(dir);
    try {
      expect(foreignPid).toBeGreaterThan(1);
      await waitForCwdLink(foreignPid);
      const updates: Array<{ metadata?: Record<string, unknown> }> = [];
      await recordTeardownBeforeStatus(
        {
          updateWorkflowRun: async (_id, patch) => {
            updates.push(patch);
          },
        },
        { id: runId, working_path: dir }
      );
      expect(processAlive(foreignPid)).toBe(true);
      const metadata = updates[0]?.metadata ?? {};
      expect(Object.prototype.hasOwnProperty.call(metadata, 'teardown_confirmed_at')).toBe(false);
      const survivors = metadata.teardown_survivors;
      expect(Array.isArray(survivors)).toBe(true);
      expect((survivors as Array<{ pid: number }>).some(item => item.pid === foreignPid)).toBe(
        true
      );
    } finally {
      stopPid(foreignPid);
    }
  });

  it('does not confirm when a group registers during the last scan', async () => {
    const metadata = teardownTerminalMetadata({ confirmedAt: null, survivors: [] });
    expect(metadata).toEqual({ teardown_survivors: [] });
    expect(Object.prototype.hasOwnProperty.call(metadata, 'teardown_confirmed_at')).toBe(false);

    registerBuiltinProviders();
    const fixture = makeFixture();
    const runId = 'run-epoch-race';
    const epochProc = join(fixture.root, 'epoch-proc');
    mkdirSync(join(epochProc, '424242'), { recursive: true });
    writeFileSync(
      join(epochProc, '424242', 'stat'),
      '424242 (sleep) S 1 424242 424242 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100\n'
    );
    setTeardownProcRootForTests(epochProc);
    recordOwnedProcessGroupForTests(runId, 424242);
    setProcessGroupControlForTests({
      signal() {
        recordOwnedProcessGroupForTests(runId, 424242);
        return true;
      },
      groupExists() {
        return false;
      },
    });
    const store = createMockStore();
    const updates: Array<{ metadata?: Record<string, unknown> }> = [];
    (store.updateWorkflowRun as ReturnType<typeof mock>).mockImplementation(
      async (_id: string, patch: { metadata?: Record<string, unknown> }) => {
        if (patch.metadata) updates.push(patch);
      }
    );
    const deps = {
      store,
      getAgentProvider: mock(() => {
        throw new Error('provider must not be called');
      }),
      loadConfig: mock(async () => minimalConfig),
    } as unknown as WorkflowDeps;
    const result = await executeWorkflow(
      deps,
      createPlatform(),
      'conv-teardown',
      fixture.caller,
      {
        name: 'teardown-executor',
        description: 'teardown executor',
        nodes: [],
        provider: 'claude',
        mutates_checkout: false,
        target_repo: 'not/this-repo',
      },
      'teardown',
      'conv-db',
      undefined,
      undefined,
      undefined,
      undefined,
      makeRun(runId, fixture.caller)
    );
    expect(result.success).toBe(false);
    const teardownUpdates = updates.filter(
      patch =>
        patch.metadata !== undefined &&
        (Object.prototype.hasOwnProperty.call(patch.metadata, 'teardown_confirmed_at') ||
          Object.prototype.hasOwnProperty.call(patch.metadata, 'teardown_survivors'))
    );
    expect(teardownUpdates.length).toBeGreaterThan(0);
    for (const patch of teardownUpdates) {
      expect(Object.prototype.hasOwnProperty.call(patch.metadata, 'teardown_confirmed_at')).toBe(
        false
      );
      expect(patch.metadata?.teardown_survivors).toEqual([]);
    }
  });

  it('exited_root_descendant_killed: a timeout ends a descendant the root already exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rht-exited-root-'));
    roots.push(dir);
    const timed = await runDag(dir, 'run-exited-root', [
      {
        id: 'hang',
        bash: 'sleep 300 &\necho $! > child.pid\nexit 0\n',
        timeout: 2000,
      },
    ]);
    const childPid = Number(readFileSync(join(dir, 'child.pid'), 'utf8').trim());
    expect(childPid).toBeGreaterThan(1);
    expect(processAlive(childPid)).toBe(false);
    expect(eventError(timed.store, 'hang')).toContain('timed out after 2000ms');
    expect(timed.order).toContain('teardown_confirmed_at');
    expect(timed.order).not.toContain('teardown_survivors');
  }, 20000);

  it('retire_only_when_empty: a group that will not empty keeps its record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rht-retire-'));
    roots.push(dir);
    const procRoot = join(dir, 'proc');
    const pidDir = join(procRoot, '4242');
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(
      join(pidDir, 'stat'),
      '4242 (sleep) S 1 4242 4242 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100\n'
    );
    writeFileSync(join(pidDir, 'comm'), 'sleep\n');
    setTeardownProcRootForTests(procRoot);
    recordOwnedProcessGroupForTests('run-retire', 4242);
    setProcessGroupControlForTests({
      signal() {
        return true;
      },
      groupExists() {
        return true;
      },
    });
    const report = await endRunProcessTree('run-retire', dir);
    expect(report.confirmedAt).toBeNull();
    expect(report.survivors).toEqual([{ pid: 4242, comm: 'sleep' }]);
    const again = await endRunProcessTree('run-retire', dir);
    expect(again.confirmedAt).toBeNull();
    expect(again.survivors).toEqual([{ pid: 4242, comm: 'sleep' }]);
  }, 20000);

  it('unverifiable_platform_fails_closed: win32 and unreadable proc do not confirm', async () => {
    const assertUnverifiable = async (label: string): Promise<void> => {
      const dir = mkdtempSync(join(tmpdir(), `rht-unver-${label}-`));
      roots.push(dir);
      const childPath = join(dir, 'child.pid');
      const timed = await runDag(dir, `run-unver-${label}`, [
        {
          id: 'hang',
          bash: 'sleep 30 &\necho $! > child.pid\nwait\n',
          timeout: 400,
        },
      ]);
      const error = eventError(timed.store, 'hang');
      expect(error, label).toContain('still running');
      expect(error, label).not.toContain('timed out');
      expect(timed.order, label).toContain('teardown_survivors');
      expect(timed.order, label).not.toContain('teardown_confirmed_at');
      const updates = (timed.store.updateWorkflowRun as ReturnType<typeof mock>).mock
        .calls as Array<
        [string, { metadata?: { teardown_survivors?: Array<{ reason?: string }> } }]
      >;
      const survivors = updates.flatMap(call => call[1]?.metadata?.teardown_survivors ?? []);
      expect(survivors, label).toEqual([{ reason: 'teardown_unverifiable' }]);
      if (existsSync(childPath)) stopPid(Number(readFileSync(childPath, 'utf8').trim()));
    };

    setTeardownPlatformForTests('win32');
    try {
      await assertUnverifiable('win32');
    } finally {
      resetRunTeardownStateForTests();
    }

    const missingProc = mkdtempSync(join(tmpdir(), 'rht-noproc-'));
    roots.push(missingProc);
    setTeardownProcRootForTests(join(missingProc, 'missing'));
    try {
      await assertUnverifiable('noproc');
    } finally {
      resetRunTeardownStateForTests();
    }

    await withTeardownWait('20000', async () => {
      const clock = virtualClock();
      let fires = 0;
      const reasons: string[] = [];
      const record = await runCascade(
        cascadeOpts({
          readRunDetail: async () => ({
            completedAt: '2026-10-27T00:00:00.000Z',
            metadata: { teardown_survivors: [{ reason: 'teardown_unverifiable' }] },
            error: null,
          }),
          sleep: clock.sleep,
          now: clock.now,
          fire: async () => {
            fires += 1;
            return makeFireOk(`run-${String(fires)}`);
          },
          poll: async () => makePollResult({ terminalStatus: 'failed' }),
          judge: () => makeFailVerdict('needs revision'),
          escalate: async ctx => {
            reasons.push(ctx.reason);
          },
        })
      );
      expect(fires).toBe(1);
      expect(record.status).toBe('blocked');
      expect(record.attempts[1]?.gateFailReason).toBe('teardown_unconfirmed');
      expect(reasons).toHaveLength(1);
    });
  }, 20000);

  it('setsid_escapee_is_blocker: a setsid child is never signaled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rht-setsid-'));
    roots.push(dir);
    let escapee = 0;
    try {
      const finished = await runDag(dir, 'run-setsid', [
        {
          id: 'escape',
          bash: "bash -c 'setsid sleep 300 >/dev/null 2>&1 & echo $!' > escapee.pid\necho done\n",
        },
      ]);
      escapee = Number(readFileSync(join(dir, 'escapee.pid'), 'utf8').trim());
      expect(escapee).toBeGreaterThan(1);
      expect(processAlive(escapee)).toBe(true);
      expect(finished.order).not.toContain('teardown_confirmed_at');
      expect(finished.order).toContain('teardown_survivors');
      const updates = (finished.store.updateWorkflowRun as ReturnType<typeof mock>).mock
        .calls as Array<
        [string, { metadata?: { teardown_survivors?: Array<{ pid?: number; reason?: string }> } }]
      >;
      const survivors = updates.flatMap(call => call[1]?.metadata?.teardown_survivors ?? []);
      expect(
        survivors.some(item => item.pid === escapee && item.reason === 'unowned_cwd_holder')
      ).toBe(true);
    } finally {
      stopPid(escapee);
    }
  }, 20000);
});
