/**
 * WO-HARNESS-REPAIR-HOLDER-TEARDOWN-01: run teardown, node-timeout teardown,
 * lease release, terminal-lease reconciler, repair not_before and the
 * abort-on-failed-checkout DAG path.
 *
 * Tests marked LINUX use real child processes and the real /proc; they run on
 * ubuntu CI (the platform where teardown is provable) and are skipped elsewhere.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'fs';
import { readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileAsync } from '@archon/git';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import {
  NODE_TOKEN_ENV,
  RELEASE_TERMINAL_RUN_LEASE_SQL,
  TERMINAL_RUN_LEASES_SQL,
  endNodeProcessTree,
  endRunProcessTree,
  finalizeRunTeardown,
  isTeardownConfirmed,
  releaseTerminalRunLeases,
  type KillFn,
  type ProcReader,
  type ProcStat,
  type TerminalRunLeaseRecord,
} from './run-teardown';
import { withRunLease } from './run-lease';
import { computeRepairNotBefore } from './executor';
import { executeDagWorkflow } from './dag-executor';
import { parseWorkflow } from './loader';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const IS_LINUX = process.platform === 'linux' && existsSync('/proc/self/stat');
const linuxIt = IS_LINUX ? it : it.skip;

// ---------------------------------------------------------------------------
// Fake /proc reader (startTicks are milliseconds: boot 0, 1000 ticks/s)
// ---------------------------------------------------------------------------

interface FakeProc {
  pid: number;
  cwd: string;
  startTicks: number;
  uid?: number;
  ppid?: number;
  comm?: string;
  environ?: string;
  cwdError?: string;
  /** Start ticks returned on the 2nd+ stat read (pid reuse). */
  restartTicks?: number;
  ignoreTerm?: boolean;
  ignoreKill?: boolean;
}

const SELF_PID = 99_999;
const SELF_UID = 1000;

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function fakeReader(procs: FakeProc[]): {
  reader: ProcReader;
  kill: KillFn & { calls: [number, string][] };
} {
  const alive = new Map<number, FakeProc>(procs.map(p => [p.pid, p]));
  const statReads = new Map<number, number>();
  const reader: ProcReader = {
    listPids: () => [SELF_PID, ...alive.keys()],
    readCwd: pid => {
      const p = alive.get(pid);
      if (!p) throw errno('ENOENT');
      if (p.cwdError) throw errno(p.cwdError);
      return p.cwd;
    },
    readStat: (pid): ProcStat => {
      if (pid === SELF_PID) return { state: 'S', ppid: 1, startTicks: 1, comm: 'bun' };
      const p = alive.get(pid);
      if (!p) throw errno('ENOENT');
      const n = (statReads.get(pid) ?? 0) + 1;
      statReads.set(pid, n);
      const ticks = n > 1 && p.restartTicks !== undefined ? p.restartTicks : p.startTicks;
      return { state: 'S', ppid: p.ppid ?? 1, startTicks: ticks, comm: p.comm ?? 'sleep' };
    },
    readUid: pid => {
      if (pid === SELF_PID) return SELF_UID;
      const p = alive.get(pid);
      if (!p) throw errno('ENOENT');
      return p.uid ?? SELF_UID;
    },
    bootTimeMs: () => 0,
    clockTicksPerSecond: () => 1000,
    selfUid: () => SELF_UID,
    selfPid: () => SELF_PID,
    readEnviron: pid => {
      const p = alive.get(pid);
      if (!p) throw errno('ENOENT');
      return p.environ ?? '';
    },
  };
  const calls: [number, string][] = [];
  const kill = ((pid: number, signal: 'SIGTERM' | 'SIGKILL') => {
    calls.push([pid, signal]);
    const p = alive.get(pid);
    if (!p) throw errno('ESRCH');
    if (signal === 'SIGTERM' && !p.ignoreTerm) alive.delete(pid);
    if (signal === 'SIGKILL' && !p.ignoreKill) alive.delete(pid);
  }) as KillFn & { calls: [number, string][] };
  kill.calls = calls;
  return { reader, kill };
}

const instant = async (): Promise<void> => undefined;
const fakeOpts = (r: ReturnType<typeof fakeReader>) => ({
  platform: 'linux' as const,
  reader: r.reader,
  kill: r.kill,
  sleep: instant,
});

