/**
 * conductor.test.ts -- Test scenario 1: conductor ruleset-based entry tier selection.
 *
 * Uses inline stub rulesets (does NOT read config files from disk).
 * Asserts the return value of pickEntryTier() directly.
 *
 * Test 1a: woClass=CODE + tags=["mechanical"] -> "glm"
 * Test 1b: tags=["auth"] -> "claude"
 */

import { describe, test, expect } from 'bun:test';
import { pickEntryTier } from '../conductor.js';
import type { ConductorRuleset } from '../types.js';

// Inline stub ruleset -- mirrors structure of config/ruleset.config.json
const stubRuleset: ConductorRuleset = {
  defaultEntry: 'glm',
  rules: [
    {
      match: { tags: ['billing', 'money', 'payment', 'stripe'] },
      entry: 'claude',
    },
    {
      match: { tags: ['auth', 'oauth', 'security'] },
      entry: 'claude',
    },
    {
      match: { woClass: 'INFRA' },
      entry: 'claude',
    },
    {
      match: { woClass: 'CODE', tags: ['mechanical'] },
      entry: 'glm',
    },
    {
      match: { woClass: 'CODE' },
      entry: 'glm',
    },
  ],
};

describe('conductor -- pickEntryTier', () => {
  test('Test 1a: woClass=CODE + tags=[mechanical] -> glm (cheapest entry for mechanical work)', () => {
    const result = pickEntryTier({ woClass: 'CODE', tags: ['mechanical'] }, stubRuleset);
    expect(result).toBe('glm');
  });

  test('Test 1b: tags=[auth] -> claude (security-sensitive work skips cheap tiers)', () => {
    const result = pickEntryTier({ tags: ['auth'] }, stubRuleset);
    expect(result).toBe('claude');
  });

  test('billing tag -> claude', () => {
    const result = pickEntryTier({ tags: ['billing'] }, stubRuleset);
    expect(result).toBe('claude');
  });

  test('INFRA class -> claude', () => {
    const result = pickEntryTier({ woClass: 'INFRA' }, stubRuleset);
    expect(result).toBe('claude');
  });

  test('CODE class, no special tags -> glm (default for CODE)', () => {
    const result = pickEntryTier({ woClass: 'CODE', tags: ['ui-tweak'] }, stubRuleset);
    expect(result).toBe('glm');
  });

  test('no class, no tags -> defaultEntry (glm)', () => {
    const result = pickEntryTier({}, stubRuleset);
    expect(result).toBe('glm');
  });

  test('rules fire in order; first match wins', () => {
    // auth comes before CODE/mechanical in the ruleset, so auth wins
    const result = pickEntryTier({ woClass: 'CODE', tags: ['mechanical', 'auth'] }, stubRuleset);
    expect(result).toBe('claude');
  });
});
