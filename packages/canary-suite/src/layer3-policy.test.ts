import { expect, test } from 'bun:test';
import { isHealthyVerdict, verdictForStaticOnly } from './layer3-policy';

test('static-only is not healthy', () => {
  expect(verdictForStaticOnly()).toBe('static_only');
  expect(isHealthyVerdict('static_only')).toBe(false);
  expect(isHealthyVerdict('probe_passed')).toBe(true);
});
