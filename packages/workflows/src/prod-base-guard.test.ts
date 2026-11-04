/**
 * Production-base guard for spec-declared PR bases
 * (WO-HARNESS-PLAN-REVIEW-STALE-STAGING-RULE-01 amendment 1, bdc-xo #4469).
 *
 * Plan-review treats a spec-declared `Base branch:` as self-authorizing. The open-PR
 * node of every lane that honours base_branch_override must refuse a production base
 * (Rule 20 / Motion M-09). The refused list lives only in scripts/lane/prod-base-guard.sh.
 *
 * These tests run the guard block EXTRACTED FROM EACH LANE YAML, so they exercise the
 * text that ships, not a copy. Bun.spawnSync + bash; no mock.module().
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { BUNDLED_LANE_SCRIPTS } from './defaults/bundled-defaults';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const DEFAULTS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
const GUARD_SCRIPT = join(REPO_ROOT, 'scripts/lane/prod-base-guard.sh');
const LS_REMOTE_ANCHOR =
  'if ! git ls-remote --exit-code "https://github.com/${REPO}.git" "refs/heads/${BASE_BRANCH_OVERRIDE}" >/dev/null 2>&1; then';
const GUARD_START = '# Production-base guard (Rule 20 / Motion M-09)';

/** Lanes whose open-PR node honours base_branch_override. */
function overrideLanes(): string[] {
  return readdirSync(DEFAULTS_DIR)
    .filter(name => name.startsWith('bdc-feature-development') && name.endsWith('.yaml'))
    .filter(name => readFileSync(join(DEFAULTS_DIR, name), 'utf8').includes(LS_REMOTE_ANCHOR))
    .sort();
}

/** The guard block from one lane, dedented, ending just before the ls-remote check. */
function guardBlock(lane: string): string {
  const lines = readFileSync(join(DEFAULTS_DIR, lane), 'utf8').split(/\r?\n/);
  const start = lines.findIndex(
    line => line.trim() === GUARD_START + ': a spec-declared base never'
  );
  const end = lines.findIndex(line => line.trim() === LS_REMOTE_ANCHOR);
  if (start === -1 || end === -1 || end <= start) throw new Error(`guard block missing in ${lane}`);
  const indent = (lines[start] ?? '').length - (lines[start] ?? '').trimStart().length;
  return lines
    .slice(start, end)
    .map(line => line.slice(indent))
    .join('\n');
}

interface GuardRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runGuard(
  lane: string,
  repo: string,
  base: string,
  guardScript: string | null = GUARD_SCRIPT
): GuardRun {
  const dir = mkdtempSync(join(tmpdir(), 'prod-base-guard-'));
  try {
    const script = join(dir, 'run.sh');
    writeFileSync(
      script,
      [
        'set -u',
        `REPO='${repo}'`,
        `BASE_BRANCH_OVERRIDE='${base}'`,
        guardBlock(lane),
        // Stands in for the rest of the node (ls-remote, gh pr create).
        'echo PASSED_GUARD',
        '',
      ].join('\n')
    );
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
    if (guardScript) env.BDC_PROD_BASE_GUARD_SCRIPT = guardScript.replace(/\\/g, '/');
    const result = Bun.spawnSync(['bash', script.replace(/\\/g, '/')], { env });
    return {
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LANES = overrideLanes();

describe('production-base guard (bdc-xo #4469)', () => {
  it('every lane that honours base_branch_override carries the guard before ls-remote', () => {
    expect(LANES.length).toBe(10);
    for (const lane of LANES) {
      const block = guardBlock(lane);
      expect(block).toContain('bdc_refuse_production_base "$REPO" "$BASE_BRANCH_OVERRIDE"');
      expect(block).toContain('prod_base_guard_missing');
    }
  });

  it('shopops_master_refused (Test 4) in every lane', () => {
    for (const lane of LANES) {
      const run = runGuard(lane, 'thinmansoftware/shopops', 'master');
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('production_base_refused');
      expect(run.stderr).toContain('Motion M-09');
      expect(run.stdout).not.toContain('PASSED_GUARD');
    }
  });

  it('lspro_react_main_refused (Test 5) in every lane', () => {
    for (const lane of LANES) {
      const run = runGuard(lane, 'thinmansoftware/lspro-react', 'main');
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('production_base_refused');
      expect(run.stdout).not.toContain('PASSED_GUARD');
    }
  });

  it('storefront_main_refused (Test 6) in every lane', () => {
    for (const lane of LANES) {
      const run = runGuard(lane, 'thinmansoftware/shopops-storefront', 'main');
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('production_base_refused');
      expect(run.stdout).not.toContain('PASSED_GUARD');
    }
  });

  it('declared_staging_accepted (Test 7) in every lane', () => {
    for (const lane of LANES) {
      for (const repo of [
        'thinmansoftware/lspro-react',
        'thinmansoftware/shopops-storefront',
        'thinmansoftware/shopops',
      ]) {
        const run = runGuard(lane, repo, 'staging');
        expect(run.exitCode).toBe(0);
        expect(run.stdout).toContain('PASSED_GUARD');
        expect(run.stderr).toBe('');
      }
    }
  });

  it('release/ce and an unlisted repo main are accepted; matching is exact (Test 8)', () => {
    const lane = LANES[0] ?? '';
    expect(runGuard(lane, 'thinmansoftware/lspro-react', 'release/ce').stdout).toContain(
      'PASSED_GUARD'
    );
    expect(runGuard(lane, 'thinmansoftware/bdc-harness', 'main').stdout).toContain('PASSED_GUARD');
    // A different case or a longer name is a different ref, not the production base.
    expect(runGuard(lane, 'thinmansoftware/shopops', 'master-hotfix').exitCode).toBe(0);
    expect(runGuard(lane, 'thinmansoftware/shopops-api', 'master').exitCode).toBe(0);
  });

  it('a mixed-case or .git-suffixed repo is still refused; branch case stays exact', () => {
    for (const lane of LANES) {
      for (const [repo, base] of [
        ['ThinManSoftware/ShopOps', 'master'],
        ['THINMANSOFTWARE/LSPRO-REACT', 'main'],
        ['thinmansoftware/Shopops-Storefront.git', 'main'],
      ] as const) {
        const run = runGuard(lane, repo, base);
        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain('production_base_refused');
        expect(run.stdout).not.toContain('PASSED_GUARD');
      }
    }
    // A branch named Main or MASTER is a different ref; refs are case-sensitive.
    const lane = LANES[0] ?? '';
    expect(runGuard(lane, 'thinmansoftware/lspro-react', 'Main').exitCode).toBe(0);
  });

  it('guard_missing_fails_closed (Test 9) in every lane', () => {
    for (const lane of LANES) {
      const run = runGuard(lane, 'thinmansoftware/lspro-react', 'staging', null);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('prod_base_guard_missing');
      expect(run.stdout).not.toContain('PASSED_GUARD');
    }
  });

  it('the bundle ships the same guard script (Test 10)', () => {
    expect(BUNDLED_LANE_SCRIPTS['prod-base-guard.sh']).toBe(readFileSync(GUARD_SCRIPT, 'utf8'));
  });
});
