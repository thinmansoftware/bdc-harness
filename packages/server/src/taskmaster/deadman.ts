/**
 * Taskmaster Slice 1 -- tick heartbeat / dead-man (WO-HARNESS-TASKMASTER-SLICE1-01).
 *
 * loop.ts records a heartbeat on every successful tick. The status route surfaces
 * tick_health derived from the last heartbeat. Health degrades after 3 missed
 * intervals and RE-ARMS on the next heartbeat.
 *
 * IMPORTANT (binding condition 5, Q4): a health row the Taskmaster observes about
 * ITSELF does not satisfy the dead-man requirement. The AUTHORITATIVE external
 * checker lives in the Overseer package (taskmaster-deadman-check.ts) and polls
 * the status endpoint. This module only produces the signal it reads.
 */

export type TickHealth = 'healthy' | 'degraded';

/** Number of missed intervals before the tick is considered degraded. */
export const DEGRADE_AFTER_INTERVALS = 3;

let lastHeartbeatAt: number | null = null;

/** Record a successful tick heartbeat at `nowMs`. Re-arms a degraded signal. */
export function recordTickHeartbeat(nowMs: number): void {
  lastHeartbeatAt = nowMs;
}

/** Last heartbeat epoch ms, or null if the loop has never ticked this process. */
export function getLastHeartbeat(): number | null {
  return lastHeartbeatAt;
}

/** Test-only: clear the module heartbeat so cases start from a known state. */
export function resetHeartbeat(): void {
  lastHeartbeatAt = null;
}

/**
 * Pure staleness check. Stale once `nowMs - lastBeatAtMs >= 3 * intervalMs`.
 * A null heartbeat (never armed) is NOT stale -- the loop has not started ticking.
 */
export function isTickStale(
  lastBeatAtMs: number | null,
  nowMs: number,
  intervalMs: number
): boolean {
  if (lastBeatAtMs === null) return false;
  return nowMs - lastBeatAtMs >= DEGRADE_AFTER_INTERVALS * intervalMs;
}

/** Derive tick health from the last heartbeat. */
export function tickHealth(
  lastBeatAtMs: number | null,
  nowMs: number,
  intervalMs: number
): TickHealth {
  return isTickStale(lastBeatAtMs, nowMs, intervalMs) ? 'degraded' : 'healthy';
}
