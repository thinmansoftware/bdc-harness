import { expect, test } from 'bun:test';
import {
  computeFrontierCost,
  FRONTIER_INPUT_RATE_PER_TOKEN,
  FRONTIER_MODEL_ID,
  FRONTIER_OUTPUT_RATE_PER_TOKEN,
} from './model-rates';

test('Opus 5.5 is the default frontier model with its list rates', () => {
  expect(FRONTIER_MODEL_ID).toBe('claude-opus-5-5');
  expect(FRONTIER_INPUT_RATE_PER_TOKEN).toBe(0.000004);
  expect(FRONTIER_OUTPUT_RATE_PER_TOKEN).toBe(0.00002);
  expect(computeFrontierCost({ input: 1_000_000, output: 1_000_000 })).toBe(24);
});
