/**
 * Test 10 (WO-HARNESS-MERGE-SWEEP-LIVENESS-AND-PAGING-01): the deadline helper
 * times out, cleans up its timer, aborts the signal it handed out, and swallows
 * a late rejection from the abandoned promise.
 */
import { describe, expect, test } from 'bun:test';
import { BoundedAwaitTimeoutError, withBoundedAwait } from '../bounded-await.ts';

describe('withBoundedAwait', () => {
  test('Test 10: times out with a labelled error, cleans up, and swallows late rejections', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    // Track every timer the helper arms so "no live timer" is asserted, not assumed.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed = new Set<unknown>();
    globalThis.setTimeout = ((fn: () => void, ms?: number): unknown => {
      const handle = realSetTimeout(fn, ms);
      armed.add(handle);
      return handle;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle: unknown): void => {
      armed.delete(handle);
      realClearTimeout(handle as ReturnType<typeof setTimeout>);
    }) as unknown as typeof clearTimeout;

    try {
      // 1. Slow: rejects 100 ms after a 20 ms deadline.
      let slowSignal: AbortSignal | undefined;
      let timeoutCallbackLabel: string | undefined;
      const slow = withBoundedAwait(
        'test.slow',
        20,
        signal => {
          slowSignal = signal;
          return new Promise<string>((_, reject) => {
            realSetTimeout(() => reject(new Error('late_failure')), 100);
          });
        },
        { onTimeout: error => (timeoutCallbackLabel = error.label) }
      );
      let caught: unknown;
      try {
        await slow;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BoundedAwaitTimeoutError);
      const timeoutError = caught as BoundedAwaitTimeoutError;
      expect(timeoutError.label).toBe('test.slow');
      expect(timeoutError.timeoutMs).toBe(20);
      expect(timeoutError.message).toContain('test.slow');
      expect(slowSignal?.aborted).toBe(true);
      expect(timeoutCallbackLabel).toBe('test.slow');

      // Let the abandoned promise reject and give the runtime a turn to report it.
      await new Promise<void>(resolve => realSetTimeout(resolve, 150));
      expect(unhandled).toHaveLength(0);

      // 2. Fast: resolves in time, returns its value, leaves no timer.
      const before = armed.size;
      const fast = await withBoundedAwait('test.fast', 1000, () => Promise.resolve('value'));
      expect(fast).toBe('value');
      expect(armed.size).toBe(before);

      // 3. Synchronous throw rejects with the original error and leaves no timer.
      const original = new Error('sync_boom');
      let syncCaught: unknown;
      try {
        await withBoundedAwait('test.sync', 1000, () => {
          throw original;
        });
      } catch (error) {
        syncCaught = error;
      }
      expect(syncCaught).toBe(original);
      expect(armed.size).toBe(before);

      // 4. A rejection inside the deadline passes through unchanged.
      const inner = new Error('inner_fail');
      let innerCaught: unknown;
      try {
        await withBoundedAwait('test.reject', 1000, () => Promise.reject(inner));
      } catch (error) {
        innerCaught = error;
      }
      expect(innerCaught).toBe(inner);
      expect(armed.size).toBe(before);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
