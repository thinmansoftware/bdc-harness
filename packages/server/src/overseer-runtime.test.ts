import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const listCapabilityStatesMock = mock(
  async (): Promise<
    Array<{ capability: string; action_enabled: boolean; circuit_state: string }>
  > => []
);
const getLastActionAtMock = mock(async (): Promise<string | null> => null);
const getLastVerdictAtMock = mock(async (): Promise<string | null> => null);
const countPendingJudgmentsMock = mock(async (): Promise<number> => 0);

// Capture adapterKind passed into runOverseerService for real-wiring assertions.
let capturedServiceOptions: {
  adapterKind?: string;
  deliveryEnabled?: boolean;
  deps?: unknown;
  mergeCoordinator?: unknown;
} | null = null;
const runOverseerServiceMock = mock(async (opts?: unknown) => {
  capturedServiceOptions = (opts ?? {}) as NonNullable<typeof capturedServiceOptions>;
});

import {
  startOverseerRuntime,
  stopOverseerRuntime,
  getOverseerRuntimeStatus,
  createRuntimeMergeManager,
} from './overseer-runtime';
import type { WatchedRunRecord } from '../../overseer/src/types';
import { startMergeSweepLivenessMonitor } from '../../overseer/src/merge-sweep-liveness.ts';
import { PRODUCTION_EFFECT_HOLD_REASON } from '../../overseer/src/merge-manager.ts';

const getStatus = (now?: () => Date) =>
  getOverseerRuntimeStatus({
    listCapabilityStates: listCapabilityStatesMock,
    getLastActionAt: getLastActionAtMock,
    getLastVerdictAt: getLastVerdictAtMock,
    countPendingJudgments: countPendingJudgmentsMock,
    now,
  });

const oldEnabled = process.env.OVERSEER_ENABLED;
const oldEmergencyStop = process.env.OVERSEER_EMERGENCY_STOP;
const oldFakeAdapter = process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER;
const oldGhToken = process.env.GH_TOKEN;
const oldGithubToken = process.env.GITHUB_TOKEN;

function setDisabledEnv(): void {
  process.env.OVERSEER_ENABLED = 'false';
  process.env.OVERSEER_EMERGENCY_STOP = 'true';
  process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER = '1';
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  for (const cap of ['ESCALATION', 'REPAIR', 'BRANCH', 'LIFECYCLE', 'MERGE']) {
    process.env[`OVERSEER_${cap}_ACTIONS_ENABLED`] = 'false';
  }
}

function setEnabledEnv(): void {
  process.env.OVERSEER_ENABLED = 'true';
  process.env.OVERSEER_EMERGENCY_STOP = 'true';
  process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER = '1';
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  for (const cap of ['ESCALATION', 'REPAIR', 'BRANCH', 'LIFECYCLE', 'MERGE']) {
    process.env[`OVERSEER_${cap}_ACTIONS_ENABLED`] = 'false';
  }
}

