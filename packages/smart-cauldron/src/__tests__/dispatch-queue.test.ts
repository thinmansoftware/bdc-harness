import { describe, expect, test } from 'bun:test';
import { DispatchQueue } from '../dispatch-queue.js';

/**
 * Deterministic coverage for the serialized FIFO dispatch queue (WO-HARNESS-
 * CASCADE-RUN-DISCOVERY-DETERMINISTIC-01, John's dispatch-queue requirement).
 * Injects the sleep + log sinks so no wall-clock time is spent and spacing /
 * depth-logging are asserted exactly.
 */
describe('DispatchQueue', () => {
  test('runs enqueued tasks strictly serially (no overlap)', async () => {
    const queue = new DispatchQueue({ spacingMs: 0 });
    let active = 0;
    let maxActive = 0;
    const makeTask = () => async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      // Yield across several microtasks to expose any overlap.
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
    };

    await Promise.all([
      queue.enqueue('a', makeTask()),
      queue.enqueue('b', makeTask()),
      queue.enqueue('c', makeTask()),
    ]);

    expect(maxActive).toBe(1);
  });

  test('preserves FIFO order regardless of per-task duration', async () => {
    const sleeps: number[] = [];
    const queue = new DispatchQueue({ spacingMs: 0, sleep: async ms => void sleeps.push(ms) });
    const order: string[] = [];
    // First task lingers longest; FIFO must still complete a, then b, then c.
    const lingering = (label: string, ticks: number) => async (): Promise<void> => {
      for (let i = 0; i < ticks; i += 1) await Promise.resolve();
      order.push(label);
    };

    await Promise.all([
      queue.enqueue('a', lingering('a', 5)),
      queue.enqueue('b', lingering('b', 1)),
      queue.enqueue('c', lingering('c', 0)),
    ]);

    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('inserts inter-fire spacing between contended fires, but not for a lone fire', async () => {
    const sleeps: number[] = [];
    const queue = new DispatchQueue({ spacingMs: 2_000, sleep: async ms => void sleeps.push(ms) });

    // Lone fire: nothing waiting behind it -> no spacing.
    await queue.enqueue('solo', async () => undefined);
    expect(sleeps).toEqual([]);

    // Burst of three: spacing precedes the 2nd and 3rd fires (2 gaps), not the 1st.
    await Promise.all([
      queue.enqueue('a', async () => undefined),
      queue.enqueue('b', async () => undefined),
      queue.enqueue('c', async () => undefined),
    ]);

    expect(sleeps).toEqual([2_000, 2_000]);
  });

  test('logs queue depth only when more than one fire is outstanding', async () => {
    const logs: string[] = [];
    const queue = new DispatchQueue({ spacingMs: 0, log: msg => void logs.push(msg) });

    // Solo fire, awaited to completion first -> depth never exceeds 1, no log.
    await queue.enqueue('solo', async () => undefined);
    expect(logs).toEqual([]);

    // Two enqueued while one is outstanding -> at least one depth>1 log line.
    await Promise.all([
      queue.enqueue('a', async () => undefined),
      queue.enqueue('b', async () => undefined),
    ]);

    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.some(line => line.includes('dispatch queue depth=2'))).toBe(true);
    expect(logs.every(line => line.startsWith('[smart-cauldron] dispatch queue depth='))).toBe(
      true
    );
  });

  test('a failing task does not break FIFO ordering or block later fires', async () => {
    const queue = new DispatchQueue({ spacingMs: 0 });
    const order: string[] = [];

    const results = await Promise.allSettled([
      queue.enqueue('boom', async () => {
        order.push('boom');
        throw new Error('fire failed');
      }),
      queue.enqueue('after', async () => {
        order.push('after');
        return 'ok';
      }),
    ]);

    expect(order).toEqual(['boom', 'after']);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'ok' });
  });

  test('surfaces the task result to the caller', async () => {
    const queue = new DispatchQueue({ spacingMs: 0 });
    const value = await queue.enqueue('r', async () => 42);
    expect(value).toBe(42);
  });
});
