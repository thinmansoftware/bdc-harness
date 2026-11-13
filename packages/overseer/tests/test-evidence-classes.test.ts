import { describe, expect, test } from 'bun:test';
import { classifyError } from '../src/classify';
import { decide } from '../src/decide';

describe('blocked test evidence escalates without retry', () => {
  for (const [reason, errorClass] of [
    ['missing_tool:pytest', 'test_env_missing_tool'],
    ['runner_mismatch:node-is-bun', 'test_runner_mismatch'],
    ['timeout:1500s', 'test_timeout'],
    ['stage_repo_absent:thinmansoftware/lspro-react', 'stage_repo_absent'],
    ['tests_failed_after_repair:exhausted', 'tests_failed_after_repair'],
    ['tests_failed_after_repair:guard', 'tests_failed_after_repair'],
  ] as const) {
    test(reason, () => {
      const actual = classifyError({ message: `TESTS_BLOCKED: ${reason}` });
      expect(actual).toBe(errorClass);
      expect(decide({ errorClass: actual, attempt: 1 }).decision).toBe('escalate');
    });
  }
  test('unrelated errors retain unknown', () => {
    expect(classifyError({ message: 'unrelated' })).toBe('unknown');
  });
});
