import { describe, expect, it } from 'bun:test';
import { join } from 'path';

// WO-HARNESS-TEST-LOOP-BEFORE-EVIDENCE-GATE-01 (bdc-xo#3436): the evidence-gate
// shell suites must run in CI, not only on a builder's machine. run-stop-tests.sh
// is already covered by lane-dprep-shell-tests.test.ts; these cover the other
// evidence suites and the merged environment/repair contract.
// On win32 `bash` may resolve to WSL and timing checks are unreliable on loaded
// Windows hosts; the suites run on POSIX CI (ubuntu-latest).
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const TESTS_DIR = join(REPO_ROOT, '.archon/workflows/defaults/__tests__');

const SUITES = [
  'manifest-evidence-check.sh',
  'stamp-manifest-evidence.sh',
  'test-repair-guard.sh',
  'stage-evidence.sh',
  'env-unavailable-test-loop.sh',
] as const;

describe.skipIf(process.platform === 'win32')('evidence gate shell suites', () => {
  for (const suite of SUITES) {
    it(`${suite} passes with zero failures`, () => {
      const proc = Bun.spawnSync(['bash', join(TESTS_DIR, suite)], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = proc.stdout.toString();
      const summary = out.split('\n').find(l => l.startsWith(`${suite}: `)) ?? '';
      if (proc.exitCode !== 0) {
        const failures = out
          .split('\n')
          .filter(l => l.startsWith('FAIL'))
          .slice(0, 60)
          .join('\n');
        throw new Error(`${summary}\n${failures}\n${proc.stderr.toString().slice(0, 2000)}`);
      }
      expect(summary.startsWith(`${suite}: `)).toBe(true);
      expect(summary.slice(suite.length)).toMatch(/^: \d+ passed, 0 failed$/);
    }, 600000);
  }
});
