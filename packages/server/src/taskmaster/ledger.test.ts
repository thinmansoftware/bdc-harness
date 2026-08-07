import { describe, expect, test } from 'bun:test';
import { currentHeadroom, type Headroom } from './ledger';

describe('ledger.currentHeadroom', () => {
  test('meter failure returns UNKNOWN, never 0 (both sources throw)', async () => {
    const samples: Array<{ is_unknown?: boolean }> = [];
    const headroom = await currentHeadroom({
      readLocalArtifacts: async () => {
        throw new Error('artifact read failed');
      },
      sampleCliAnchor: async () => {
        throw new Error('cli anchor failed');
      },
      recordUsageSample: async input => {
        samples.push(input);
      },
    });

    expect(headroom.state).toBe('UNKNOWN');
    // is_unknown persisted for the audit trail.
    expect(samples.some(s => s.is_unknown === true)).toBe(true);

    // ANTI-ASSERTION (Section 12.5): treating a failed meter as 0 capacity is a bug.
    // This deliberately-added assertion MUST fail, proving UNKNOWN is not 0.
    const asZero = headroom as Headroom & { value?: number };
    expect(asZero.value === 0).toBe(false);
    if (headroom.state === 'UNKNOWN') {
      expect(headroom.isUnknown).toBe(true);
    }
  });

  test('returns OK with a numeric value when a source succeeds', async () => {
    const headroom = await currentHeadroom({
      readLocalArtifacts: async () => 5,
      sampleCliAnchor: async () => 9,
    });
    expect(headroom.state).toBe('OK');
    if (headroom.state === 'OK') {
      expect(headroom.value).toBe(5); // conservative min of readings
    }
  });

  test('one source failing still yields OK from the surviving source (not UNKNOWN)', async () => {
    const headroom = await currentHeadroom({
      readLocalArtifacts: async () => {
        throw new Error('local failed');
      },
      sampleCliAnchor: async () => 7,
    });
    expect(headroom.state).toBe('OK');
    if (headroom.state === 'OK') expect(headroom.value).toBe(7);
  });
});
