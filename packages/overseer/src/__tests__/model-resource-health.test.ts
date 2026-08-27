import { describe, expect, test } from 'bun:test';
import { getModelResourceHealth, type ModelResourceHealthDeps } from '../model-resource-health.ts';
import type { TmUsageSample } from '@archon/core/db/taskmaster';

function sample(id: string, outcome: 'success' | 'failure', observedAt: string): TmUsageSample {
  return {
    id,
    provider: 'xai',
    window_kind: 'judge_spawn_outcome',
    source: 'judge-first',
    observed_at: observedAt,
    value_json: JSON.stringify({ exitCode: outcome === 'success' ? 0 : 1, outcome }),
    confidence: 'high',
    is_unknown: 0,
  };
}

function depsFor(samples: TmUsageSample[], signals: string[] = []): ModelResourceHealthDeps {
  return {
    getSamples: async () => samples,
    upsertHealth: async data => ({
      provider: data.provider,
      state: data.state,
      sampled_at: '2026-08-27T12:00:00.000Z',
      expires_at: data.expires_at,
      evidence: data.evidence ?? null,
    }),
    sendSignal: async data => {
      if (!signals.includes(data.idempotency_key)) signals.push(data.idempotency_key);
      return {} as never;
    },
    now: () => new Date('2026-08-27T12:00:00.000Z'),
  };
}

describe('model resource health', () => {
  test('three consecutive failures report degraded with last success', async () => {
    const health = await getModelResourceHealth(
      'xai',
      depsFor([
        sample('f3', 'failure', '2026-08-27T11:03:00.000Z'),
        sample('f2', 'failure', '2026-08-27T11:02:00.000Z'),
        sample('f1', 'failure', '2026-08-27T11:01:00.000Z'),
        sample('ok', 'success', '2026-08-27T11:00:00.000Z'),
      ])
    );
    expect(health).toMatchObject({
      state: 'degraded',
      consecutiveFailures: 3,
      lastSuccessAt: '2026-08-27T11:00:00.000Z',
    });
  });

  test('a failure followed by two real successes is healthy', async () => {
    const health = await getModelResourceHealth(
      'xai',
      depsFor([
        sample('ok2', 'success', '2026-08-27T11:02:00.000Z'),
        sample('ok1', 'success', '2026-08-27T11:01:00.000Z'),
        sample('f1', 'failure', '2026-08-27T11:00:00.000Z'),
      ])
    );
    expect(health.state).toBe('healthy');
    expect(health.consecutiveFailures).toBe(0);
  });

  test('repeated degraded reads resolve to one idempotent episode signal', async () => {
    const signals: string[] = [];
    const samples = [
      sample('f3', 'failure', '2026-08-27T11:03:00.000Z'),
      sample('f2', 'failure', '2026-08-27T11:02:00.000Z'),
      sample('f1', 'failure', '2026-08-27T11:01:00.000Z'),
    ];
    const deps = depsFor(samples, signals);
    await getModelResourceHealth('xai', deps);
    await getModelResourceHealth('xai', deps);
    expect(signals).toEqual(['model-resource-degraded:xai:f1']);
  });
});
