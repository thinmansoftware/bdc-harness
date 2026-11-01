import { describe, expect, test } from 'bun:test';
import { readTrustedCheckPlan } from './review-worker-clock';

describe('trusted review check plan', () => {
  test('accepts only nonempty argv arrays', () => {
    expect(readTrustedCheckPlan('[[' + '"bun","test"' + ']]')).toEqual([['bun', 'test']]);
    expect(readTrustedCheckPlan('[]')).toEqual([]);
    expect(readTrustedCheckPlan('[["sh","-c","touch /tmp/pwned"]]')).toEqual([]);
  });
  test('rejects malformed and NUL-bearing plans', () => {
    expect(readTrustedCheckPlan('not-json')).toEqual([]);
    expect(readTrustedCheckPlan('[["bun","a\\u0000b"]]')).toEqual([]);
  });
});
