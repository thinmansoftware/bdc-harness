/**
 * External taskmaster dead-man checker tests (binding condition 5 / Q4,
 * SC8): exactly one escalation per degradation episode, re-arm on recovery.
 * Injected clock + fake fetch; no real network, no real database.
 */
import { describe, expect, test } from 'bun:test';
import {
  createDeadmanCheckerState,
  pollTaskmasterDeadman,
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
    createTask: (async (data: {
      idempotency_key: string;
      body: string;
      recipient: string;
      sender: string;
    }) => {
      escalations.push({
        idempotency_key: data.idempotency_key,
        body: data.body,
        recipient: data.recipient,
        sender: data.sender,
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
    const failingCreate = (async (data: { idempotency_key: string }) => {
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
