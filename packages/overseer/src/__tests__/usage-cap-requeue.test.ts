import { describe, expect, test } from 'bun:test';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import { scheduleUsageCapRequeue, type UsageCapRequeueDeps } from '../actions/usage-cap-requeue';

const input = {
  woId: 'WO-USAGE-01',
  runId: 'run-usage-01',
  repository: 'bluedevilcollectibles/bdc-harness',
};

function response(headroom_state: 'OK' | 'LOW' | 'UNKNOWN'): Response {
  return new Response(JSON.stringify({ headroom_state }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function harness(headroom: 'OK' | 'LOW' | 'UNKNOWN', satisfied = false) {
  const writes: Array<Record<string, unknown>> = [];
  const byKey = new Map<string, DispatchMessage>();
  const deps: UsageCapRequeueDeps = {
    fetch: (() => Promise.resolve(response(headroom))) as typeof fetch,
    checkAlreadySatisfied: async () => satisfied,
    now: () => new Date('2026-08-11T12:00:00.000Z'),
    createTask: async data => {
      const existing = byKey.get(data.idempotency_key);
      if (existing) return existing;
      writes.push(data);
      const created = {
        id: `message-${writes.length}`,
        ...data,
        not_before: data.not_before ?? null,
      } as unknown as DispatchMessage;
      byKey.set(data.idempotency_key, created);
      return created;
    },
  };
  return { deps, writes };
}

describe('scheduleUsageCapRequeue', () => {
  test('OK headroom writes an observable ready-now Overseer record', async () => {
    const { deps, writes } = harness('OK');
    const result = await scheduleUsageCapRequeue(input, deps);

    expect(result.outcome).toBe('ready-now');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.not_before).toBeNull();
    expect(writes[0]?.idempotency_key).toBe('overseer:usage-cap-requeue:WO-USAGE-01');
    expect(writes[0]?.body).toContain('overseer_usage_cap_requeue');
    expect(writes[0]?.body).toContain('overseer-auto');
  });

  for (const state of ['LOW', 'UNKNOWN'] as const) {
    test(`${state} headroom defers rather than firing blind`, async () => {
      const { deps, writes } = harness(state);
      const result = await scheduleUsageCapRequeue(input, deps);

      expect(result.outcome).toBe('deferred');
      expect(writes).toHaveLength(1);
      expect(writes[0]?.not_before).toBe('2026-08-11T12:15:00.000Z');
      expect(writes[0]?.body).toContain(`\"headroom_state\":\"${state}\"`);
    });
  }

  test('an OPEN or MERGED PR guard records a visible skip', async () => {
    const { deps, writes } = harness('OK', true);
    const result = await scheduleUsageCapRequeue(input, deps);

    expect(result.outcome).toBe('skipped-already-satisfied');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toContain('skipped-already-satisfied');
    expect(writes[0]?.body).toContain('\"actionable\":false');
  });

  test('a repeated schedule uses the stable idempotency key', async () => {
    const { deps, writes } = harness('OK');
    const first = await scheduleUsageCapRequeue(input, deps);
    const second = await scheduleUsageCapRequeue(input, deps);

    expect(writes).toHaveLength(1);
    expect(second.message.id).toBe(first.message.id);
  });
});
