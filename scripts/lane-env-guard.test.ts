/**
 * Guard for bdc-xo#5464: every place the harness starts lane code must give the child
 * an environment without the personal GitHub token names. A site that stops using the
 * helper fails this test. Behavior tests for each site live beside the site; this one
 * catches a regression a behavior test does not cover and names the sites it checked.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

const SITES: { file: string; mustContain: string[]; what: string }[] = [
  {
    file: 'packages/workflows/src/dag-executor.ts',
    mustContain: ['laneEnv({', '{ cwd, env: laneEnv() }', 'env: laneEnv(),'],
    what: 'bash node, script node, loop until-bash and evidence commands',
  },
  {
    file: 'packages/providers/src/claude/provider.ts',
    mustContain: ['return laneEnv();', 'stripPersonalTokens('],
    what: 'Claude CLI env',
  },
  {
    file: 'packages/providers/src/codex/provider.ts',
    mustContain: ['stripPersonalTokens(', 'buildCodexEnv({})'],
    what: 'Codex CLI env (default instance and per-call)',
  },
  {
    file: 'packages/providers/src/community/cursor/provider.ts',
    mustContain: ['stripPersonalTokens('],
    what: 'cursor-agent env',
  },
  {
    file: 'packages/providers/src/community/grok/tools.ts',
    mustContain: ['env: laneEnv()'],
    what: 'Grok bash tool',
  },
  {
    file: 'packages/providers/src/community/pi/options-translator.ts',
    mustContain: ['stripPersonalTokens('],
    what: 'pi bash spawnHook',
  },
];

describe('lane start sites use the lane environment (bdc-xo#5464)', () => {
  for (const site of SITES) {
    test(`${site.file}: ${site.what}`, () => {
      const text = read(site.file);
      for (const needle of site.mustContain) expect(text).toContain(needle);
    });
  }

  test('no lane start site passes process.env straight to a child', () => {
    const dag = read('packages/workflows/src/dag-executor.ts');
    expect(dag).not.toMatch(/env:\s*process\.env/);
    // bash and script nodes wrap the whole merged environment, config envVars included
    expect(dag.split('laneEnv({').length - 1).toBeGreaterThanOrEqual(2);
    expect(read('packages/providers/src/community/grok/tools.ts')).not.toMatch(
      /env:\s*process\.env/
    );
    expect(read('packages/providers/src/community/cursor/provider.ts')).not.toMatch(
      /env:\s*\{\s*\.\.\.process\.env/
    );
  });
});