// ---------------------------------------------------------------------------
// In-memory store for lease / metadata assertions
// ---------------------------------------------------------------------------

interface MemRun {
  id: string;
  status: string;
  metadata: Record<string, unknown>;
  working_path: string | null;
  started_at: Date;
}

function memStore(runs: MemRun[]): {
  store: IWorkflowStore;
  releases: { runId: string; leaseToken: string }[];
  order: string[];
} {
  const byId = new Map(runs.map(r => [r.id, r]));
  const releases: { runId: string; leaseToken: string }[] = [];
  const order: string[] = [];
  const store = {
    getRunAuthority: async (runId: string) => ({ runId }),
    claimRunLease: async (lease: unknown) => lease,
    heartbeatRunLease: async () => false,
    releaseRunLease: async (data: { runId: string; leaseToken: string }) => {
      releases.push({ runId: data.runId, leaseToken: data.leaseToken });
      return true;
    },
    getWorkflowRun: async (id: string) => byId.get(id) ?? null,
    getActiveWorkflowRunByPath: async () => null,
    updateWorkflowRun: async (id: string, updates: { metadata?: Record<string, unknown> }) => {
      order.push('updateWorkflowRun');
      const r = byId.get(id);
      if (r && updates.metadata) r.metadata = { ...r.metadata, ...updates.metadata };
    },
    failWorkflowRun: async (id: string) => {
      order.push('failWorkflowRun');
      const r = byId.get(id);
      if (r) r.status = 'failed';
    },
  } as unknown as IWorkflowStore;
  return { store, releases, order };
}

// ---------------------------------------------------------------------------
// Real-process helpers (LINUX)
// ---------------------------------------------------------------------------

const roots: string[] = [];
const strayPids: number[] = [];

afterEach(() => {
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'run-teardown-'));
  roots.push(root);
  return root;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function spawnDetached(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): number {
  const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: 'ignore' });
  child.unref();
  if (child.pid === undefined) throw new Error('spawn failed');
  strayPids.push(child.pid);
  return child.pid;
}

/** Live pids whose cwd is inside `dir` (LINUX). */
function pidsUnder(dir: string): number[] {
  const out: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const cwd = readlinkSync(`/proc/${name}/cwd`);
      const state = readFileSync(`/proc/${name}/stat`, 'utf8').split(') ')[1]?.[0];
      if (state !== 'Z' && (cwd === dir || cwd.startsWith(`${dir}/`))) out.push(Number(name));
    } catch {
      // exited or unreadable
    }
  }
  return out;
}

function isAlivePid(pid: number): boolean {
  try {
    const state = readFileSync(`/proc/${String(pid)}/stat`, 'utf8').split(') ')[1]?.[0];
    return state !== undefined && state !== 'Z';
  } catch {
    return false;
  }
}

