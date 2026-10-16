import { describe, test, expect } from 'bun:test';
import {
  assertTeeTimeProvider,
  assertTeeTimeAuthority,
  assertTeeTimeRunPolicy,
  resolveTeeTimePolicy,
  teeTimeRunPolicy,
  policyDigest,
  TEE_TIME_REPOSITORY,
} from './tee-time-policy';

describe('tee-time immutable policy', () => {
  test('frozen WO must match selected policy, including absent authority', () => {
    const policy = teeTimeRunPolicy('registered', 'digest', 'WO-TEETIME-FOUNDATION-01');
    expect(() => assertTeeTimeAuthority(policy, null)).toThrow('frozen authority');
    expect(() => assertTeeTimeAuthority(policy, { woId: 'WO-OTHER-01' })).toThrow(
      'frozen authority'
    );
    expect(() =>
      assertTeeTimeAuthority(policy, { woId: 'WO-TEETIME-FOUNDATION-01' })
    ).not.toThrow();
    expect(() => assertTeeTimeAuthority(null, null)).not.toThrow();
  });
  const codebase = {
    id: 'registered',
    name: TEE_TIME_REPOSITORY,
    repository_url: `https://github.com/${TEE_TIME_REPOSITORY}.git`,
  };
  test('stored name and remote must both match', () => {
    expect(resolveTeeTimePolicy(codebase, 'WO-TEETIME-FOUNDATION-01')).toBe(true);
    expect(() => resolveTeeTimePolicy({ ...codebase, name: 'other' }, '')).toThrow('identity');
    expect(() =>
      resolveTeeTimePolicy({ ...codebase, repository_url: 'https://github.com/other/repo' }, '')
    ).toThrow('identity');
    expect(() => resolveTeeTimePolicy(null, 'WO-TEETIME-FOUNDATION-01')).toThrow('identity');
  });
  test('unrelated identity preserves existing policy', () => {
    expect(resolveTeeTimePolicy(null, 'unrelated work')).toBe(false);
  });
  test.each(['claude', 'fable', 'codex', 'glm', 'opr', 'codex-opr', 'unknown'])(
    'rejects unsafe factory %s',
    provider => {
      expect(() => assertTeeTimeProvider(provider, undefined, false)).toThrow('provider');
    }
  );
  test('missing and aliased models are rejected', () => {
    expect(() => assertTeeTimeProvider('cursor')).toThrow('model');
    expect(() => assertTeeTimeProvider('codex-native-strict', 'claude-opus')).toThrow('model');
    expect(() => assertTeeTimeProvider('codex-native-strict', 'gpt-5.6-sol')).not.toThrow();
  });
  test('resume never silently upgrades missing or modified policy', () => {
    const expected = teeTimeRunPolicy('registered', 'reviewed-digest', 'WO-TEETIME-FOUNDATION-01');
    expect(() => assertTeeTimeRunPolicy(undefined, expected)).toThrow('persisted');
    expect(() => assertTeeTimeRunPolicy({ ...expected, codebaseId: 'other' }, expected)).toThrow(
      'persisted'
    );
    expect(() => assertTeeTimeRunPolicy({ ...expected }, expected)).not.toThrow();
  });
  test('definition digest detects changed shell content without depending on key order', () => {
    expect(policyDigest({ a: 1, b: 2 })).toBe(policyDigest({ b: 2, a: 1 }));
    expect(policyDigest({ bash: 'true' })).not.toBe(policyDigest({ bash: 'claude' }));
  });
});
