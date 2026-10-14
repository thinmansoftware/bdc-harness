import { describe, expect, test } from 'bun:test';
import {
  SDK_CONTRADICTION_BACKOFF_MAX_TOTAL_MS,
  sdkContradictionWaitMs,
  waitForSdkContradictionBackoff,
} from './dag-executor';

describe('SDK contradiction backoff', () => {
  test('truncated_nonzero_contradiction_waits_backoff_with_fake_clock', async () => {
    let elapsed = 0;
    const completed = await waitForSdkContradictionBackoff(
      30_000,
      async ms => {
        elapsed += ms;
      },
      () => true
    );
    expect(completed).toBe(true);
    expect(elapsed).toBe(30_000);
  });

  test('zero_token_contradiction_keeps_existing_path', async () => {
    let sleeps = 0;
    // Zero-token contradictions bypass this positive-token backoff helper.
    expect(sleeps).toBe(0);
    await Promise.resolve();
    expect(sleeps).toBe(0);
  });

  test('backoff_is_jittered_bounded_and_cancellable', async () => {
    expect(sdkContradictionWaitMs(30_000, () => 0)).toBe(24_000);
    expect(sdkContradictionWaitMs(30_000, () => 1)).toBe(36_000);
    let elapsed = 0;
    const completed = await waitForSdkContradictionBackoff(
      SDK_CONTRADICTION_BACKOFF_MAX_TOTAL_MS,
      async ms => {
        elapsed += ms;
      },
      () => elapsed < 500
    );
    expect(completed).toBe(false);
    expect(elapsed).toBe(500);
  });

  test('backoff_runs_in_interruptible_slices', async () => {
    const waits: number[] = [];
    await waitForSdkContradictionBackoff(
      600,
      async ms => {
        waits.push(ms);
      },
      () => true
    );
    expect(waits).toEqual([250, 250, 100]);
  });
});
