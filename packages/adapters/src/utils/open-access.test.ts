import { describe, expect, test } from 'bun:test';
import { isOpenAccessEnabled } from './open-access';

describe('isOpenAccessEnabled', () => {
  test('true and padded mixed case enable open access', () => {
    expect(isOpenAccessEnabled('true')).toBe(true);
    expect(isOpenAccessEnabled(' TRUE ')).toBe(true);
  });

  test('anything else stays closed', () => {
    expect(isOpenAccessEnabled(undefined)).toBe(false);
    expect(isOpenAccessEnabled('')).toBe(false);
    expect(isOpenAccessEnabled('1')).toBe(false);
    expect(isOpenAccessEnabled('yes')).toBe(false);
    expect(isOpenAccessEnabled('false')).toBe(false);
  });
});
