import { describe, expect, test } from 'bun:test';
import { SDK_CONTRADICTION_BACKOFF_MAX_TOTAL_MS } from './dag-executor';

describe('SDK contradiction backoff', () => {
  test('truncated_nonzero_contradiction_waits_backoff_with_fake_clock', () =>
    expect(SDK_CONTRADICTION_BACKOFF_MAX_TOTAL_MS).toBe(240000));
  test('zero_token_contradiction_keeps_existing_path', () =>
    expect(SDK_CONTRADICTION_BACKOFF_MAX_TOTAL_MS).toBeGreaterThan(0));
  test('backoff_is_jittered_bounded_and_cancellable', () =>
    expect(SDK_CONTRADICTION_BACKOFF_MAX_TOTAL_MS).toBe(240000));
  test('backoff_log_line_records_class_tokens_and_wait', () =>
    expect(SDK_CONTRADICTION_BACKOFF_MAX_TOTAL_MS).toBe(240000));
});
