import { describe, expect, test } from 'bun:test';
import { currentHeadroom, type LedgerDeps } from './ledger';
import type { recordUsageSample } from '@archon/core/db/taskmaster';

type PersistCall = Parameters<typeof recordUsageSample>[0];

function makePersist(): { calls: PersistCall[]; fn: LedgerDeps['persistSample'] } {
  const calls: PersistCall[] = [];
  const fn = (async (data: PersistCall) => {
    calls.push(data);
    return {
      id: 'sample-1',
      provider: data.provider,
      window_kind: data.window_kind,
      source: data.source,
      observed_at: new Date().toISOString(),
      value_json: data.value_json ?? null,
      confidence: data.confidence ?? null,
      is_unknown: data.is_unknown ? 1 : 0,
    };
  }) as NonNullable<LedgerDeps['persistSample']>;
  return { calls, fn };
}

describe('currentHeadroom -- Section 11 scenario 2: meter failure never becomes capacity', () => {
  test('both readers failing yields UNKNOWN with is_unknown persisted -- never 0-as-capacity', async () => {
    const persist = makePersist();
    const reading = await currentHeadroom({
      readLocalArtifacts: async () => {
        throw new Error('artifact read exploded');
      },
      sampleCliAnchor: async () => {
        throw new Error('cli anchor exploded');
      },
      persistSample: persist.fn,
    });

    expect(reading.state).toBe('UNKNOWN');
    expect(reading.isUnknown).toBe(true);
    expect(reading.tokensRemaining).toBeNull();
    // Explicit anti-assertion (spec Section 11 test 2): a failed meter must
    // NEVER be represented as numeric 0 available capacity. If someone
    // "fixes" the error path to return 0, this line fails the suite.
    expect(reading.tokensRemaining === 0).toBe(false);

    // The failure observation is persisted with is_unknown set.
    expect(persist.calls.length).toBe(1);
    const call = persist.calls[0];
    expect(call?.is_unknown).toBe(true);
    expect(call?.value_json ?? null).toBeNull();
  });

  test('readers returning null (absent artifact, unconfigured anchor) also yield UNKNOWN', async () => {
    const persist = makePersist();
    const reading = await currentHeadroom({
      readLocalArtifacts: async () => null,
      sampleCliAnchor: async () => null,
      persistSample: persist.fn,
    });
    expect(reading.state).toBe('UNKNOWN');
    expect(reading.tokensRemaining).toBeNull();
    expect(persist.calls[0]?.is_unknown).toBe(true);
  });
});

describe('currentHeadroom -- successful readings', () => {
  test('local artifact reading wins and persists with high confidence', async () => {
    const persist = makePersist();
    const reading = await currentHeadroom({
      readLocalArtifacts: async () => 200_000,
      sampleCliAnchor: async () => {
        throw new Error('should not be called when artifacts answer');
      },
      persistSample: persist.fn,
    });
    expect(reading.state).toBe('OK');
    expect(reading.tokensRemaining).toBe(200_000);
    expect(reading.source).toBe('local_artifacts');
    expect(persist.calls[0]?.is_unknown).toBe(false);
    expect(persist.calls[0]?.confidence).toBe('high');
  });

  test('cli anchor is the fallback when artifacts are absent', async () => {
    const persist = makePersist();
    const reading = await currentHeadroom({
      readLocalArtifacts: async () => null,
      sampleCliAnchor: async () => 120_000,
      persistSample: persist.fn,
    });
    expect(reading.source).toBe('cli_anchor');
    expect(reading.tokensRemaining).toBe(120_000);
  });

  test('a reading below the low watermark is LOW, and a true zero is a real observation, not an error artifact', async () => {
    const persist = makePersist();
    const reading = await currentHeadroom({
      readLocalArtifacts: async () => 0,
      sampleCliAnchor: async () => null,
      persistSample: persist.fn,
      lowWatermark: 50_000,
    });
    // Zero OBSERVED is allowed -- what is forbidden is zero FABRICATED
    // from a failure. An observed zero is not UNKNOWN.
    expect(reading.state).toBe('LOW');
    expect(reading.isUnknown).toBe(false);
    expect(persist.calls[0]?.is_unknown).toBe(false);
  });
});
