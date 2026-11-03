/**
 * conductor.test.ts -- Test scenario 1: conductor ruleset-based entry tier selection.
 *
 * Uses inline stub rulesets (does NOT read config files from disk).
 * Asserts the return value of pickEntryTier() directly.
 *
 * Test 1a: woClass=CODE + tags=["mechanical"] -> "zero"
 * Test 1b: tags=["auth"] -> "claude"
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pickEntryTier, loadRuleset } from '../conductor.js';
import type { ConductorRuleset } from '../types.js';

// Inline stub ruleset -- mirrors structure of config/ruleset.config.json,
// including the feature-scale -> codex rule (positioned above the generic
// CODE rules, same as the real config).
const stubRuleset: ConductorRuleset = {
  defaultEntry: 'codex',
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
      match: { tags: ['feature', 'net-new', 'multi-surface'] },
      entry: 'codex',
    },
    {
      match: { woClass: 'CODE', tags: ['mechanical'] },
      entry: 'zero',
    },
    {
      match: { woClass: 'CODE' },
      entry: 'codex',
    },
  ],
};

describe('conductor -- pickEntryTier', () => {
  test('Test 1a: woClass=CODE + tags=[mechanical] -> zero (exhaustion lane for mechanical work)', () => {
    const result = pickEntryTier({ woClass: 'CODE', tags: ['mechanical'] }, stubRuleset);
    expect(result).toBe('zero');
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

  test('CODE class, no special tags -> codex (default for CODE)', () => {
    const result = pickEntryTier({ woClass: 'CODE', tags: ['ui-tweak'] }, stubRuleset);
    expect(result).toBe('codex');
  });

  test('no class, no tags -> defaultEntry (codex)', () => {
    const result = pickEntryTier({}, stubRuleset);
    expect(result).toBe('codex');
  });

  test('rules fire in order; first match wins', () => {
    // auth comes before CODE/mechanical in the ruleset, so auth wins
    const result = pickEntryTier({ woClass: 'CODE', tags: ['mechanical', 'auth'] }, stubRuleset);
    expect(result).toBe('claude');
  });

  test('feature-scale rule routes to codex (skips glm entirely)', () => {
    const result = pickEntryTier({ woClass: 'CODE', tags: ['feature'] }, stubRuleset);
    expect(result).toBe('codex');
  });

  test('feature-scale rule matches ANY of its tags (net-new, multi-surface)', () => {
    expect(pickEntryTier({ woClass: 'CODE', tags: ['net-new'] }, stubRuleset)).toBe('codex');
    expect(pickEntryTier({ woClass: 'CODE', tags: ['multi-surface'] }, stubRuleset)).toBe('codex');
  });

  test('feature-scale rule appears before the generic CODE rule (first-match-wins ordering)', () => {
    // A WO tagged both "feature" and "mechanical" must route to codex, not glm --
    // proves the feature-scale rule is evaluated before the mechanical CODE rule.
    const result = pickEntryTier({ woClass: 'CODE', tags: ['feature', 'mechanical'] }, stubRuleset);
    expect(result).toBe('codex');
  });

  test('generic mechanical CODE (no feature-scale tag) still enters zero -- no regression', () => {
    const result = pickEntryTier({ woClass: 'CODE', tags: ['mechanical'] }, stubRuleset);
    expect(result).toBe('zero');
  });
});

// ---------------------------------------------------------------------------
// Test 1 (WO-HARNESS-ZERO-TIER-FENCES-AND-FLOOR-01): the LIVE ruleset routing
// table after the zero-tier flip, read from config/ruleset.config.json on disk.
// Fence 1: plain CODE -> zero; billing/auth/INFRA/feature stay cursor; mechanical
// CODE stays zero; unclassified falls through to defaultEntry (cursor).
// ---------------------------------------------------------------------------
describe('Test 1: live conductor routing table (zero-tier flip)', () => {
  const ruleset = loadRuleset();

  const cases: Array<{
    label: string;
    input: { woClass?: string; tags?: string[] };
    want: string;
  }> = [
    { label: 'CODE, no tags', input: { woClass: 'CODE', tags: [] }, want: 'zero' },
    { label: 'CODE, [billing]', input: { woClass: 'CODE', tags: ['billing'] }, want: 'cursor' },
    { label: 'CODE, [auth]', input: { woClass: 'CODE', tags: ['auth'] }, want: 'cursor' },
    { label: 'INFRA, no tags', input: { woClass: 'INFRA', tags: [] }, want: 'cursor' },
    { label: 'CODE, [feature]', input: { woClass: 'CODE', tags: ['feature'] }, want: 'cursor' },
    { label: 'CODE, [mechanical]', input: { woClass: 'CODE', tags: ['mechanical'] }, want: 'zero' },
    { label: 'no class, no tags', input: {}, want: 'cursor' },
  ];

  for (const c of cases) {
    test(`${c.label} -> ${c.want}`, () => {
      expect(pickEntryTier(c.input, ruleset)).toBe(c.want);
    });
  }

  test('defaultEntry stays cursor (unclassified)', () => {
    expect(ruleset.defaultEntry).toBe('cursor');
  });
});

// ---------------------------------------------------------------------------
// Test 2 (WO-HARNESS-ZERO-TIER-FENCES-AND-FLOOR-01, fence 2): the zero-open lane
// keeps open-model cross-review -- no node names a claude- model. Reads the live
// YAML on disk and inspects every model / fallbackModel field at the workflow
// level and on every node.
// ---------------------------------------------------------------------------
describe('Test 2: zero-open names no claude- model (fence 2)', () => {
  test('no model id on any node starts with claude-', () => {
    const yamlPath = join(
      import.meta.dir,
      '..',
      '..',
      '..',
      '..',
      '.archon',
      'workflows',
      'defaults',
      'bdc-feature-development-zero-open.yaml'
    );
    const parsed = Bun.YAML.parse(readFileSync(yamlPath, 'utf8')) as Record<string, unknown>;

    const modelIds: string[] = [];
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) collect(item);
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
          if ((key === 'model' || key === 'fallbackModel') && typeof v === 'string') {
            modelIds.push(v);
          }
          collect(v);
        }
      }
    };
    collect(parsed);

    // Sanity: the lane DOES configure models (so an empty scan cannot false-pass).
    expect(modelIds.length).toBeGreaterThan(0);
    for (const id of modelIds) {
      expect(id.startsWith('claude-')).toBe(false);
    }
  });
});
