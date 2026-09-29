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

  test('healthy over-threshold claude yields codex and legacy calls stay unchanged', () => {
    const ok = {
      state: 'OK' as const,
      tokensRemaining: 1000,
      isUnknown: false,
      source: 'local_artifacts' as const,
      observedAt: '2026-08-27T00:00:00Z',
    };
    expect(decideFireLane(ok, {}, { claude: true })).toEqual({
      lane: 'codex',
      holding: false,
      reason: 'codex:unknown',
    });
    expect(decideFireLane(ok, {})).toEqual({
      lane: 'claude',
      holding: false,
      reason: 'claude:healthy',
    });
    expect(decideFireLane(unknown, {})).toEqual({
      lane: 'codex',
      holding: false,
      reason: 'codex:unknown',
    });
    expect(
      decideFireLane({ ...unknown, state: 'LOW' }, { codex: sample('codex', 'healthy') })
    ).toEqual({ lane: 'codex', holding: false, reason: 'codex:healthy' });
    expect(
      decideFireLane(
        { ...unknown, state: 'LOW' },
        { codex: sample('codex', 'degraded'), xai: sample('xai', 'dark') }
      )
    ).toEqual({ lane: null, holding: true, reason: 'all_lanes_degraded_or_unavailable' });
  });

  test('claude and codex over threshold holds every lane', () => {
    const ok = {
      state: 'OK' as const,
      tokensRemaining: 1000,
      isUnknown: false,
      source: 'local_artifacts' as const,
      observedAt: '2026-08-27T00:00:00Z',
    };
    expect(decideFireLane(ok, {}, { claude: true, codex: true })).toEqual({
      lane: null,
      holding: true,
      reason: 'all_lanes_degraded_or_unavailable',
    });
  });
});
