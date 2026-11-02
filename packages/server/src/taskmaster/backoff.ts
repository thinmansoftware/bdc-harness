import type { TmJournalEntry } from '@archon/core/db/taskmaster';

export const FIRE_BACKOFF_TICKS = [4, 8, 16, 32, 64, 96] as const;
export interface FireBackoffDecision {
  kind: 'ready' | 'backoff' | 'escalate';
  retryAtTick?: number;
}

/** Derive monotonic per-item retry state from durable failed fire rows. */
export function fireBackoffDecision(
  rows: readonly TmJournalEntry[],
  threadRef: string,
  tickIndex: number,
  intervalMs: number,
  nowMs: number
): FireBackoffDecision {
  const failures = rows
    .filter(
      r => r.thread_ref === threadRef && r.action_type === 'fire_cauldron' && r.outcome === 'failed'
    )
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (failures.length === 0) return { kind: 'ready' };
  if (failures.length > FIRE_BACKOFF_TICKS.length) return { kind: 'escalate' };
  const delay = FIRE_BACKOFF_TICKS[failures.length - 1] ?? 96;
  const lastFailure = failures.at(-1);
  if (!lastFailure) return { kind: 'ready' };
  const lastMs = Date.parse(lastFailure.created_at);
  const ticksElapsed = Math.max(0, Math.floor((nowMs - lastMs) / intervalMs));
  return ticksElapsed >= delay
    ? { kind: 'ready' }
    : { kind: 'backoff', retryAtTick: tickIndex + delay - ticksElapsed };
}
