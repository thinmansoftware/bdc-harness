import { describe, expect, test } from 'bun:test';
import { deriveLaneHealth, refreshLaneHealth, type LaneRun } from './lane-health';

const CURSOR = 'bdc-feature-development-cursor';
const ZERO = 'bdc-feature-development-zero-open';
const NOW = new Date('2026-10-14T00:00:00.000Z');
const DAY_MS = 86_400_000;

function ago(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function run(workflowName: string, status: string, completedAt: string | null): LaneRun {
  return { workflowName, status, completedAt };
}

describe('lane health', () => {
  test('lane_health_degraded_after_three_terminal_failures', () => {
    const runs = [
      run(CURSOR, 'failed', ago(1)),
      run(CURSOR, 'escalated', ago(2)),
      run(CURSOR, 'failed', ago(3)),
      run(CURSOR, 'completed', ago(4)),
      run(ZERO, 'completed', ago(0.5)),
    ];
    expect(deriveLaneHealth(CURSOR, runs, NOW)).toBe('degraded');
  });

  test('lane_health_healthy_with_recent_completion', () => {
    const runs = [
      run(CURSOR, 'completed', ago(2)),
      run(CURSOR, 'failed', ago(3)),
      run(CURSOR, 'escalated', ago(4)),
      run(CURSOR, 'failed', ago(5)),
      run(CURSOR, 'failed', ago(8)),
      run(ZERO, 'failed', ago(1)),
    ];
    expect(deriveLaneHealth(CURSOR, runs, NOW)).toBe('healthy');
  });

  test('lane_health_unknown_without_runs', () => {
    expect(deriveLaneHealth(CURSOR, [], NOW)).toBe('unknown');
    expect(
      deriveLaneHealth(
        CURSOR,
        [run(CURSOR, 'completed', ago(8)), run(CURSOR, 'failed', ago(9))],
        NOW
      )
    ).toBe('unknown');
  });

  test('refresh_writes_sample_only_when_none_unexpired', async () => {
    const now = new Date('2026-10-14T12:00:00.000Z');
    const upserts: Array<{
      provider: string;
      state: string;
      expires_at: string;
      evidence: string | null | undefined;
    }> = [];
    await refreshLaneHealth({
      now: () => now,
      getHealthSample: async provider => {
        if (provider !== 'cursor') return null;
        return {
          provider,
          state: 'healthy',
          sampled_at: now.toISOString(),
          expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
          evidence: null,
        };
      },
      upsertHealthSample: async data => {
        upserts.push({
          provider: data.provider,
          state: data.state,
          expires_at: data.expires_at,
          evidence: data.evidence,
        });
        return {
          provider: data.provider,
          state: data.state,
          sampled_at: now.toISOString(),
          expires_at: data.expires_at,
          evidence: data.evidence ?? null,
        };
      },
      listRuns: async () => [],
    });
    expect(upserts).toEqual([
      {
        provider: 'zero',
        state: 'unknown',
        expires_at: new Date(now.getTime() + DAY_MS).toISOString(),
        evidence: null,
      },
    ]);
  });
});
