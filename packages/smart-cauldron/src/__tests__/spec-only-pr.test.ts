import { describe, expect, test } from 'bun:test';
import { isSpecOnlyFileList } from '@archon/smart-cauldron/spec-only-pr';

describe('isSpecOnlyFileList', () => {
  const woId = 'WO-TEST-CLAIM-01';
  const specPath = 'docs/work-orders/WO-TEST-CLAIM-01.md';
  const superpowersPath = 'docs/superpowers/specs/WO-TEST-CLAIM-01.md';

  test('accepts the exact work-order spec path', () => {
    expect(isSpecOnlyFileList(woId, [{ filename: specPath }])).toBe(true);
  });

  test('accepts the exact superpowers spec path', () => {
    expect(isSpecOnlyFileList(woId, [{ filename: superpowersPath }])).toBe(true);
  });

  test('accepts both spec paths for this WO', () => {
    expect(isSpecOnlyFileList(woId, [{ filename: specPath }, { filename: superpowersPath }])).toBe(
      true
    );
  });

  test('accepts a rename between this WO spec paths', () => {
    expect(
      isSpecOnlyFileList(woId, [{ filename: specPath, previous_filename: superpowersPath }])
    ).toBe(true);
  });

  test.each([
    'src/feature.ts',
    'docs/work-orders/WO-TEST-CLAIM-010.md',
    'docs/superpowers/specs/WO-TEST-CLAIM-010.md',
    'docs/work-orders/wo-test-claim-01.md',
    'docs/work-orders/WO-TEST-CLAIM-01.md.bak',
    './docs/work-orders/WO-TEST-CLAIM-01.md',
  ])('rejects the non-exact path %s', filename => {
    expect(isSpecOnlyFileList(woId, [{ filename }])).toBe(false);
  });

  test('rejects any product file alongside the spec', () => {
    expect(isSpecOnlyFileList(woId, [{ filename: specPath }, { filename: 'src/feature.ts' }])).toBe(
      false
    );
  });

  test('rejects a rename into the spec from a product file', () => {
    expect(
      isSpecOnlyFileList(woId, [{ filename: specPath, previous_filename: 'src/feature.ts' }])
    ).toBe(false);
  });

  test('rejects a rename out of the spec to a product file', () => {
    expect(
      isSpecOnlyFileList(woId, [{ filename: 'src/feature.ts', previous_filename: specPath }])
    ).toBe(false);
  });

  test('rejects a rename from another WO spec with a shared prefix', () => {
    expect(
      isSpecOnlyFileList(woId, [
        { filename: specPath, previous_filename: 'docs/work-orders/WO-TEST-CLAIM-010.md' },
      ])
    ).toBe(false);
  });

  test.each([
    ['empty list', []],
    ['null list', null],
    ['non-array list', {}],
    ['null entry', [null]],
    ['missing filename', [{}]],
    ['non-string filename', [{ filename: 1 }]],
    ['malformed rename source', [{ filename: specPath, previous_filename: null }]],
    ['malformed entry after a valid spec', [{ filename: specPath }, {}]],
  ])('rejects %s', (_name, entries) => {
    expect(isSpecOnlyFileList(woId, entries)).toBe(false);
  });
});
