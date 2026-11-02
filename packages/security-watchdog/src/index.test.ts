import { describe, expect, test } from 'bun:test';
import { reduceFindings, runScan } from './index';
import { fixtureBaseline } from './test-fixtures';

describe('public exports', () => {
  test('exports callable runner and reducer entry points', () => {
    expect(typeof runScan).toBe('function');
    expect(reduceFindings([], fixtureBaseline, 'run').verdict).toBe('CLEAN');
  });
});
