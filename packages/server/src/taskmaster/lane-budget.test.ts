import { describe, expect, test } from 'bun:test';
import { decideFireLane } from './lane-budget';

const unknown = {
  state: 'UNKNOWN',
  tokensRemaining: null,
  isUnknown: true,
  source: 'none',
  observedAt: '2026-08-27T00:00:00Z',
} as const;
const sample = (provider: string, state: 'healthy' | 'degraded' | 'dark' | 'unknown') => ({
  provider,
  state,
  sampled_at: '',
  expires_at: '',
  evidence: null,
});

describe('lane budget', () => {
  test('UNKNOWN does not hold codex but does not spend claude or xai', () => {
    expect(decideFireLane(unknown, {}).lane).toBe('codex');
  });
  test('degraded cheapest lane downshifts and all degraded holds', () => {
    expect(
      decideFireLane({ ...unknown, state: 'LOW' }, { codex: sample('codex', 'healthy') }).lane
    ).toBe('codex');
    expect(
      decideFireLane(
        { ...unknown, state: 'LOW' },
        { codex: sample('codex', 'degraded'), xai: sample('xai', 'dark') }
      )
    ).toEqual({ lane: null, holding: true, reason: 'all_lanes_degraded_or_unavailable' });
  });
});