function recordingKill(): KillFn & { calls: [number, string][] } {
  const calls: [number, string][] = [];
  const kill = ((pid: number, signal: 'SIGTERM' | 'SIGKILL') => {
    calls.push([pid, signal]);
    process.kill(pid, signal);
  }) as KillFn & { calls: [number, string][] };
  kill.calls = calls;
  return kill;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run teardown (WO-HARNESS-REPAIR-HOLDER-TEARDOWN-01)', () => {
  linuxIt(
    'Test 5: teardown_kills_only_own_new_processes',
    async () => {
      const root = tempRoot();
      const wb = join(root, 'WB');
      mkdirSync(wb);
      const startedAt = new Date(Date.now() - 1000);
      const sleeper = spawnDetached('sleep', ['300'], wb);
      await sleepMs(300);
      expect(isAlivePid(sleeper)).toBe(true);
      const kill = recordingKill();
      const { store, order } = memStore([
        { id: 'run-b', status: 'running', metadata: {}, working_path: wb, started_at: startedAt },
      ]);
      const metadata = await finalizeRunTeardown(
        store,
        { id: 'run-b', working_path: wb, started_at: startedAt },
        { kill }
      );
      await store.failWorkflowRun('run-b', 'done');
      expect(isAlivePid(sleeper)).toBe(false);
      expect(kill.calls.length).toBeGreaterThan(0);
      for (const [pid] of kill.calls) {
        expect(pid).toBe(sleeper);
        expect(pid).toBeGreaterThan(0);
      }
      expect(typeof metadata.teardown_confirmed_at).toBe('string');
      expect(order).toEqual(['updateWorkflowRun', 'failWorkflowRun']);
    },
    20000
  );

  it('Test 6: sibling_run_survives_teardown', async () => {
    // Fake /proc: A's child lives in WA; B is terminal with WB.
    const r = fakeReader([{ pid: 5001, cwd: '/w/WA/sub', startTicks: 5_000 }]);
    const resultB = await endRunProcessTree(
      { id: 'run-b', working_path: '/w/WB', started_at: new Date(1000) },
      fakeOpts(r)
    );
    expect(resultB.confirmed).toBe(true);
    expect(r.kill.calls).toEqual([]);

    // Leases: B terminal + confirmed releases; A non-terminal is never touched.
    const leaseRows = new Map<string, string | null>([
      ['run-a', null],
      ['run-b', null],
    ]);
    const runs = new Map<string, MemRun>([
      [
        'run-a',
        {
          id: 'run-a',
          status: 'running',
          metadata: {},
          working_path: '/w/WA',
          started_at: new Date(1000),
        },
      ],
      [
        'run-b',
        {
          id: 'run-b',
          status: 'failed',
          metadata: { teardown_confirmed_at: '2026-11-01T00:00:00.000Z', teardown_survivors: [] },
          working_path: '/w/WB',
          started_at: new Date(1000),
        },
      ],
    ]);
    const store = {
      getRunAuthority: async (runId: string) => ({ runId }),
      claimRunLease: async (lease: unknown) => lease,
      heartbeatRunLease: async () => true,
      releaseRunLease: async (data: { runId: string }) => {
        leaseRows.set(data.runId, 'released');
        return true;
      },
      getWorkflowRun: async (id: string) => runs.get(id) ?? null,
      listUnreleasedTerminalRunLeases: async (): Promise<TerminalRunLeaseRecord[]> =>
        [...leaseRows.entries()]
          .filter(([id, rel]) => rel === null && runs.get(id)?.status !== 'running')
          .map(([id]) => ({
            runId: id,
            status: runs.get(id)?.status ?? '',
            workingPath: runs.get(id)?.working_path ?? null,
            startedAt: '2026-01-01 00:00:00',
            completedAt: '2026-01-01 00:00:00',
          })),
      releaseTerminalRunLease: async (data: { runId: string }) => {
        leaseRows.set(data.runId, 'released');
        return true;
      },
    } as unknown as IWorkflowStore;
    await withRunLease(store, 'run-b', async () => 'done');
    await releaseTerminalRunLeases(store, { ...fakeOpts(r), pathExists: () => true });
    expect(leaseRows.get('run-b')).toBe('released');
    expect(leaseRows.get('run-a')).toBeNull();
    expect(r.kill.calls).toEqual([]);

    if (IS_LINUX) {
      const root = tempRoot();
      const wa = join(root, 'WA');
      const wb = join(root, 'WB');
      mkdirSync(wa);
      mkdirSync(wb);
      const startedAt = new Date(Date.now() - 1000);
      const childA = spawnDetached('sleep', ['300'], wa);
      await sleepMs(300);
      const kill = recordingKill();
      const real = await endRunProcessTree(
        { id: 'run-b', working_path: wb, started_at: startedAt },
        { kill }
      );
      expect(real.confirmed).toBe(true);
      expect(isAlivePid(childA)).toBe(true);
      expect(kill.calls).toEqual([]);
    }
  }, 20000);

  linuxIt(
    'Test 7: other_process_group_holder_not_killed',
    async () => {
      const root = tempRoot();
      const wb = join(root, 'WB');
      const out = join(root, 'OUT');
      mkdirSync(wb);
      mkdirSync(out);
      // Stranger 1: own session/group, started BEFORE run B, cwd inside WB.
      const stranger1 = spawnDetached('setsid', ['sleep', '300'], wb);
      await sleepMs(1500);
      const startedAt = new Date();
      await sleepMs(300);
      // A parent (cwd OUT) with an owned child in WB and a setsid child in OUT.
      spawnDetached(
        'bash',
        ['-c', '(cd "$WB" && exec sleep 300) & (cd "$OUT" && exec setsid sleep 300) & wait'],
        out,
        { ...process.env, WB: wb, OUT: out }
      );
      await sleepMs(600);
      const stranger2 = pidsUnder(out).filter(pid =>
        readFileSync(`/proc/${String(pid)}/stat`, 'utf8').includes('(sleep)')
      );
      for (const pid of [...pidsUnder(wb), ...pidsUnder(out)]) strayPids.push(pid);
      expect(stranger2.length).toBe(1);
      const kill = recordingKill();
      const result = await endRunProcessTree(
        { id: 'run-b', working_path: wb, started_at: startedAt },
        { kill }
      );
      const signaled = kill.calls.map(([pid]) => pid);
      expect(signaled).not.toContain(stranger1);
      expect(signaled).not.toContain(stranger2[0]);
      expect(isAlivePid(stranger1)).toBe(true);
      expect(isAlivePid(stranger2[0] as number)).toBe(true);
      expect(result.confirmed).toBe(false);
      expect(result.survivors).toContainEqual(
        expect.objectContaining({ pid: stranger1, reason: 'predates_run' })
      );
      // B's lease is not released when teardown is unconfirmed.
      const { store, releases } = memStore([
        {
          id: 'run-b',
          status: 'failed',
          metadata: { teardown_survivors: result.survivors },
          working_path: wb,
          started_at: startedAt,
        },
      ]);
      await withRunLease(store, 'run-b', async () => 'done');
      expect(releases).toEqual([]);
    },
    20000
  );

  it('Test 7 (fake /proc): predates_run and foreign_uid holders block and are never signaled', async () => {
    const r = fakeReader([
      { pid: 7001, cwd: '/w/WB', startTicks: 500 },
      { pid: 7002, cwd: '/w/WB/x', startTicks: 5000, uid: 0 },
      { pid: 7003, cwd: '/elsewhere', startTicks: 5000 },
      { pid: 7004, cwd: '/w/WB/y', startTicks: 5000 },
    ]);
    const result = await endRunProcessTree(
      { id: 'b', working_path: '/w/WB', started_at: new Date(1000) },
      fakeOpts(r)
    );
    expect(r.kill.calls.map(([pid]) => pid)).toEqual([7004]);
    expect(result.confirmed).toBe(false);
    expect(result.survivors).toContainEqual({ pid: 7001, comm: 'sleep', reason: 'predates_run' });
    expect(result.survivors).toContainEqual({ pid: 7002, comm: 'sleep', reason: 'foreign_uid' });
  });

  it('Test 8: reused_pid_not_signaled', async () => {
    const r = fakeReader([{ pid: 4242, cwd: '/w/WB', startTicks: 5000, restartTicks: 9000 }]);
    await endRunProcessTree(
      { id: 'b', working_path: '/w/WB', started_at: new Date(1000) },
      fakeOpts(r)
    );
    expect(r.kill.calls.filter(([pid]) => pid === 4242)).toEqual([]);
  });

  it('Test 9: scan_permission_failure_is_not_empty', async () => {
    const r = fakeReader([{ pid: 4343, cwd: '/w/WB', startTicks: 5000, cwdError: 'EACCES' }]);
    const result = await endRunProcessTree(
      { id: 'b', working_path: '/w/WB', started_at: new Date(1000) },
      fakeOpts(r)
    );
    expect(result.confirmed).toBe(false);
    expect(result.confirmedAt).toBeUndefined();
    expect(result.survivors).toContainEqual({ pid: 4343, reason: 'scan_incomplete' });
    expect(r.kill.calls).toEqual([]);
    const { store, releases } = memStore([
      {
        id: 'b',
        status: 'failed',
        metadata: { teardown_survivors: result.survivors },
        working_path: '/w/WB',
        started_at: new Date(1000),
      },
    ]);
    await withRunLease(store, 'b', async () => 'done');
    expect(releases).toEqual([]);
    // A foreign-uid process whose cwd is unreadable is not observable and does not block.
    const foreign = fakeReader([
      { pid: 4344, cwd: '/w/WB', startTicks: 5000, cwdError: 'EACCES', uid: 0 },
    ]);
    const clear = await endRunProcessTree(
      { id: 'b', working_path: '/w/WB', started_at: new Date(1000) },
      fakeOpts(foreign)
    );
    expect(clear.confirmed).toBe(true);
  });

  linuxIt(
    'Test 10: orphan_pipeline_reaped_at_run_end',
    async () => {
      const root = tempRoot();
      const wt = join(root, 'WT');
      mkdirSync(wt);
      // Run-end case: a node leaves an orphan pipeline behind.
      const startedAt = new Date(Date.now() - 1000);
      await execFileAsync(
        'bash',
        ['-c', 'touch log; (tail -f "$PWD/log" | cat) >/dev/null 2>&1 & disown; exit 0'],
        { cwd: wt }
      );
      await sleepMs(400);
      const pipeline = pidsUnder(wt);
      strayPids.push(...pipeline);
      expect(pipeline.length).toBeGreaterThanOrEqual(2);
      const result = await endRunProcessTree({
        id: 'run-t',
        working_path: wt,
        started_at: startedAt,
      });
      expect(pidsUnder(wt)).toEqual([]);
      expect(result.confirmed).toBe(true);
      expect(typeof result.confirmedAt).toBe('string');
    },
    20000
  );

  linuxIt(
    'Test 10b: orphan_pipeline_reaped_at_run_end (node timeout spares earlier and concurrent nodes)',
    async () => {
      const root = tempRoot();
      const wt = join(root, 'WT');
      mkdirSync(wt);
      const runStart = new Date(Date.now() - 2000);
      // A process started by an EARLIER node.
      const earlier = spawnDetached('sleep', ['300'], wt);
      await sleepMs(1200);
      const nodeAStart = Date.now();
      const tokenA = 'run-t:node-a:token';
      const tokenB = 'run-t:node-b:token';
      const nodeA = execFileAsync('bash', ['-c', 'sleep 0.3; sleep 300 >/dev/null 2>&1 & wait'], {
        cwd: wt,
        timeout: 2000,
        env: { ...process.env, [NODE_TOKEN_ENV]: tokenA },
      });
      // Concurrent node B starts AFTER node A in the same worktree.
      await sleepMs(500);
      const nodeB = spawnDetached('bash', ['-c', 'sleep 300'], wt, {
        ...process.env,
        [NODE_TOKEN_ENV]: tokenB,
      });
      let timeoutError: unknown;
      try {
        await nodeA;
      } catch (error) {
        timeoutError = error;
      }
      // execFile reports a timeout kill as killed=true (dag-executor's isTimeout test).
      expect((timeoutError as { killed?: boolean } | undefined)?.killed).toBe(true);
      const beforeTeardown = pidsUnder(wt);
      strayPids.push(...beforeTeardown);
      const result = await endNodeProcessTree({
        run: { id: 'run-t', working_path: wt, started_at: runStart },
        nodeStartMs: nodeAStart,
        nodeToken: tokenA,
      });
      expect(result.confirmed).toBe(true);
      expect(result.signaled.length).toBeGreaterThanOrEqual(1);
      expect(result.signaled).not.toContain(earlier);
      expect(result.signaled).not.toContain(nodeB);
      expect(isAlivePid(earlier)).toBe(true);
      expect(isAlivePid(nodeB)).toBe(true);
      for (const pid of result.signaled) expect(isAlivePid(pid)).toBe(false);
    },
    20000
  );

  it('Test 10c: node timeout ownership is the node token, not the start time (fake /proc)', async () => {
    const env = (token: string): string => `PATH=/bin\u0000${NODE_TOKEN_ENV}=${token}\u0000`;
    const r = fakeReader([
      { pid: 8001, cwd: '/w/WT', startTicks: 2000, environ: env('A') },
      // Node B started after node A, same worktree: must survive A's teardown.
      { pid: 8002, cwd: '/w/WT', startTicks: 3000, environ: env('B') },
      // Earlier node, no token match.
      { pid: 8003, cwd: '/w/WT', startTicks: 500, environ: env('EARLIER') },
    ]);
    const result = await endNodeProcessTree(
      {
        run: { id: 'run-t', working_path: '/w/WT', started_at: new Date(100) },
        nodeStartMs: 1500,
        nodeToken: 'A',
      },
      fakeOpts(r)
    );
    expect(r.kill.calls.map(([pid]) => pid)).toEqual([8001]);
    expect(result.confirmed).toBe(true);
  });

  it('Test 11: lease_released_when_terminal_and_clear', async () => {
    // Case 1: heartbeat failed (leaseValid false), teardown confirmed -> released.
    const confirmed = memStore([
      {
        id: 'r1',
        status: 'running',
        metadata: {},
        working_path: '/w/R1',
        started_at: new Date(1000),
      },
    ]);
    let sawInvalid = false;
    await withRunLease(
      confirmed.store,
      'r1',
      async isValid => {
        await sleepMs(30);
        sawInvalid = !isValid();
        await confirmed.store.updateWorkflowRun('r1', {
          metadata: { teardown_confirmed_at: '2026-11-01T00:00:00.000Z', teardown_survivors: [] },
        });
        await confirmed.store.failWorkflowRun('r1', 'x');
      },
      { heartbeatIntervalMs: 5, leaseToken: 'tok-1', ownerId: 'w1' }
    );
    expect(sawInvalid).toBe(true);
    expect(confirmed.releases).toEqual([{ runId: 'r1', leaseToken: 'tok-1' }]);

    // Case 2: one survived_kill survivor -> lease kept.
    const held = memStore([
      {
        id: 'r2',
        status: 'running',
        metadata: {},
        working_path: '/w/R2',
        started_at: new Date(1000),
      },
    ]);
    await withRunLease(
      held.store,
      'r2',
      async () => {
        await held.store.updateWorkflowRun('r2', {
          metadata: { teardown_survivors: [{ pid: 1234, reason: 'survived_kill' }] },
        });
        await held.store.failWorkflowRun('r2', 'x');
      },
      { heartbeatIntervalMs: 5 }
    );
    expect(held.releases).toEqual([]);
    expect(
      isTeardownConfirmed({ teardown_survivors: [{ pid: 1234, reason: 'survived_kill' }] })
    ).toBe(false);
  });

  it('Test 12: terminal_lease_reconciler_drains_history', async () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE remote_agent_workflow_runs (
      id TEXT PRIMARY KEY, status TEXT, working_path TEXT, started_at TEXT, completed_at TEXT)`);
    db.run(`CREATE TABLE remote_agent_run_leases (
      run_id TEXT PRIMARY KEY, owner_id TEXT, lease_token TEXT UNIQUE, acquired_at TEXT,
      last_heartbeat_at TEXT, expires_at TEXT, released_at TEXT)`);
    const iso = (msAgo: number): string =>
      new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
    const runs: [string, string, string, number][] = [
      ['failed-gone', 'failed', '/gone/worktree', 20 * 60_000],
      ['cancelled-live', 'cancelled', '/w/live', 20 * 60_000],
      ['completed-fresh', 'completed', '/w/fresh', 2 * 60_000],
      ['running', 'running', '/w/running', 0],
    ];
    for (const [id, status, path, ago] of runs) {
      db.run(
        'INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?)',
        id,
        status,
        path,
        iso(ago + 3_600_000),
        status === 'running' ? null : iso(ago)
      );
      db.run(
        'INSERT INTO remote_agent_run_leases VALUES (?, ?, ?, ?, ?, ?, NULL)',
        id,
        'owner',
        `tok-${id}`,
        iso(ago),
        iso(ago),
        iso(ago)
      );
    }
    const toSqlite = (sql: string): string => sql.replace(/\$([0-9]+)/g, '?$1');
    const store = {
      listUnreleasedTerminalRunLeases: async (): Promise<TerminalRunLeaseRecord[]> =>
        (
          db.query(toSqlite(TERMINAL_RUN_LEASES_SQL)).all() as {
            run_id: string;
            status: string;
            working_path: string | null;
            started_at: string;
            completed_at: string | null;
          }[]
        ).map(row => ({
          runId: row.run_id,
          status: row.status,
          workingPath: row.working_path,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        })),
      releaseTerminalRunLease: async (data: { runId: string; releasedAt: string }) =>
        db.query(toSqlite(RELEASE_TERMINAL_RUN_LEASE_SQL)).run(data.runId, data.releasedAt)
          .changes === 1,
    };
    // A qualifying live process sits in the cancelled run's worktree.
    const r = fakeReader([{ pid: 6001, cwd: '/w/live', startTicks: Date.now() }]);
    const report = await releaseTerminalRunLeases(store, {
      ...fakeOpts(r),
      pathExists: path => path !== '/gone/worktree',
    });
    const released = Object.fromEntries(
      (
        db.query('SELECT run_id, released_at FROM remote_agent_run_leases').all() as {
          run_id: string;
          released_at: string | null;
        }[]
      ).map(row => [row.run_id, row.released_at])
    );
    expect(released['failed-gone']).not.toBeNull();
    expect(released['cancelled-live']).toBeNull();
    expect(released['completed-fresh']).toBeNull();
    expect(released.running).toBeNull();
    expect(report.released).toBe(1);
    expect(r.kill.calls).toEqual([]);
    db.close();
  });

  it('Test 13: repair_run_waits_for_not_before', async () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    const completedAt = new Date(now.getTime() - 30_000);
    const spec = 'Repair target: PR #1315 (branch feat/x)\n';
    const porcelain = [
      'worktree /w/self',
      'HEAD aaaa',
      'branch refs/heads/caller',
      '',
      'worktree /w/holder',
      'HEAD bbbb',
      'branch refs/heads/feat/x',
      '',
    ].join('\n');
    const sleeps: number[] = [];
    const recorded: string[] = [];
    const result = await computeRepairNotBefore({
      spec,
      cwd: '/w/self',
      listWorktrees: async () => porcelain,
      listRuns: async path =>
        path === '/w/holder' ? [{ status: 'escalated', completed_at: completedAt }] : [],
      now: () => now,
      sleep: async ms => {
        sleeps.push(ms);
      },
      record: async notBefore => {
        recorded.push(notBefore);
      },
    });
    const expected = new Date(completedAt.getTime() + 600_000).toISOString();
    expect(result?.notBefore).toBe(expected);
    expect(recorded).toEqual([expected]);
    expect(sleeps).toEqual([570_000]);

    // No holder: nothing recorded, no wait.
    const sleeps2: number[] = [];
    const recorded2: string[] = [];
    const none = await computeRepairNotBefore({
      spec,
      cwd: '/w/self',
      listWorktrees: async () => 'worktree /w/self\nHEAD aaaa\nbranch refs/heads/caller\n',
      listRuns: async () => [],
      now: () => now,
      sleep: async ms => {
        sleeps2.push(ms);
      },
      record: async notBefore => {
        recorded2.push(notBefore);
      },
    });
    expect(none).toBeNull();
    expect(sleeps2).toEqual([]);
    expect(recorded2).toEqual([]);
  });

  it('Test 14: unverifiable_platform_fails_closed', async () => {
    const target = { id: 'w', working_path: '/w/W', started_at: new Date(1000) };
    const win = await endRunProcessTree(target, { platform: 'win32' });
    expect(win.confirmed).toBe(false);
    expect(win.survivors).toEqual([{ reason: 'teardown_unverifiable' }]);
    const broken: ProcReader = {
      ...fakeReader([]).reader,
      listPids: () => {
        throw errno('EACCES');
      },
    };
    const noProc = await endRunProcessTree(target, { platform: 'linux', reader: broken });
    expect(noProc.survivors).toEqual([{ reason: 'teardown_unverifiable' }]);
    // A timed-out node on an unverifiable platform is not a clean timeout.
    const node = await endNodeProcessTree(
      { run: target, nodeStartMs: 1000, nodeToken: 'tok' },
      { platform: 'win32' }
    );
    expect(node.confirmed).toBe(false);
    expect(node.survivors).toEqual([{ reason: 'teardown_unverifiable' }]);
    // Metadata written and lease not released.
    const { store, releases } = memStore([
      {
        id: 'w',
        status: 'running',
        metadata: {},
        working_path: '/w/W',
        started_at: new Date(1000),
      },
    ]);
    await withRunLease(store, 'w', async () => {
      const md = await finalizeRunTeardown(store, target, { platform: 'win32' });
      expect(md.teardown_confirmed_at).toBeUndefined();
      expect(md.teardown_survivors).toEqual([{ reason: 'teardown_unverifiable' }]);
      await store.failWorkflowRun('w', 'x');
    });
    expect(releases).toEqual([]);
  });

  it('Test 15: failed_repair_checkout_ends_run', async () => {
    const yaml = (checkoutScript: string): string =>
      [
        'name: lane-fixture',
        'description: fixture',
        'nodes:',
        '  - id: checkout-repair-target',
        '    abort_run_on_failure: true',
        '    bash: |',
        `      ${checkoutScript}`,
        '  - id: plan',
        '    depends_on: [checkout-repair-target]',
        '    trigger_rule: all_done',
        '    bash: echo planned',
        '  - id: later',
        '    depends_on: [plan]',
        '    trigger_rule: all_done',
        '    bash: echo later',
        '',
      ].join('\n');
    const run = async (
      checkoutScript: string
    ): Promise<{ store: Record<string, ReturnType<typeof mock>>; events: string[] }> => {
      const parsed = parseWorkflow(yaml(checkoutScript), 'lane-fixture.yaml');
      if (!parsed.workflow) throw new Error(parsed.error?.error ?? 'parse failed');
      const events: string[] = [];
      const store = {
        createWorkflowEvent: mock(async (data: { event_type: string; step_name?: string }) => {
          events.push(`${data.event_type}:${data.step_name ?? ''}`);
        }),
        getWorkflowRunStatus: mock(async () => 'running'),
        getWorkflowRun: mock(async () => null),
        getActiveWorkflowRunByPath: mock(async () => null),
        updateWorkflowRun: mock(async () => undefined),
        failWorkflowRun: mock(async () => undefined),
        completeWorkflowRun: mock(async () => undefined),
        getRunOutcome: mock(async () => null),
        upsertRunOutcome: mock(async () => true),
        getRunAuthority: mock(async () => null),
        listWorkflowEvents: mock(async () => []),
      };
      const deps = {
        store: store as unknown as IWorkflowStore,
        getAgentProvider: mock(() => {
          throw new Error('no AI in this fixture');
        }),
        loadConfig: mock(async () => ({})),
      } as unknown as WorkflowDeps;
      const platform: IWorkflowPlatform = {
        sendMessage: mock(async () => undefined),
        getStreamingMode: mock(() => 'batch' as const),
        getPlatformType: mock(() => 'test'),
        sendStructuredEvent: mock(async () => undefined),
      } as unknown as IWorkflowPlatform;
      const root = tempRoot();
      const workflowRun: WorkflowRun = {
        id: 'abort-run',
        workflow_name: 'lane-fixture',
        conversation_id: 'conv',
        parent_conversation_id: null,
        codebase_id: null,
        status: 'running',
        user_message: 'fixture',
        metadata: {},
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: null,
      };
      await executeDagWorkflow(
        deps,
        platform,
        'conv',
        root,
        parsed.workflow,
        workflowRun,
        'claude',
        undefined,
        join(root, 'artifacts'),
        join(root, 'logs'),
        'main',
        'docs/',
        {
          assistant: 'claude',
          assistants: { claude: {}, codex: {} },
          commands: {},
          defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
        }
      );
      return { store: store as unknown as Record<string, ReturnType<typeof mock>>, events };
    };

    const failed = await run(
      'echo "repair_target_branch_held: feat/x is checked out by /w/A; not reclaimed: live process cwd under holder" >&2; exit 1'
    );
    expect(failed.events.filter(e => e.startsWith('node_completed:'))).toEqual([]);
    expect(failed.events.some(e => e === 'node_started:plan' || e === 'node_started:later')).toBe(
      false
    );
    const failCall = failed.store.failWorkflowRun.mock.calls[0] as unknown[];
    expect(failCall).toBeDefined();
    const terminal = failCall[2] as { metadata: Record<string, unknown> };
    expect(terminal.metadata.terminal_cause).toBe('repair_checkout_failed');
    expect(String(terminal.metadata.repair_failure_reason)).toStartWith(
      'repair_target_branch_held'
    );
    // Teardown metadata is persisted before the terminal status write.
    const updateOrder = failed.store.updateWorkflowRun.mock.invocationCallOrder[0] as number;
    const failOrder = failed.store.failWorkflowRun.mock.invocationCallOrder[0] as number;
    expect(updateOrder).toBeLessThan(failOrder);

    const ok = await run('echo REPAIR_TARGET=none');
    expect(ok.events).toContain('node_completed:later');
    expect(ok.store.failWorkflowRun.mock.calls.length).toBe(0);
  }, 60000);
});
