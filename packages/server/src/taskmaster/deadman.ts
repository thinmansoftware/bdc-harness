/**
 * Taskmaster tick heartbeat / dead-man state (WO-HARNESS-TASKMASTER-SLICE1-01).
 *
 * Written by loop.ts on every tick and surfaced on GET /api/taskmaster/status
 * as `tick_health`. Degrades after 3 missed intervals.
 *
 * This module is the OBSERVED side only. The EXTERNAL checker required by
 * binding condition 5 lives in the Overseer package
 * (packages/overseer/src/taskmaster-deadman-check.ts) -- a health value the
 * Taskmaster observes about itself does not satisfy Q4.
 */

export type TickHealth = 'healthy' | 'degraded' | 'not_running';

export interface DeadmanState {
  intervalMs: number;
  startedAtMs: number | null;
  lastTickAtMs: number | null;
}

/** Missed-interval count at which the tick is considered stale. */
export const DEADMAN_MISSED_INTERVALS = 3;

export function createDeadmanState(intervalMs: number): DeadmanState {
  return { intervalMs, startedAtMs: null, lastTickAtMs: null };
}

/** Record scheduler activity without claiming that the tick succeeded. */
export function recordTickAttempt(state: DeadmanState, nowMs: number): void {
  if (state.startedAtMs === null) state.startedAtMs = nowMs;
}

/** Record a tick heartbeat. Recovery re-arms automatically. */
export function recordTickHeartbeat(state: DeadmanState, nowMs: number): void {
  if (state.startedAtMs === null) state.startedAtMs = nowMs;
  state.lastTickAtMs = nowMs;
}

/**
 * True when the last heartbeat is at least DEADMAN_MISSED_INTERVALS
 * intervals old. Two missed intervals are still healthy; three are stale.
 */
export function isTickStale(state: DeadmanState, nowMs: number): boolean {
  if (state.intervalMs <= 0) return false; // KILLED: no tick expected
  const anchor = state.lastTickAtMs ?? state.startedAtMs;
  if (anchor === null) return false;
  return nowMs - anchor >= DEADMAN_MISSED_INTERVALS * state.intervalMs;
}

export function tickHealth(state: DeadmanState, nowMs: number): TickHealth {
  if (state.intervalMs <= 0 || state.startedAtMs === null) return 'not_running';
  return isTickStale(state, nowMs) ? 'degraded' : 'healthy';
}
