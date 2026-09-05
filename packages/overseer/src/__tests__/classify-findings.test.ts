import { describe, expect, test } from 'bun:test';
import { classifyFindings } from '../classify-findings';

describe('classifyFindings', () => {
  test('accepts only known machine-fixable findings', () => {
    const result = classifyFindings(
      '[high] migration-ordering: update child tenant_id before the parent\n[medium] test: add a migration regression test'
    );
    expect(result.autoFixable).toBe(true);
    expect(result.classes).toEqual(['migration-ordering', 'test']);
  });

  test('one judgment finding makes a mixed review non-auto', () => {
    const result = classifyFindings(
      '[high] lint: fix formatting\n[high] security: decide whether this authorization is acceptable'
    );
    expect(result.autoFixable).toBe(false);
    expect(result.nonAutoReasons).toContain('security');
  });

  test('fails closed for unknown findings', () => {
    const result = classifyFindings('[high] frobnicator: adjust the moon phase');
    expect(result.autoFixable).toBe(false);
    expect(result.nonAutoReasons[0]).toStartWith('unknown:');
  });
});
