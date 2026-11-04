import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// WO-HARNESS-GREP-ALLOWLIST-QUOTED-MULTIWORD-01 (bdc-xo #4713, stage 1).
// Run 9f3d67e7 (WO-LSPRO-CE-GCD-ATTRIBUTION-01) died with HARNESS_REFUSED because
// `grep -c 'Grand Comics Database' ...` was split on whitespace before any quote
// handling. The run-stop-greps node now sources ONE quote-aware tokenizer,
// scripts/lane/rsg-argv.sh (rsg_parse_pipeline), for both the allowlist check and the
// execution. The behavioral coverage is the shell suite
// .archon/workflows/defaults/__tests__/run-stop-greps.sh; this file pins the wiring:
// the script is bundled verbatim, every lane carries the sourcing stub, and the image
// copies scripts/lane/.

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
const SOURCE = join(REPO_ROOT, 'scripts/lane/rsg-argv.sh');
const SUITE = join(LANES_DIR, '__tests__/run-stop-greps.sh');

const LANES = readdirSync(LANES_DIR)
  .filter(f => /^bdc-feature-development(-[a-z0-9-]+)?\.yaml$/.test(f))
  .sort();

describe('rsg-argv.sh shared tokenizer wiring', () => {
  it('covers all 13 bdc-feature-development lanes', () => {
    expect(LANES.length).toBe(13);
    expect(LANES).toContain('bdc-feature-development-astra.yaml');
  });

  it('ships scripts/lane/rsg-argv.sh defining rsg_parse_pipeline', () => {
    expect(existsSync(SOURCE)).toBe(true);
    const body = readFileSync(SOURCE, 'utf-8');
    expect(body).toContain('rsg_parse_pipeline()');
    expect(body).toContain("RSG_US=$'\\037'");
  });

  it('bundles scripts/lane/rsg-argv.sh verbatim for standalone and source runs', async () => {
    const { BUNDLED_LANE_SCRIPTS } = await import('./defaults/bundled-defaults');
    const source = readFileSync(SOURCE, 'utf-8').replace(/\r\n/g, '\n');
    expect(BUNDLED_LANE_SCRIPTS['rsg-argv.sh']).toBe(source);
  });

  it('every bundled bdc-feature-development lane carries the tokenizer stub', async () => {
    const { BUNDLED_WORKFLOWS } = await import('./defaults/bundled-defaults');
    const bundledLanes = Object.keys(BUNDLED_WORKFLOWS).filter(k =>
      /^bdc-feature-development(-[a-z0-9-]+)?$/.test(k)
    );
    expect(bundledLanes.length).toBe(13);
    for (const lane of bundledLanes) {
      const text = BUNDLED_WORKFLOWS[lane];
      expect(text).toContain('rsg_parse_pipeline');
      expect(text).toContain('BDC_RSGARGV_SCRIPT');
      expect(text).not.toContain('rsg_strip_arg');
    }
  });

  it('copies scripts/lane/ into the production image', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf-8');
    expect(dockerfile).toContain('COPY scripts/lane/ ./scripts/lane/');
  });

  for (const lane of LANES) {
    it(`${lane} sources the shared tokenizer and carries no inline whitespace split`, () => {
      const text = readFileSync(join(LANES_DIR, lane), 'utf-8');
      expect(
        text.split(
          'for rsgargv_candidate in "${BDC_RSGARGV_SCRIPT:-}" "${ARCHON_LANE_SCRIPTS_DIR:+${ARCHON_LANE_SCRIPTS_DIR}/rsg-argv.sh}" /app/scripts/lane/rsg-argv.sh; do'
        ).length - 1
      ).toBe(1);
      expect(text.split('. "$RSGARGV_SCRIPT"').length - 1).toBe(1);
      expect(text).not.toContain('rsg_strip_arg');
      expect(text).not.toContain('rsg_tokens_safe');
    });
  }
});

// On win32 `bash` may resolve to WSL; the suite runs on POSIX CI (ubuntu-latest).
describe.skipIf(process.platform === 'win32')('run-stop-greps.sh shell suite', () => {
  it('passes with zero failures', () => {
    const proc = Bun.spawnSync(['bash', SUITE], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = proc.stdout.toString();
    const summary = out.split('\n').find(l => l.startsWith('run-stop-greps.sh: ')) ?? '';
    if (proc.exitCode !== 0) {
      const failures = out
        .split('\n')
        .filter(l => l.startsWith('FAIL') || l.startsWith('  '))
        .slice(0, 60)
        .join('\n');
      throw new Error(`${summary}\n${failures}\n${proc.stderr.toString().slice(0, 2000)}`);
    }
    expect(summary).toMatch(/^run-stop-greps\.sh: \d+ passed, 0 failed \(PASS=\d+ FAIL=0\)$/);
  }, 120000);
});
