import { expect, test } from 'bun:test';
import { staticOnlyVerdict, verdictForStaticCapability } from './layer3-policy';

test('static-only policy never returns a healthy verdict', () => {
  expect(staticOnlyVerdict()).toBe('static_only');
  expect(verdictForStaticCapability('passed')).toBe('static_only');
  expect(verdictForStaticCapability('failed')).toBe('failed');
});
