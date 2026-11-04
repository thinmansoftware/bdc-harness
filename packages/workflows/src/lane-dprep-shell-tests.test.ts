import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Fix A3 (Cauldron runs dcb97aeb, 860c61e2 on thinmansoftware/comicstoreos-provisioner):
// the lane dprep core skipped package-lock.json repos, so every test failed with
// ERR_MODULE_NOT_FOUND, and resolve-test-command reported
// TESTS_MAP_FALLBACK=invalid-origin because a token-bearing origin URL did not
// normalize. dprep now lives in scripts/lane/dprep.sh and every lane sources it.
//
// The behavioral coverage is the shell suite
// .archon/workflows/defaults/__tests__/run-stop-tests.sh (stubbed bun/pnpm/npm on
// PATH, and the real resolve-test-command bash run against a stub gh). Before this
// file that suite was not run by CI; this test runs it so CI enforces it.

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
const SHARED_DPREP = join(REPO_ROOT, 'scripts/lane/dprep.sh');
const SUITE = join(LANES_DIR, '__tests__/run-stop-tests.sh');

const LANES = readdirSync(LANES_DIR)
  .filter(f => /^bdc-feature-development(-[a-z0-9-]+)?\.yaml$/.test(f))
  .sort();

describe('lane dprep shared script wiring', () => {
  it('covers all 13 bdc-feature-development lanes', () => {
    expect(LANES.length).toBe(13);
  });

  it('ships scripts/lane/dprep.sh with the npm ci branch', () => {
    expect(existsSync(SHARED_DPREP)).toBe(true);
    const body = readFileSync(SHARED_DPREP, 'utf-8');
    expect(body).toContain('dprep_ensure_js_deps()');
    expect(body).toContain('npm ci --no-audit --no-fund');
    expect(body).toContain("'npm ci (package-lock.json)'");
  });

  it('bundles scripts/lane/dprep.sh verbatim for standalone and source runs', async () => {
    const { BUNDLED_LANE_SCRIPTS } = await import('./defaults/bundled-defaults');
    const source = readFileSync(SHARED_DPREP, 'utf-8').replace(/\r\n/g, '\n');
    expect(BUNDLED_LANE_SCRIPTS['dprep.sh']).toBe(source);
  });

  it('copies scripts/lane/ into the production image', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf-8');
    expect(dockerfile).toContain('COPY scripts/lane/ ./scripts/lane/');
  });

  for (const lane of LANES) {
    it(`${lane} sources the shared script and carries no inline dprep body`, () => {
      const text = readFileSync(join(LANES_DIR, lane), 'utf-8');
      // One sourcing stub per call site: prep-dependencies and run-stop-tests.
      // Resolution order: BDC_DPREP_SCRIPT, engine-materialized bundle, image copy.
      expect(
        text.split(
          'for dprep_candidate in "${BDC_DPREP_SCRIPT:-}" "${ARCHON_LANE_SCRIPTS_DIR:+${ARCHON_LANE_SCRIPTS_DIR}/dprep.sh}" /app/scripts/lane/dprep.sh; do'
        ).length - 1
      ).toBe(2);
      expect(text.split('. "$DPREP_SCRIPT"').length - 1).toBe(2);
      expect(text).not.toContain('dprep_ensure_js_deps() {\n        if [ ! -f package.json ]');
      expect(text).not.toContain('no package.json with a bun lockfile');
      expect(text).toContain('ssh://git@github[.]com/');
    });
  }
});

// On win32 `bash` may resolve to WSL; the suite runs on POSIX CI (ubuntu-latest).
describe.skipIf(process.platform === 'win32')('run-stop-tests.sh shell suite', () => {
  it('passes with zero failures', () => {
    const proc = Bun.spawnSync(['bash', SUITE], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = proc.stdout.toString();
    const summary = out.split('\n').find(l => l.startsWith('run-stop-tests.sh: ')) ?? '';
    if (proc.exitCode !== 0) {
      const failures = out
        .split('\n')
        .filter(l => l.startsWith('FAIL') || l.startsWith('  '))
        .slice(0, 60)
        .join('\n');
      throw new Error(`${summary}\n${failures}\n${proc.stderr.toString().slice(0, 2000)}`);
    }
    expect(summary).toMatch(/^run-stop-tests\.sh: \d+ passed, 0 failed$/);
  }, 120000);
});
