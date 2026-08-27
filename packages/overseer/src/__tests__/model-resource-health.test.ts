import { describe, expect, test } from 'bun:test';
import {
  getModelResourceHealth,
  recordSpawnOutcome,
  type ModelResourceHealthDeps,
} from '../model-resource-health.ts';
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

  test('health reads do not write health or emit signals', async () => {
    const signals: string[] = [];
    let healthWrites = 0;
    const samples = [
      sample('f3', 'failure', '2026-08-27T11:03:00.000Z'),
      sample('f2', 'failure', '2026-08-27T11:02:00.000Z'),
      sample('f1', 'failure', '2026-08-27T11:01:00.000Z'),
    ];
    const deps = {
      ...depsFor(samples, signals),
      upsertHealth: async () => {
        healthWrites += 1;
        return {} as never;
      },
    };
    await getModelResourceHealth('xai', deps);
    await getModelResourceHealth('xai', deps);
    expect(healthWrites).toBe(0);
    expect(signals).toEqual([]);
  });

  test('recording a third failure writes degraded health and emits the episode signal', async () => {
    const signals: string[] = [];
    const healthStates: string[] = [];
    const samples = [
      sample('f2', 'failure', '2026-08-27T11:02:00.000Z'),
      sample('f1', 'failure', '2026-08-27T11:01:00.000Z'),
    ];
    const deps: ModelResourceHealthDeps = {
      ...depsFor(samples, signals),
      recordSample: async data => {
        samples.unshift({
          ...sample('f3', 'failure', '2026-08-27T11:03:00.000Z'),
          provider: data.provider,
          source: data.source,
          value_json: data.value_json,
        });
        return samples[0]!;
      },
      upsertHealth: async data => {
        healthStates.push(data.state);
        return {} as never;
      },
    };
    const health = await recordSpawnOutcome(
      'grok',
      { exitCode: 1, timedOut: false },
      'judge-first',
      deps
    );
    expect(health.state).toBe('degraded');
    expect(healthStates).toEqual(['degraded']);
    expect(signals).toEqual(['model-resource-degraded:xai:f1']);
  });

  test('repeated failures in one degraded episode reuse the signal idempotency key', async () => {
    const signalKeys: string[] = [];
    const samples = [
      sample('f2', 'failure', '2026-08-27T11:02:00.000Z'),
      sample('f1', 'failure', '2026-08-27T11:01:00.000Z'),
    ];
    let nextFailure = 3;
    const deps: ModelResourceHealthDeps = {
      ...depsFor(samples),
      recordSample: async data => {
        const failure = sample(
          `f${nextFailure}`,
          'failure',
          `2026-08-27T11:0${nextFailure}:00.000Z`
        );
        nextFailure += 1;
        samples.unshift({
          ...failure,
          provider: data.provider,
          source: data.source,
          value_json: data.value_json,
        });
        return samples[0]!;
      },
      sendSignal: async data => {
        signalKeys.push(data.idempotency_key);
        return {} as never;
      },
    };

    await recordSpawnOutcome('grok', { exitCode: 1, timedOut: false }, 'judge-first', deps);
    await recordSpawnOutcome('grok', { exitCode: 1, timedOut: false }, 'judge-first', deps);

    expect(signalKeys).toEqual([
      'model-resource-degraded:xai:f1',
      'model-resource-degraded:xai:f1',
    ]);
  });
});
