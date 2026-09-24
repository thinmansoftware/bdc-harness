import { describe, expect, test } from 'bun:test';
import { FRONTIER_MODEL_ID, computeFrontierCost } from './model-rates';

describe('opus-55 frontier rates', () => {
  test('FRONTIER_MODEL_ID defaults to claude-opus-5-5 and a million/million costs 24 USD', () => {
    expect(process.env.ARCHON_FRONTIER_MODEL_ID).toBeUndefined();
    expect(FRONTIER_MODEL_ID).toBe('claude-opus-5-5');
    expect(computeFrontierCost({ input: 1_000_000, output: 1_000_000 })).toBeCloseTo(24, 10);
  });
});