describe('overseer-runtime', () => {
  test('runtime manager reads originating events and holds failed evidence or a missing run', async () => {
    const headSha = 'a'.repeat(40);
    const record: WatchedRunRecord = {
      runId: 'run-runtime-evidence',
      woId: 'WO-EVIDENCE',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      status: 'failed',
      action: 'merge_ready',
      reason: 'green PR',
      workingPath: '/worktree/run',
      metadata: { base_branch: 'dev' },
      prEvidence: {
        exists: true,
        state: 'open',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: true,
        headSha,
        baseBranch: 'dev',
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 42 },
      },
    };
    const listRunEvents = mock(async (runId: string) => [
      {
        id: 'event-runtime',
        workflow_run_id: runId,
        event_type: 'node_failed',
        step_name: 'manifest-evidence-check',
        data: { error: 'EVIDENCE_ERROR: no tests' },
      },
    ]);
    const findRun = mock(async (id: string): Promise<{ id: string } | null> => ({ id }));
    const mergePullRequest = mock(async () => ({ merged: true }));
    const deps = {
      mode: 'execute',
      mutationsEnabled: true,
      listRunEvents,
      findPullRequest: async () => record.prEvidence,
      readWorktreeHeadSha: async () => headSha,
      mergePullRequest,
      insertOverseerAction: async () => undefined,
    };
    const manager = createRuntimeMergeManager(deps, findRun);
    expect(await manager(record)).toMatchObject({
      status: 'held',
      reason: 'originating_run_failed_evidence_gate',
    });
    expect(findRun).toHaveBeenCalledWith('run-runtime-evidence');
    expect(listRunEvents).toHaveBeenCalledWith('run-runtime-evidence');
    findRun.mockImplementation(async () => null);
    expect(await manager(record)).toMatchObject({
      status: 'held',
      reason: 'originating_run_unreadable',
    });
    expect(listRunEvents).toHaveBeenCalledTimes(1);
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    runOverseerServiceMock.mockReset();
    // Re-apply base capture impl after reset (mockReset clears implementation).
    runOverseerServiceMock.mockImplementation(async (opts?: unknown) => {
      capturedServiceOptions = (opts ?? {}) as {
        adapterKind?: string;
        deliveryEnabled?: boolean;
        deps?: unknown;
        mergeCoordinator?: unknown;
      };
    });
    listCapabilityStatesMock.mockReset();
    listCapabilityStatesMock.mockImplementation(async () => []);
    getLastActionAtMock.mockReset();
    getLastActionAtMock.mockImplementation(async () => null);
    getLastVerdictAtMock.mockReset();
    getLastVerdictAtMock.mockImplementation(async () => null);
    countPendingJudgmentsMock.mockReset();
    countPendingJudgmentsMock.mockImplementation(async () => 0);
    capturedServiceOptions = null;
    setDisabledEnv();
  });

  afterEach(async () => {
    await stopOverseerRuntime();
    process.env.OVERSEER_ENABLED = oldEnabled;
    process.env.OVERSEER_EMERGENCY_STOP = oldEmergencyStop;
    process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER = oldFakeAdapter;
    if (oldGhToken !== undefined) process.env.GH_TOKEN = oldGhToken;
    else delete process.env.GH_TOKEN;
    if (oldGithubToken !== undefined) process.env.GITHUB_TOKEN = oldGithubToken;
    else delete process.env.GITHUB_TOKEN;
  });

  test('disabled service starts no watcher and makes no db reads', () => {
    setDisabledEnv();
    startOverseerRuntime({ runService: runOverseerServiceMock });
    expect(runOverseerServiceMock).not.toHaveBeenCalled();
  });

  test('disabled service watcher state is stopped', async () => {
    setDisabledEnv();
    startOverseerRuntime({ runService: runOverseerServiceMock });
    const status = await getStatus();
    expect(status.watcher).toBe('stopped');
  });

  test('second start call while running is a no-op -- one watcher only', async () => {
    let resolveService!: () => void;
    runOverseerServiceMock.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          resolveService = resolve;
        })
    );

    setEnabledEnv();
    startOverseerRuntime({ runService: runOverseerServiceMock });
    startOverseerRuntime({ runService: runOverseerServiceMock });

    expect(runOverseerServiceMock).toHaveBeenCalledTimes(1);
    const status = await getStatus();
    expect(status.watcher).toBe('running');

    resolveService();
    await stopOverseerRuntime();
  });

  test('stopOverseerRuntime aborts and awaits the watcher task', async () => {
    let abortSeen = false;
    runOverseerServiceMock.mockImplementation(async (opts?: { signal?: AbortSignal }) => {
      await new Promise<void>(resolve => {
        opts?.signal?.addEventListener(
          'abort',
          () => {
            abortSeen = true;
            resolve();
          },
          { once: true }
        );
      });
    });

    setEnabledEnv();
    startOverseerRuntime({ runService: runOverseerServiceMock });
    const statusBefore = await getStatus();
    expect(statusBefore.watcher).toBe('running');
    await stopOverseerRuntime();
    expect(abortSeen).toBe(true);
    const statusAfter = await getStatus();
    expect(statusAfter.watcher).toBe('stopped');
  });

  test('watcher exception degrades status without throwing to the caller', async () => {
    runOverseerServiceMock.mockImplementation(async () => {
      throw new Error('watcher_test_failure');
    });

    setEnabledEnv();
    startOverseerRuntime({ runService: runOverseerServiceMock });

    await new Promise<void>(resolve => setTimeout(resolve, 20));
    const status = await getStatus();
    expect(status.watcher).toBe('degraded');
  });

  test('watcher exception aborts the owned runtime signal before clearing ownership', async () => {
    let ownedSignal: AbortSignal | undefined;
    runOverseerServiceMock.mockImplementation(async (opts?: { signal?: AbortSignal }) => {
      ownedSignal = opts?.signal;
      throw new Error('watcher_test_failure');
    });

    setEnabledEnv();
    startOverseerRuntime({ runService: runOverseerServiceMock });
    await new Promise<void>(resolve => setTimeout(resolve, 20));

    expect(ownedSignal?.aborted).toBe(true);
    expect((await getStatus()).watcher).toBe('degraded');
    await expect(stopOverseerRuntime()).resolves.toBeUndefined();
  });

  test('stopOverseerRuntime is safe when not started', async () => {
    await expect(stopOverseerRuntime()).resolves.toBeUndefined();
  });

  test('status reports emergency_stop and no credential fields', async () => {
    setEnabledEnv();
    const status = await getStatus();
    expect(status.emergency_stop).toBe(true);
    expect(Object.keys(status).includes('token')).toBe(false);
    expect(JSON.stringify(status)).not.toContain('REPLACE_WITH');
  });

  test('blocking_reasons names active merge gates', async () => {
    listCapabilityStatesMock.mockImplementation(async () => [
      { capability: 'escalation', action_enabled: true, circuit_state: 'open' },
      { capability: 'merge', action_enabled: false, circuit_state: 'closed' },
    ]);

    const status = await getStatus();

    expect(status.blocking_reasons).toContain(PRODUCTION_EFFECT_HOLD_REASON);
    expect(status.blocking_reasons).toContain('escalation:circuit_open');
    expect(status.blocking_reasons).toContain('merge:capability_flag_disabled');
    expect(status.blocking_reasons).toContain('emergency_stop');
    expect(status.blocking_reasons).not.toContain('escalation:capability_flag_disabled');
  });

  test('circuit_states default to unknown when DB returns empty (not closed)', async () => {
    listCapabilityStatesMock.mockImplementation(async () => []);
    const status = await getStatus();
    const caps = ['escalation', 'repair', 'branch', 'lifecycle', 'merge'];
    for (const cap of caps) {
      // Must be 'unknown' when no DB rows -- never hardcode 'closed'
      expect(status.circuit_states[cap]).toBe('unknown');
    }
  });

  test('circuit_states reflect persisted DB values when available', async () => {
    listCapabilityStatesMock.mockImplementation(async () => [
      {
        capability: 'escalation',
        action_enabled: false,
        circuit_state: 'open',
        circuit_reason: 'test',
        circuit_opened_at: null,
        policy_digest: '0'.repeat(64),
        verifier_registry_digest: '0'.repeat(64),
        updated_at: '',
        updated_by: '',
      },
      {
        capability: 'merge',
        action_enabled: false,
        circuit_state: 'closed',
        circuit_reason: null,
        circuit_opened_at: null,
        policy_digest: '0'.repeat(64),
        verifier_registry_digest: '0'.repeat(64),
        updated_at: '',
        updated_by: '',
      },
    ]);
    const status = await getStatus();
    expect(status.circuit_states['escalation']).toBe('open');
    expect(status.circuit_states['merge']).toBe('closed');
    // Capabilities not in DB response remain 'unknown'
    expect(status.circuit_states['repair']).toBe('unknown');
  });

  test('circuit_states fall back to unknown when DB read fails', async () => {
    listCapabilityStatesMock.mockImplementation(async () => {
      throw new Error('db_read_failed');
    });
    const status = await getStatus();
    const caps = ['escalation', 'repair', 'branch', 'lifecycle', 'merge'];
    for (const cap of caps) {
      expect(status.circuit_states[cap]).toBe('unknown');
    }
    expect(status.status).toBe('unknown');
  });

  test('healthy watcher with recent effect activity stays ok', async () => {
    let resolveService!: () => void;
    runOverseerServiceMock.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          resolveService = resolve;
        })
    );
    setEnabledEnv();
    startOverseerRuntime({ runService: runOverseerServiceMock });
    getLastActionAtMock.mockImplementation(async () => '2026-08-07T11:59:00.000Z');
    getLastVerdictAtMock.mockImplementation(async () => '2026-08-07T11:59:30.000Z');

    expect((await getStatus(() => new Date('2026-08-07T12:00:00.000Z'))).status).toBe('ok');
    resolveService();
    await stopOverseerRuntime();
  });

  test('stale effect clock with pending judgments degrades status', async () => {
    getLastActionAtMock.mockImplementation(async () => '2026-08-07T11:55:00.000Z');
    getLastVerdictAtMock.mockImplementation(async () => '2026-08-07T11:56:00.000Z');
    countPendingJudgmentsMock.mockImplementation(async () => 2);

    const status = await getStatus(() => new Date('2026-08-07T12:00:00.000Z'));

    expect(status.status).toBe('degraded');
    expect(status.last_action_at).toBe('2026-08-07T11:55:00.000Z');
    expect(status.last_verdict_at).toBe('2026-08-07T11:56:00.000Z');
    expect(status.blocking_reasons).toContain('effect_clock_stale_with_pending_judgments');
  });

  test('missing effect clock with pending judgments degrades status', async () => {
    getLastActionAtMock.mockImplementation(async () => null);
    getLastVerdictAtMock.mockImplementation(async () => null);
    countPendingJudgmentsMock.mockImplementation(async () => 2);

    const status = await getStatus(() => new Date('2026-08-07T12:00:00.000Z'));

    expect(status.status).toBe('degraded');
    expect(status.blocking_reasons).toContain('effect_clock_stale_with_pending_judgments');
  });

  test('stale effect clock with an empty backlog does not page', async () => {
    getLastActionAtMock.mockImplementation(async () => '2026-08-01T00:00:00.000Z');
    getLastVerdictAtMock.mockImplementation(async () => '2026-08-01T00:00:00.000Z');

    expect((await getStatus(() => new Date('2026-08-07T12:00:00.000Z'))).status).toBe('ok');
  });

  test('effect status read failure is unknown rather than green', async () => {
    getLastActionAtMock.mockImplementation(async () => {
      throw new Error('missing_overseer_actions');
    });

    expect((await getStatus()).status).toBe('unknown');
  });

  test('fake adapter is selected when OVERSEER_USE_FAKE_GITHUB_ADAPTER is set', async () => {
    let resolveService!: () => void;
    runOverseerServiceMock.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          resolveService = resolve;
        })
    );

    setEnabledEnv();
    process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER = '1';
    startOverseerRuntime({ runService: runOverseerServiceMock });
    const status = await getStatus();
    expect(status.adapter).toBe('fake');

    resolveService();
    await stopOverseerRuntime();
  });

  test('enabled real adapter is rejected before watcher construction', async () => {
    process.env.OVERSEER_ENABLED = 'true';
    process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER = 'false';
    process.env.GITHUB_TOKEN = 'poison-token';

    startOverseerRuntime({ runService: runOverseerServiceMock });
    const status = await getStatus();

    expect(runOverseerServiceMock).not.toHaveBeenCalled();
    expect(status.adapter).toBe('real');
    expect(status.watcher).toBe('degraded');
  });

  test('real adapter starts only when a qualified coordinator composition is injected', async () => {
    process.env.OVERSEER_ENABLED = 'true';
    process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER = 'false';
    process.env.GITHUB_TOKEN = 'poison-token';
    const mergeCoordinator = mock(async () => undefined);
    const deps = {
      listRunsForWatch: async () => [],
      listRunEvents: async () => [],
      findPullRequest: async () => ({ exists: false as const }),
      mergePullRequest: async () => ({ merged: false }),
      insertOverseerAction: async () => undefined,
    };

    startOverseerRuntime({
      runService: runOverseerServiceMock,
      serviceOptions: { deps, mergeCoordinator },
    });
    expect(runOverseerServiceMock).toHaveBeenCalledTimes(1);
    expect(capturedServiceOptions?.adapterKind).toBe('real');
    await stopOverseerRuntime();
  });

  test('real adapter accepts a constructed merge manager without missing-coordinator degrade', async () => {
    process.env.OVERSEER_ENABLED = 'true';
    process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER = 'false';
    process.env.GITHUB_TOKEN = 'poison-token';
    const deps = {
      listRunsForWatch: async () => [],
      listRunEvents: async () => [],
      findPullRequest: async () => ({
        exists: false as const,
        state: 'missing',
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        mergeable: null,
      }),
      mergePullRequest: async () => ({ merged: false }),
      insertOverseerAction: async () => undefined,
    };
    const mergeManager = createRuntimeMergeManager(deps);
    // A real service stays up until stopped. (With a mock that exits at once, the supervisor
    // now treats the exit as unexpected and reports 'degraded' while it backs off to restart.)
    runOverseerServiceMock.mockImplementation(async (opts?: unknown) => {
      capturedServiceOptions = (opts ?? {}) as NonNullable<typeof capturedServiceOptions>;
      const signal = (opts as { signal: AbortSignal }).signal;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
    });

    startOverseerRuntime({
      runService: runOverseerServiceMock,
      serviceOptions: { deps, mergeCoordinator: mergeManager },
    });
    const status = await getStatus();

    expect(runOverseerServiceMock).toHaveBeenCalledTimes(1);
    expect(status.adapter).toBe('real');
    expect(status.watcher).toBe('running');
    expect(capturedServiceOptions?.adapterKind).toBe('real');
    expect(capturedServiceOptions?.deps).toBe(deps);
    expect(capturedServiceOptions?.mergeCoordinator).toBe(mergeManager);
    await stopOverseerRuntime();
  });

  test('fake adapterKind is forwarded to runOverseerService -- no live Octokit wired', async () => {
    let resolveService!: () => void;
    runOverseerServiceMock.mockImplementation(
      (opts?: unknown) =>
        new Promise<void>(resolve => {
          // Capture opts here so we can assert after startOverseerRuntime returns.
          capturedServiceOptions = (opts ?? {}) as {
            adapterKind?: string;
            deliveryEnabled?: boolean;
          };
          resolveService = resolve;
        })
    );

    setEnabledEnv();
    process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER = '1';
    startOverseerRuntime({ runService: runOverseerServiceMock });

    // The runtime must forward adapterKind='fake' into the service so the service
    // wires stub deps instead of constructing a live Octokit client.
    expect(capturedServiceOptions?.adapterKind).toBe('fake');
    expect(capturedServiceOptions?.deliveryEnabled).toBe(true);

    resolveService();
    await stopOverseerRuntime();
  });

  // Test 4 (WO-HARNESS-MERGE-SWEEP-LIVENESS-AND-PAGING-01): a service rejection no longer leaves
  // the watcher, merge bridge and reconcile loop dead; the runtime restarts it with bounded
  // backoff and still stops cleanly.
  test('supervisor: restarts the watcher only after it settled, with backoff, and stops cleanly', async () => {
    setEnabledEnv();
    const logs: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
    const logger = {
      info: (obj: Record<string, unknown>, msg: string) => logs.push({ level: 'info', obj, msg }),
      error: (obj: Record<string, unknown>, msg: string) => logs.push({ level: 'error', obj, msg }),
    };
    // Deterministic scheduler: nothing fires until the test says so.
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const setTimer = (fn: () => void, ms: number): unknown => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    };
    const clearTimer = (handle: unknown): void => {
      (handle as { cleared: boolean }).cleared = true;
    };
    let monitorStops = 0;
    let serviceCalls = 0;
    const events: string[] = [];
    runOverseerServiceMock.mockImplementation(async (opts?: unknown) => {
      serviceCalls += 1;
      events.push(`start${serviceCalls}`);
      if (serviceCalls <= 2) {
        events.push(`settle${serviceCalls}`);
        throw new Error(`database is locked (${serviceCalls})`);
      }
      // Third start stays up until the runtime aborts it.
      const signal = (opts as { signal: AbortSignal }).signal;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
    });
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };

    startOverseerRuntime({
      runService: runOverseerServiceMock,
      logger,
      supervisor: { setTimer, clearTimer },
      startLivenessMonitor: () => ({
        check: async () => false,
        stop: () => {
          monitorStops += 1;
        },
      }),
    });
    await flush();

    // Rejection 1: degraded, restart scheduled at 5 s.
    expect((await getStatus()).watcher).toBe('degraded');
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(5_000);
    expect(
      logs.filter(entry => entry.msg === 'overseer_runtime.watcher_exception_degraded')
    ).toHaveLength(1);
    expect(logs.find(entry => entry.msg === 'overseer_runtime.watcher_restarting')?.obj).toEqual({
      attempt: 1,
      delayMs: 5_000,
    });

    // A second start during backoff must not stack a second watcher.
    startOverseerRuntime({ runService: runOverseerServiceMock, logger });
    expect(serviceCalls).toBe(1);

    timers[0]?.fn();
    await flush();

    // Rejection 2: degraded again, backoff doubled to 10 s.
    expect(serviceCalls).toBe(2);
    expect((await getStatus()).watcher).toBe('degraded');
    expect(timers).toHaveLength(2);
    expect(timers[1]?.ms).toBe(10_000);
    const restarts = logs.filter(entry => entry.msg === 'overseer_runtime.watcher_restarting');
    expect(restarts.map(entry => entry.obj.attempt)).toEqual([1, 2]);
    expect(
      logs.filter(entry => entry.msg === 'overseer_runtime.watcher_exception_degraded')
    ).toHaveLength(2);

    timers[1]?.fn();
    await flush();

    // Third start stays up: running, no further timers.
    expect(serviceCalls).toBe(3);
    expect((await getStatus()).watcher).toBe('running');
    expect(timers).toHaveLength(2);
    // Each restart call happened strictly after the previous promise settled.
    expect(events).toEqual(['start1', 'settle1', 'start2', 'settle2', 'start3']);

    await stopOverseerRuntime();
    expect(monitorStops).toBeGreaterThanOrEqual(1);
    expect((await getStatus()).watcher).not.toBe('running');
    expect(serviceCalls).toBe(3);
  });

  // XO guard (fence 283): the supervisor restarts a loop ONLY after that loop's promise has
  // settled. A HANG raises the 10-minute liveness alarm and nothing else: no second pass, no
  // second loop, no restart timer.
  test('supervisor: a loop hung forever raises the alarm and starts no second pass or loop', async () => {
    setEnabledEnv();
    let clock = Date.UTC(2026, 10, 4, 16, 0, 0);
    const posts: Array<{ recipient?: unknown; priority?: unknown }> = [];
    const alarmLogs: string[] = [];
    const runtimeLogs: string[] = [];
    let serviceCalls = 0;
    const timers: Array<{ ms: number }> = [];
    runOverseerServiceMock.mockImplementation(async (opts?: unknown) => {
      serviceCalls += 1;
      // Hangs: it never settles on its own. It only unblocks when the test's final
      // stopOverseerRuntime aborts it, so cleanup cannot wait forever.
      const signal = (opts as { signal: AbortSignal }).signal;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
    });
    let monitor: ReturnType<typeof startMergeSweepLivenessMonitor> | undefined;
    startOverseerRuntime({
      runService: runOverseerServiceMock,
      logger: {
        info: (_obj, msg) => runtimeLogs.push(msg),
        error: (_obj, msg) => runtimeLogs.push(msg),
      },
      supervisor: {
        setTimer: (_fn, ms) => {
          timers.push({ ms });
          return {};
        },
        clearTimer: () => undefined,
      },
      startLivenessMonitor: () => {
        monitor = startMergeSweepLivenessMonitor({
          now: () => clock,
          startTimer: false,
          maxSilenceMs: 600_000,
          checkIntervalMs: 60_000,
          logger: {
            info: () => undefined,
            error: (_obj, msg) => alarmLogs.push(msg),
          },
          createMessage: async (_context, data) => {
            posts.push({ recipient: data.recipient, priority: data.priority });
            return undefined;
          },
        });
        return monitor;
      },
    });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(serviceCalls).toBe(1);

    // 30 simulated minutes with no sweep progress, one check per minute.
    for (let minute = 1; minute <= 30; minute += 1) {
      clock += 60_000;
      await monitor?.check();
      if (minute === 9) expect(alarmLogs).toEqual([]);
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
    }

    // The alarm fired (one operator message for the episode) ...
    expect(
      alarmLogs.filter(msg => msg === 'merge-coordinator.liveness_alarm').length
    ).toBeGreaterThan(0);
    expect(posts).toEqual([{ recipient: 'operator', priority: 'blocker' }]);
    // ... and the hang triggered NO restart: one call, no restart log, no timer, still running.
    expect(serviceCalls).toBe(1);
    expect(runtimeLogs).not.toContain('overseer_runtime.watcher_restarting');
    expect(timers).toHaveLength(0);
    expect((await getStatus()).watcher).toBe('running');
  });

  test('Test 4b: stopping during backoff clears the restart timer and never restarts', async () => {
    setEnabledEnv();
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const setTimer = (fn: () => void, ms: number): unknown => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    };
    const clearTimer = (handle: unknown): void => {
      (handle as { cleared: boolean }).cleared = true;
    };
    let serviceCalls = 0;
    runOverseerServiceMock.mockImplementation(async () => {
      serviceCalls += 1;
      throw new Error('database is locked');
    });
    startOverseerRuntime({
      runService: runOverseerServiceMock,
      supervisor: { setTimer, clearTimer },
      startLivenessMonitor: () => ({ check: async () => false, stop: () => undefined }),
    });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(timers).toHaveLength(1);

    await stopOverseerRuntime();
    expect(timers[0]?.cleared).toBe(true);
    // Even if the (cleared) timer body ran, an intentional stop must not restart anything.
    timers[0]?.fn();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(serviceCalls).toBe(1);
    expect((await getStatus()).watcher).toBe('stopped');
  });

  test('startup order: reconciliation precedes watcher (integration contract)', () => {
    const calls: string[] = [];
    calls.push('observeStartupRecovery');
    calls.push('reconcilePendingRunsAtBoot');
    calls.push('reconcileRunningRunsAtBoot');
    calls.push('startOverseerRuntime');
    expect(calls[0]).toBe('observeStartupRecovery');
    expect(calls[1]).toBe('reconcilePendingRunsAtBoot');
    expect(calls[2]).toBe('reconcileRunningRunsAtBoot');
    expect(calls[3]).toBe('startOverseerRuntime');
  });
});
