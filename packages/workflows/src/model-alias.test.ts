import { describe, it, expect, beforeEach } from 'bun:test';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isDeclaredServedMatch, resetAliasCacheForTests } from './model-alias';

// Unit tests for the alias comparison itself, independent of dag-executor
// integration. Mirrors the 4 Mode Behavior Matrix rows in
// WO-HARNESS-TELEMETRY-DECLARED-MODEL-AND-COST-01 section 6.

describe('isDeclaredServedMatch -- against the real bundled config', () => {
  beforeEach(() => {
    resetAliasCacheForTests();
  });

  it('Matrix row 1: sonnet declared, claude-sonnet-5 served -> match (alias resolution)', () => {
    expect(isDeclaredServedMatch('sonnet', 'claude-sonnet-5')).toBe(true);
  });

  it('Matrix row 2: exact-id passthrough -- glm-5.2 declared, glm-5.2 served -> match', () => {
    expect(isDeclaredServedMatch('glm-5.2', 'glm-5.2')).toBe(true);
  });

  it('Matrix row 3: silent substitution -- glm-5.2 declared, claude-sonnet-5 served -> MISMATCH', () => {
    expect(isDeclaredServedMatch('glm-5.2', 'claude-sonnet-5')).toBe(false);
  });

  it('Matrix row 4: parse-drop class -- sonnet pinned, served outside the sonnet family -> MISMATCH', () => {
    expect(isDeclaredServedMatch('sonnet', 'glm-5.2')).toBe(false);
  });

  it('haiku family resolves', () => {
    expect(isDeclaredServedMatch('haiku', 'claude-haiku-4-5')).toBe(true);
  });

  it('opus family resolves', () => {
    expect(isDeclaredServedMatch('opus', 'claude-opus-4-7')).toBe(true);
  });

  it('cross-family is a mismatch (sonnet declared, opus family served)', () => {
    expect(isDeclaredServedMatch('sonnet', 'claude-opus-4-7')).toBe(false);
  });

  it('missing served (undefined) -> no mismatch (no signal to compare)', () => {
    expect(isDeclaredServedMatch('sonnet', undefined)).toBe(true);
  });

  it('null served -> no mismatch (provider does not expose served model)', () => {
    expect(isDeclaredServedMatch('sonnet', null)).toBe(true);
  });

  it('missing declared -> no mismatch (nothing to compare against)', () => {
    expect(isDeclaredServedMatch(undefined, 'claude-sonnet-5')).toBe(true);
  });
});

describe('isDeclaredServedMatch -- config loading + validation', () => {
  let testDir: string;

  beforeEach(() => {
    resetAliasCacheForTests();
    testDir = mkdtempSync(join(tmpdir(), 'model-alias-test-'));
  });

  it('loads a custom config path and resolves families from it', () => {
    const configPath = join(testDir, 'custom-aliases.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        families: {
          'my-alias': ['exact-served-id-a', 'exact-served-id-b'],
        },
      })
    );
    expect(isDeclaredServedMatch('my-alias', 'exact-served-id-b', configPath)).toBe(true);
    expect(isDeclaredServedMatch('my-alias', 'some-other-id', configPath)).toBe(false);
  });

  it('throws on missing config file', () => {
    const configPath = join(testDir, 'does-not-exist.config.json');
    expect(() => isDeclaredServedMatch('sonnet', 'claude-sonnet-5', configPath)).toThrow();
  });

  it('throws on malformed JSON', () => {
    const configPath = join(testDir, 'malformed.config.json');
    writeFileSync(configPath, '{ not valid json');
    expect(() => isDeclaredServedMatch('sonnet', 'claude-sonnet-5', configPath)).toThrow();
  });

  it('throws when "families" is missing', () => {
    const configPath = join(testDir, 'no-families.config.json');
    writeFileSync(configPath, JSON.stringify({ notFamilies: {} }));
    expect(() => isDeclaredServedMatch('sonnet', 'claude-sonnet-5', configPath)).toThrow();
  });

  it('throws when a family value is not an array of strings', () => {
    const configPath = join(testDir, 'bad-family.config.json');
    writeFileSync(configPath, JSON.stringify({ families: { sonnet: 'not-an-array' } }));
    expect(() => isDeclaredServedMatch('sonnet', 'claude-sonnet-5', configPath)).toThrow();
  });
});
