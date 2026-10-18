import { describe, expect, it } from 'bun:test';
import { FRONTIER_MODEL_ID, computeFrontierCost } from './model-rates';

describe('opus-55-frontier-rates', () => {
  it('uses claude-opus-5-5 and OpenRouter list rates when the env override is unset', () => {
    const expectedId = process.env.ARCHON_FRONTIER_MODEL_ID ?? 'claude-opus-5-5';
    expect(FRONTIER_MODEL_ID).toBe(expectedId);
    if (!process.env.ARCHON_FRONTIER_MODEL_ID) {
      expect(FRONTIER_MODEL_ID).toBe('claude-opus-5-5');
    }
    // 1_000_000 * 0.000004 + 1_000_000 * 0.00002 = 4 + 20 = 24
    expect(computeFrontierCost({ input: 1_000_000, output: 1_000_000 })).toBeCloseTo(24, 6);
  });
});
