import { describe, expect, test } from 'bun:test';
import {
  createDeadmanState,
  isTickStale,
  recordTickHeartbeat,
  tickHealth,
  DEADMAN_MISSED_INTERVALS,
} from './deadman';

const INTERVAL_MS = 1000;
const T0 = Date.parse('2026-08-07T12:00:00.000Z');

describe('taskmaster deadman', () => {
  test('never-started state is not stale and reports not_running', () => {
    const state = createDeadmanState(INTERVAL_MS);
    expect(isTickStale(state, T0)).toBe(false);
    expect(tickHealth(state, T0)).toBe('not_running');
  });

  test('2 missed intervals = healthy (fake clock)', () => {
    const state = createDeadmanState(INTERVAL_MS);
    recordTickHeartbeat(state, T0);
    const twoMissed = T0 + 2 * INTERVAL_MS + INTERVAL_MS - 1; // just under 3 intervals
    expect(isTickStale(state, twoMissed)).toBe(false);
    expect(tickHealth(state, twoMissed)).toBe('healthy');
  });

  test('3 missed intervals = degraded (fake clock)', () => {
    const state = createDeadmanState(INTERVAL_MS);
    recordTickHeartbeat(state, T0);
    const threeMissed = T0 + DEADMAN_MISSED_INTERVALS * INTERVAL_MS;
    expect(isTickStale(state, threeMissed)).toBe(true);
    expect(tickHealth(state, threeMissed)).toBe('degraded');
  });

  test('recovery re-arms: a fresh heartbeat returns to healthy', () => {
    const state = createDeadmanState(INTERVAL_MS);
    recordTickHeartbeat(state, T0);
    const degradedAt = T0 + 5 * INTERVAL_MS;
    expect(tickHealth(state, degradedAt)).toBe('degraded');
    recordTickHeartbeat(state, degradedAt);
    expect(tickHealth(state, degradedAt + INTERVAL_MS)).toBe('healthy');
    // And it can degrade again after another silence.
    expect(tickHealth(state, degradedAt + 4 * INTERVAL_MS)).toBe('degraded');
  });

  test('interval 0 (KILLED) never degrades', () => {
    const state = createDeadmanState(0);
    recordTickHeartbeat(state, T0);
    expect(isTickStale(state, T0 + 1_000_000)).toBe(false);
    expect(tickHealth(state, T0 + 1_000_000)).toBe('not_running');
  });
});
