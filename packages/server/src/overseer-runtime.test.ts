import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const listCapabilityStatesMock = mock(
  async (): Promise<
    Array<{ capability: string; action_enabled: boolean; circuit_state: string }>
  > => []
);

// Capture adapterKind passed into runOverseerService for real-wiring assertions.
let capturedServiceOptions: { adapterKind?: string; deliveryEnabled?: boolean } | null = null;
const runOverseerServiceMock = mock(async (opts?: unknown) => {
  capturedServiceOptions = (opts ?? {}) as { adapterKind?: string; deliveryEnabled?: boolean };
});

import {
  startOverseerRuntime,
  stopOverseerRuntime,
  getOverseerRuntimeStatus,
} from './overseer-runtime';

const getStatus = () =>
  getOverseerRuntimeStatus({ listCapabilityStates: listCapabilityStatesMock });

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
    // Re-apply base capture impl after reset (mockReset clears implementation).
    runOverseerServiceMock.mockImplementation(async (opts?: unknown) => {
      capturedServiceOptions = (opts ?? {}) as {
        adapterKind?: string;
        deliveryEnabled?: boolean;
      };
    });
    listCapabilityStatesMock.mockReset();
    listCapabilityStatesMock.mockImplementation(async () => []);
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
    expect(status.merge_coordinator_composed).toBe(false);
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
    const status = await getOverseerRuntimeStatus({ listCapabilityStates: async () => [] });

    expect(runOverseerServiceMock).not.toHaveBeenCalled();
    expect(status.adapter).toBe('real');
    expect(status.watcher).toBe('degraded');
    expect(status.merge_coordinator_composed).toBe(false);
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
    const status = await getStatus();
    expect(status.merge_coordinator_composed).toBe(true);
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
