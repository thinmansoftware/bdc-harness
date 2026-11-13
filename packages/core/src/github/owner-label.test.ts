import { describe, expect, test } from 'bun:test';
import { isValidGithubLogin, listOwnerLabels, parseOwnerLabel } from './owner-label';

// WO-HARNESS-OVERSEER-OWNER-ROUTING-01 Test 1 (label half): listOwnerLabels
// returns every valid owner:<login> suffix, deduplicated case-insensitively.
describe('listOwnerLabels', () => {
  test('Test 1: returns every valid owner login in label order', () => {
    expect(listOwnerLabels(['owner:codex'])).toEqual(['codex']);
    expect(listOwnerLabels(['owner:codex', 'owner:cursor'])).toEqual(['codex', 'cursor']);
    expect(listOwnerLabels(['owner:Codex', 'owner:codex'])).toEqual(['Codex']);
    expect(listOwnerLabels(['owner:user @team'])).toEqual([]);
  });

  test('ignores non-owner labels and invalid suffixes', () => {
    expect(listOwnerLabels(['wo', 'P1', 'status:building'])).toEqual([]);
    expect(listOwnerLabels(['owner:', 'owner:-x', 'owner:a.b', 'OWNER: grok '])).toEqual(['grok']);
    expect(listOwnerLabels([])).toEqual([]);
  });
});

// The moved functions keep their exact behavior (the server re-export tests
// in packages/server/src/taskmaster/escalation-delivery.test.ts cover the rest).
describe('moved owner-label parsing', () => {
  test('parseOwnerLabel returns the first valid login only', () => {
    expect(parseOwnerLabel(JSON.stringify(['owner:user @team', 'owner:major-build']))).toBe(
      'major-build'
    );
    expect(parseOwnerLabel(JSON.stringify(['owner:codex', 'owner:cursor']))).toBe('codex');
    expect(parseOwnerLabel('not json')).toBeNull();
    expect(parseOwnerLabel(null)).toBeNull();
  });

  test('isValidGithubLogin accepts one login only', () => {
    expect(isValidGithubLogin('major-build')).toBe(true);
    expect(isValidGithubLogin('user @team')).toBe(false);
    expect(isValidGithubLogin(undefined)).toBe(false);
  });
});
