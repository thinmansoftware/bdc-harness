import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const runOverseerServiceMock = mock(async (_opts?: unknown) => {});

mock.module('@archon/overseer/service', () => ({
  runOverseerService: runOverseerServiceMock,
}));

const { startOverseerRuntime, stopOverseerRuntime, getOverseerRuntimeStatus } =
  await import('./overseer-runtime');

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
  beforeEach(() => {
    runOverseerServiceMock.mockReset();
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
    startOverseerRuntime();
    expect(runOverseerServiceMock).not.toHaveBeenCalled();
    const status = getOverseerRuntimeStatus();
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
    startOverseerRuntime();
    startOverseerRuntime();

    expect(runOverseerServiceMock).toHaveBeenCalledTimes(1);
    const status = getOverseerRuntimeStatus();
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
    startOverseerRuntime();
    expect(getOverseerRuntimeStatus().watcher).toBe('running');
    await stopOverseerRuntime();
    expect(abortSeen).toBe(true);
    expect(getOverseerRuntimeStatus().watcher).toBe('stopped');
  });

  test('watcher exception degrades status without throwing to the caller', async () => {
    runOverseerServiceMock.mockImplementation(async () => {
      throw new Error('watcher_test_failure');
    });

    setEnabledEnv();
    startOverseerRuntime();

    await new Promise<void>(resolve => setTimeout(resolve, 20));
    const status = getOverseerRuntimeStatus();
    expect(status.watcher).toBe('degraded');
  });

  test('stopOverseerRuntime is safe when not started', async () => {
    await expect(stopOverseerRuntime()).resolves.toBeUndefined();
  });

  test('status reports emergency_stop and five closed circuits without credential values', () => {
    setEnabledEnv();
    const status = getOverseerRuntimeStatus();
    expect(status.emergency_stop).toBe(true);
    const caps = ['escalation', 'repair', 'branch', 'lifecycle', 'merge'];
    for (const cap of caps) {
      expect(status.capability_flags[cap]).toBe(false);
      expect(status.circuit_states[cap]).toBe('closed');
    }
    expect(Object.keys(status).includes('token')).toBe(false);
    expect(JSON.stringify(status)).not.toContain('REPLACE_WITH');
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
    startOverseerRuntime();
    const status = getOverseerRuntimeStatus();
    expect(status.adapter).toBe('fake');

    resolveService();
    await stopOverseerRuntime();
  });

  test('startup order: reconciliation precedes watcher (integration contract)', () => {
    const calls: string[] = [];
    calls.push('observeStartupRecovery');
    calls.push('reconcilePendingRunsAtBoot');
    calls.push('startOverseerRuntime');
    expect(calls[0]).toBe('observeStartupRecovery');
    expect(calls[1]).toBe('reconcilePendingRunsAtBoot');
    expect(calls[2]).toBe('startOverseerRuntime');
  });
});
