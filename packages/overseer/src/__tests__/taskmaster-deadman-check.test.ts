/**
 * External taskmaster dead-man checker tests (binding condition 5 / Q4,
 * SC8): exactly one escalation per degradation episode, re-arm on recovery.
 * Injected clock + fake fetch; no real network, no real database.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  createDeadmanCheckerState,
  getDeadmanCheckerRuntime,
  pollTaskmasterDeadman,
  resolveDeadmanIntervalMs,
  startTaskmasterDeadmanChecker,
  stopTaskmasterDeadmanChecker,
  type DeadmanCheckerDeps,
  type TaskmasterStatusView,
} from '../taskmaster-deadman-check';

const T0 = Date.parse('2026-08-07T12:00:00.000Z');

function statusView(overrides: Partial<TaskmasterStatusView> = {}): TaskmasterStatusView {
  return {
    tick_health: 'healthy',
    pause_state: 'RUNNING',
    epoch: 0,
    last_tick_at: new Date(T0).toISOString(),
    interval_ms: 1000,
    ...overrides,
  };
}

function makeDeps(statuses: Array<TaskmasterStatusView | 'unreachable'>): {
  deps: DeadmanCheckerDeps;
  escalations: Array<{ idempotency_key: string; body: string; recipient: string; sender: string }>;
} {
  const escalations: Array<{
    idempotency_key: string;
    body: string;
    recipient: string;
    sender: string;
  }> = [];
  let index = 0;
  const deps: DeadmanCheckerDeps = {
    now: () => new Date(T0 + index * 1000),
    statusUrl: 'http://localhost:3090/api/taskmaster/status',
    operatorToken: 'test-token',
    fetch: (async () => {
      const status = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      if (status === 'unreachable') {
        throw new Error('connection refused');
      }
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
    createTask: (async (
      context: { kind: string; sender?: string },
      data: {
        idempotency_key: string;
        body: string;
        recipient: string;
      }
    ) => {
      escalations.push({
        idempotency_key: data.idempotency_key,
        body: data.body,
        recipient: data.recipient,
        sender: context.sender ?? 'overseer',
      });
      return { id: `esc-${escalations.length}`, status: 'queued' };
    }) as unknown as DeadmanCheckerDeps['createTask'],
  };
  return { deps, escalations };
}

describe('taskmaster dead-man external checker (SC8)', () => {
  test('degraded tick_health emits EXACTLY ONE escalation; a second poll while still degraded emits none', async () => {
    const degraded = statusView({ tick_health: 'degraded' });
    const { deps, escalations } = makeDeps([degraded, degraded, degraded]);
    const state = createDeadmanCheckerState();

    const first = await pollTaskmasterDeadman(state, deps);
    expect(first.tickHealth).toBe('degraded');
    expect(first.escalationSent).toBe(true);
    expect(escalations.length).toBe(1);
    expect(escalations[0]?.sender).toBe('overseer');
    expect(escalations[0]?.recipient).toBe('operator');
    expect(escalations[0]?.body).toContain('tick_health=degraded');

    const second = await pollTaskmasterDeadman(state, deps);
    expect(second.escalationSent).toBe(false);
    const third = await pollTaskmasterDeadman(state, deps);
    expect(third.escalationSent).toBe(false);
    expect(escalations.length).toBe(1);
  });

  test('recovery re-arms: healthy after degraded allows a NEW episode to escalate again', async () => {
    const degradedEp1 = statusView({
      tick_health: 'degraded',
      last_tick_at: new Date(T0 - 10_000).toISOString(),
    });
    const healthy = statusView({ tick_health: 'healthy' });
    const degradedEp2 = statusView({
      tick_health: 'degraded',
      last_tick_at: new Date(T0 + 60_000).toISOString(),
    });
    const { deps, escalations } = makeDeps([degradedEp1, healthy, degradedEp2]);
    const state = createDeadmanCheckerState();

    await pollTaskmasterDeadman(state, deps);
    expect(escalations.length).toBe(1);

    const recovered = await pollTaskmasterDeadman(state, deps);
    expect(recovered.tickHealth).toBe('healthy');
    expect(state.escalated).toBe(false);

    const again = await pollTaskmasterDeadman(state, deps);
    expect(again.escalationSent).toBe(true);
    expect(escalations.length).toBe(2);
    // Distinct episodes carry distinct idempotency keys.
    expect(escalations[0]?.idempotency_key).not.toBe(escalations[1]?.idempotency_key);
  });

  test('healthy and not_running never escalate', async () => {
    const { deps, escalations } = makeDeps([
      statusView({ tick_health: 'healthy' }),
      statusView({ tick_health: 'not_running' }),
    ]);
    const state = createDeadmanCheckerState();
    expect((await pollTaskmasterDeadman(state, deps)).escalationSent).toBe(false);
    expect((await pollTaskmasterDeadman(state, deps)).escalationSent).toBe(false);
    expect(escalations.length).toBe(0);
  });

  test('an unreachable status endpoint does not escalate (and does not crash)', async () => {
    const { deps, escalations } = makeDeps(['unreachable']);
    const state = createDeadmanCheckerState();
    const result = await pollTaskmasterDeadman(state, deps);
    expect(result.tickHealth).toBe('unreachable');
    expect(result.escalationSent).toBe(false);
    expect(escalations.length).toBe(0);
  });

  test('a failed escalation send stays un-armed so the next poll retries', async () => {
    const degraded = statusView({ tick_health: 'degraded' });
    const { deps, escalations } = makeDeps([degraded, degraded]);
    let failFirst = true;
    const failingCreate = (async (_context: unknown, data: { idempotency_key: string }) => {
      if (failFirst) {
        failFirst = false;
        throw new Error('dispatch down');
      }
      escalations.push({
        idempotency_key: data.idempotency_key,
        body: '',
        recipient: 'operator',
        sender: 'overseer',
      });
      return { id: 'esc-retry', status: 'queued' };
    }) as unknown as DeadmanCheckerDeps['createTask'];
    const state = createDeadmanCheckerState();

    const first = await pollTaskmasterDeadman(state, { ...deps, createTask: failingCreate });
    expect(first.escalationSent).toBe(false);
    expect(state.escalated).toBe(false);

    const second = await pollTaskmasterDeadman(state, { ...deps, createTask: failingCreate });
    expect(second.escalationSent).toBe(true);
    expect(escalations.length).toBe(1);
  });
});

describe('taskmaster dead-man scheduler -- production wiring (singleton timer + persistent episode state)', () => {
  afterEach(() => {
    stopTaskmasterDeadmanChecker();
  });

  test('interval env parsing: default 60000, explicit value honored, 0 = off, garbage falls back', () => {
    expect(resolveDeadmanIntervalMs(undefined)).toBe(60_000);
    expect(resolveDeadmanIntervalMs('30000')).toBe(30_000);
    expect(resolveDeadmanIntervalMs('0')).toBe(0);
    expect(resolveDeadmanIntervalMs('banana')).toBe(60_000);
    expect(resolveDeadmanIntervalMs('-5')).toBe(60_000);
  });

  test('scheduled polls share ONE persistent state: a sustained degradation escalates exactly once across many polls', async () => {
    const degraded = statusView({ tick_health: 'degraded' });
    // Every poll sees the same degraded episode.
    const { deps, escalations } = makeDeps([degraded]);
    startTaskmasterDeadmanChecker(deps, 5);

    // Wait until the timer has demonstrably polled several times.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const runtime = getDeadmanCheckerRuntime();
      if (runtime && runtime.polls >= 3) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const runtime = getDeadmanCheckerRuntime();
    expect(runtime).toBeDefined();
    expect(runtime!.polls).toBeGreaterThanOrEqual(3);
    // Persistent episode state: many polls, ONE escalation.
    expect(escalations.length).toBe(1);
    expect(runtime!.state.escalated).toBe(true);
    expect(runtime!.lastPollResult?.tickHealth).toBe('degraded');
  });

  test('start is a module-scope singleton and stop tears the runtime down', async () => {
    const { deps } = makeDeps([statusView({ tick_health: 'healthy' })]);
    startTaskmasterDeadmanChecker(deps, 60_000);
    const runtime = getDeadmanCheckerRuntime();
    expect(runtime).toBeDefined();

    // Second start while running is a no-op: same runtime object survives.
    startTaskmasterDeadmanChecker(deps, 60_000);
    expect(getDeadmanCheckerRuntime()).toBe(runtime);

    stopTaskmasterDeadmanChecker();
    expect(getDeadmanCheckerRuntime()).toBeUndefined();
  });

  test('interval 0 disables the checker entirely (no runtime, no polls)', () => {
    const { deps, escalations } = makeDeps([statusView({ tick_health: 'degraded' })]);
    startTaskmasterDeadmanChecker(deps, 0);
    expect(getDeadmanCheckerRuntime()).toBeUndefined();
    expect(escalations.length).toBe(0);
  });
});
