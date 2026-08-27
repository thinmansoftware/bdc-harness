import type { TmHealthSample, TmHealthState } from '@archon/core/db/taskmaster';
import type { HeadroomReading } from './ledger';

export type FireLane = 'claude' | 'codex' | 'xai';
export interface LaneBudgetDecision {
  lane: FireLane | null;
  holding: boolean;
  reason: string;
}

function claudeState(reading: HeadroomReading): TmHealthState {
  if (reading.state === 'OK') return 'healthy';
  if (reading.state === 'LOW') return 'degraded';
  return 'unknown';
}

/** Cheapest-first lane choice. UNKNOWN is deliberately lane-specific. */
export function decideFireLane(
  headroom: HeadroomReading,
  health: Partial<Record<FireLane, TmHealthSample | null>>
): LaneBudgetDecision {
  const states: Record<FireLane, TmHealthState> = {
    claude: health.claude?.state ?? claudeState(headroom),
    codex: health.codex?.state ?? 'unknown',
    xai: health.xai?.state ?? 'unknown',
  };
  for (const lane of ['claude', 'codex', 'xai'] as const) {
    const state = states[lane];
    const available = state === 'healthy' || (state === 'unknown' && lane === 'codex');
    if (available) return { lane, holding: false, reason: `${lane}:${state}` };
  }
  return { lane: null, holding: true, reason: 'all_lanes_degraded_or_unavailable' };
}
