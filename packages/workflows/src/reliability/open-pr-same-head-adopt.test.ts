import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { runLanePrFixture } from './run-pr.test-fixture';

const LANE_FILES = [
  'bdc-feature-development.yaml',
  'bdc-feature-development-astra.yaml',
  'bdc-feature-development-codex.yaml',
  'bdc-feature-development-codex-only.yaml',
  'bdc-feature-development-cursor.yaml',
  'bdc-feature-development-fable.yaml',
  'bdc-feature-development-fusion-cx-kimi.yaml',
  'bdc-feature-development-fusion-cx-qwen.yaml',
  'bdc-feature-development-grok.yaml',
  'bdc-feature-development-kimi-k3.yaml',
  'bdc-feature-development-zero.yaml',
  'bdc-feature-development-zero-claude.yaml',
  'bdc-feature-development-zero-open.yaml',
] as const;

const DEFAULTS_DIR = join(import.meta.dir, '../../../../.archon/workflows/defaults');
const BUNDLE_PATH = join(import.meta.dir, '../defaults/bundled-defaults.generated.ts');
const GUARD_BEGIN = '# existing-pr-base-guard: begin';
const GUARD_END = '# existing-pr-base-guard: end';

function existingPrGuard(yaml: string): string {
  const text = yaml.replace(/\r\n/g, '\n');
  const at = text.indexOf(GUARD_BEGIN);
  const end = text.indexOf(GUARD_END);
  if (at < 0 || end < at) {
    throw new Error('existing-pr-base-guard markers missing');
  }
  const lineStart = text.lastIndexOf('\n', at) + 1;
  const endLine = text.lastIndexOf('\n', end);
  const chunk = text.slice(lineStart, endLine);
  const lines = chunk.split('\n');
  const widths = lines
    .filter(line => line.trim().length > 0)
    .map(line => line.length - line.trimStart().length);
  const min = Math.min(...widths);
  return lines.map(line => (line.startsWith(' '.repeat(min)) ? line.slice(min) : line)).join('\n');
}

function laneGuard(file: string): string {
  return existingPrGuard(readFileSync(join(DEFAULTS_DIR, file), 'utf8'));
}

describe('open-pr owned ancestor adoption', () => {
  for (const [name, fixtureCase] of [
    ['adopts an owned ancestor PR without a duplicate', 'own-ancestor'],
    ['an unrelated same-head branch is never adopted or modified', 'unrelated-branch'],
    ['an unrecorded wrong-base candidate is ignored without retargeting', 'wrong-base'],
    ['a different author is never adopted or modified', 'other-author'],
    ['a PR list failure refuses creation after acting identity resolves', 'api-failure'],
  ]) {
    test(
      name!,
      () => {
        const result = runLanePrFixture(fixtureCase!);
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain('PASS:');
      },
      60000
    );
  }

  test('Test 5: all lanes carry the guard and the bundle is regenerated', () => {
    expect(LANE_FILES.length).toBe(13);
    const guards = LANE_FILES.map(file => laneGuard(file));
    for (const fileGuard of guards) {
      expect(fileGuard).toBe(guards[0]);
      expect(fileGuard.split('# same-head-adopt: begin').length - 1).toBe(1);
      expect(fileGuard.split('# same-head-adopt: end').length - 1).toBe(1);
      expect(fileGuard.split(GUARD_BEGIN).length - 1).toBe(1);
    }

    const yamlNames = readdirSync(DEFAULTS_DIR)
      .filter(name => name.endsWith('.yaml'))
      .sort();
    const withGuard = yamlNames.filter(name =>
      readFileSync(join(DEFAULTS_DIR, name), 'utf8').includes('existing-pr-base-guard: begin')
    );
    const withAdopt = yamlNames.filter(name =>
      readFileSync(join(DEFAULTS_DIR, name), 'utf8').includes('same-head-adopt')
    );
    expect(withGuard).toEqual([...LANE_FILES].sort());
    expect(withAdopt).toEqual([...LANE_FILES].sort());

    const bundle = readFileSync(BUNDLE_PATH, 'utf8');
    expect(bundle.split('same-head-adopt').length - 1).toBeGreaterThan(0);
    expect(bundle).toContain('# same-head-adopt: begin');
  });
});
