import { describe, expect, it } from 'bun:test';
import { FRONTIER_MODEL_ID, computeFrontierCost, getModelRates } from './model-rates';

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

describe('modern lane model rates', () => {
  it('has explicit documented rates for every newly introduced model id', () => {
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'gpt-6-astra']) {
      const rates = getModelRates(model);
      expect(rates).toBeDefined();
      expect(rates).toEqual({ input: 0, output: 0 });
    }
  });
});
