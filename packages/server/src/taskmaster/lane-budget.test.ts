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

  test('cursor_selected_when_codex_degraded_and_cursor_healthy', () => {
    expect(
      decideFireLane(
        { ...unknown, state: 'LOW' },
        {
          codex: sample('codex', 'degraded'),
          cursor: sample('cursor', 'healthy'),
        }
      )
    ).toEqual({ lane: 'cursor', holding: false, reason: 'cursor:healthy' });
  });

  test('zero_selected_when_codex_and_cursor_degraded_and_zero_healthy', () => {
    expect(
      decideFireLane(
        { ...unknown, state: 'LOW' },
        {
          codex: sample('codex', 'degraded'),
          cursor: sample('cursor', 'degraded'),
          zero: sample('zero', 'healthy'),
        }
      ).lane
    ).toBe('zero');
  });

  test('unknown_cursor_and_zero_are_not_available', () => {
    expect(
      decideFireLane(
        { ...unknown, state: 'LOW' },
        {
          codex: sample('codex', 'degraded'),
          cursor: sample('cursor', 'unknown'),
          zero: sample('zero', 'unknown'),
          xai: sample('xai', 'dark'),
        }
      )
    ).toEqual({ lane: null, holding: true, reason: 'all_lanes_degraded_or_unavailable' });
  });

  test('lane_order_is_claude_codex_cursor_zero_xai', () => {
    const ok = {
      state: 'OK' as const,
      tokensRemaining: 1000,
      isUnknown: false,
      source: 'local_artifacts' as const,
      observedAt: '2026-08-27T00:00:00Z',
    };
    const low = { ...unknown, state: 'LOW' as const };
    const healthy = {
      codex: sample('codex', 'healthy'),
      cursor: sample('cursor', 'healthy'),
      zero: sample('zero', 'healthy'),
      xai: sample('xai', 'healthy'),
    };
    expect(decideFireLane(ok, healthy).lane).toBe('claude');
    expect(decideFireLane(low, { ...healthy, claude: sample('claude', 'degraded') }).lane).toBe(
      'codex'
    );
    expect(
      decideFireLane(low, {
        ...healthy,
        claude: sample('claude', 'degraded'),
        codex: sample('codex', 'degraded'),
      }).lane
    ).toBe('cursor');
    expect(
      decideFireLane(low, {
        ...healthy,
        claude: sample('claude', 'degraded'),
        codex: sample('codex', 'degraded'),
        cursor: sample('cursor', 'degraded'),
      }).lane
    ).toBe('zero');
  });

  test('all_degraded_still_holds', () => {
    expect(
      decideFireLane(
        { ...unknown, state: 'LOW' },
        {
          claude: sample('claude', 'degraded'),
          codex: sample('codex', 'degraded'),
          cursor: sample('cursor', 'degraded'),
          zero: sample('zero', 'degraded'),
          xai: sample('xai', 'degraded'),
        }
      )
    ).toEqual({ lane: null, holding: true, reason: 'all_lanes_degraded_or_unavailable' });
  });

  test('over_threshold_skips_cursor', () => {
    expect(
      decideFireLane(
        { ...unknown, state: 'LOW' },
        {
          codex: sample('codex', 'degraded'),
          cursor: sample('cursor', 'healthy'),
          zero: sample('zero', 'healthy'),
        },
        { cursor: true }
      ).lane
    ).toBe('zero');
  });
});
