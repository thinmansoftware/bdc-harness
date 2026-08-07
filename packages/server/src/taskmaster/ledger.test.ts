import { describe, expect, test } from 'bun:test';
import {
  ANCHOR_SAMPLE_INTERVAL_MS,
  createAnchorCadence,
  currentHeadroom,
  type LedgerDeps,
} from './ledger';
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
      anchorCadence: createAnchorCadence(),
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
      anchorCadence: createAnchorCadence(),
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
      anchorCadence: createAnchorCadence(),
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
      anchorCadence: createAnchorCadence(),
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
      anchorCadence: createAnchorCadence(),
    });
    // Zero OBSERVED is allowed -- what is forbidden is zero FABRICATED
    // from a failure. An observed zero is not UNKNOWN.
    expect(reading.state).toBe('LOW');
    expect(reading.isUnknown).toBe(false);
    expect(persist.calls[0]?.is_unknown).toBe(false);
  });
});

describe('currentHeadroom -- CLI anchor cadence (spec Section 8: startup, every 30min, after a typed-limit transition)', () => {
  const T0 = Date.parse('2026-08-07T12:00:00.000Z');

  function makeAnchor(value: number): { calls: number[]; fn: () => Promise<number | null> } {
    const calls: number[] = [];
    return {
      calls,
      fn: async (): Promise<number | null> => {
        calls.push(value);
        return value;
      },
    };
  }

  test('startup sample, then a 60s tick serves the cache; the probe re-runs only after 30 minutes', async () => {
    const persist = makePersist();
    const cadence = createAnchorCadence();
    const anchor = makeAnchor(120_000);
    let nowMs = T0;
    const deps: LedgerDeps = {
      readLocalArtifacts: async () => null,
      sampleCliAnchor: anchor.fn,
      persistSample: persist.fn,
      anchorCadence: cadence,
      now: () => new Date(nowMs),
    };

    // Startup: cadence has no prior attempt, so the anchor IS sampled.
    const first = await currentHeadroom(deps);
    expect(first.source).toBe('cli_anchor');
    expect(first.tokensRemaining).toBe(120_000);
    expect(anchor.calls.length).toBe(1);
    expect(persist.calls.length).toBe(1);

    // 60s tick cadence: within the 30-minute window the probe must NOT run
    // again; the cached observation is served and no duplicate sample row
    // is persisted.
    for (let tick = 1; tick <= 5; tick++) {
      nowMs = T0 + tick * 60_000;
      const reading = await currentHeadroom(deps);
      expect(reading.tokensRemaining).toBe(120_000);
      expect(reading.source).toBe('cli_anchor');
    }
    expect(anchor.calls.length).toBe(1);
    expect(persist.calls.length).toBe(1);

    // At 30 minutes the probe is due again.
    nowMs = T0 + ANCHOR_SAMPLE_INTERVAL_MS;
    await currentHeadroom(deps);
    expect(anchor.calls.length).toBe(2);
    expect(persist.calls.length).toBe(2);
  });

  test('a typed-limit transition forces the next reading to re-sample the anchor inside the 30-minute window', async () => {
    const persist = makePersist();
    const cadence = createAnchorCadence();
    const anchor = makeAnchor(120_000);
    let nowMs = T0;
    let artifactValue: number | null = null;
    const deps: LedgerDeps = {
      readLocalArtifacts: async () => artifactValue,
      sampleCliAnchor: anchor.fn,
      persistSample: persist.fn,
      anchorCadence: cadence,
      now: () => new Date(nowMs),
      lowWatermark: 50_000,
    };

    // Startup: anchor sampled once, state OK.
    const first = await currentHeadroom(deps);
    expect(first.state).toBe('OK');
    expect(anchor.calls.length).toBe(1);

    // A local artifact appears with LOW tokens: typed-limit transition
    // OK -> LOW (anchor untouched -- artifacts win).
    nowMs = T0 + 60_000;
    artifactValue = 10_000;
    const second = await currentHeadroom(deps);
    expect(second.state).toBe('LOW');
    expect(second.source).toBe('local_artifacts');
    expect(anchor.calls.length).toBe(1);

    // Artifact gone again, still well inside the 30-minute window: the
    // transition must force a fresh anchor sample rather than serving the
    // stale pre-transition cache.
    nowMs = T0 + 120_000;
    artifactValue = null;
    const third = await currentHeadroom(deps);
    expect(anchor.calls.length).toBe(2);
    expect(third.source).toBe('cli_anchor');
  });

  test('an un-due UNKNOWN (cached probe failure) does not spam duplicate is_unknown sample rows every tick', async () => {
    const persist = makePersist();
    const cadence = createAnchorCadence();
    let anchorCalls = 0;
    let nowMs = T0;
    const deps: LedgerDeps = {
      readLocalArtifacts: async () => null,
      sampleCliAnchor: async () => {
        anchorCalls += 1;
        return null; // unconfigured/failed probe
      },
      persistSample: persist.fn,
      anchorCadence: cadence,
      now: () => new Date(nowMs),
    };

    const first = await currentHeadroom(deps);
    expect(first.state).toBe('UNKNOWN');
    expect(anchorCalls).toBe(1);
    expect(persist.calls.length).toBe(1);
    expect(persist.calls[0]?.is_unknown).toBe(true);

    // Subsequent 60s ticks inside the window: no new probe spawn, no new
    // persisted row -- but the reading is still UNKNOWN, never 0.
    nowMs = T0 + 60_000;
    const second = await currentHeadroom(deps);
    expect(second.state).toBe('UNKNOWN');
    expect(second.tokensRemaining).toBeNull();
    expect(anchorCalls).toBe(1);
    expect(persist.calls.length).toBe(1);
  });
});
