/**
 * Behavioral tests for the bdc-feature-development Opus repair evidence guard.
 *
 * The blocked-run repair tier must not let an agent claim OPUS_REPAIR=fixed when
 * the assigned worktree has no real diff or run-local commit. That false-complete
 * class previously reached final review with header-only diff artifacts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CLASSIFY_OPUS_REPAIR_SCRIPT = `
set -uo pipefail
OPUS=$OPUS_OUTPUT
WT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
BASE=$(cat "$ARTIFACTS_DIR/run-start-sha.txt" 2>/dev/null || echo "")
HEAD_NOW=$(git -C "$WT" rev-parse HEAD 2>/dev/null || echo "")
CHANGED=$(git -C "$WT" status --porcelain 2>/dev/null | grep -c . || true)
if [ -n "$BASE" ] && [ "$BASE" != "unknown" ] && [ -n "$HEAD_NOW" ]; then
  AHEAD=$(git -C "$WT" rev-list --count "\${BASE}..HEAD" 2>/dev/null || echo 0)
else
  AHEAD=$(git -C "$WT" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)
fi
if printf '%s\\n' "$OPUS" | grep -q '^OPUS_REPAIR=fixed'; then
  if [ "\${CHANGED:-0}" -gt 0 ] || [ "\${AHEAD:-0}" -gt 0 ]; then
    printf '{"fixed":"true","changed":%s,"commits_since_run_start":%s}\\n' "\${CHANGED:-0}" "\${AHEAD:-0}"
  else
    echo "SELF_CONSISTENCY_ERROR=opus-repair-claimed-fixed-with-no-worktree-diff" >&2
    printf '{"fixed":"false","note":"SELF_CONSISTENCY_ERROR","changed":0,"commits_since_run_start":0}\\n'
  fi
else
  printf '{"fixed":"false"}\\n'
fi
`;

function run(
  script: string,
  cwd: string,
  env: Record<string, string> = {}
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['bash', '-c', script], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

describe('bdc Opus repair evidence guard', () => {
  let dir: string;
  let artifactsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bdc-opus-guard-'));
    artifactsDir = mkdtempSync(join(tmpdir(), 'bdc-opus-guard-artifacts-'));
    git(['init', '--initial-branch=main'], dir);
    writeFileSync(join(dir, 'README.md'), 'initial\n');
    git(['add', 'README.md'], dir);
    git(['commit', '-m', 'init'], dir);
    const start = run('git rev-parse HEAD', dir).stdout.trim();
    writeFileSync(join(artifactsDir, 'run-start-sha.txt'), `${start}\n`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('rejects OPUS_REPAIR=fixed when the worktree has no diff or run-local commit', () => {
    const result = run(CLASSIFY_OPUS_REPAIR_SCRIPT, dir, {
      ARTIFACTS_DIR: artifactsDir,
      OPUS_OUTPUT: 'ROOT_CAUSE=no changes made\nOPUS_REPAIR=fixed',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"fixed":"false"');
    expect(result.stdout).toContain('SELF_CONSISTENCY_ERROR');
    expect(result.stderr).toContain(
      'SELF_CONSISTENCY_ERROR=opus-repair-claimed-fixed-with-no-worktree-diff'
    );
  });

  it('accepts OPUS_REPAIR=fixed when the assigned worktree contains real changes', () => {
    writeFileSync(join(dir, 'feature.txt'), 'repair\n');

    const result = run(CLASSIFY_OPUS_REPAIR_SCRIPT, dir, {
      ARTIFACTS_DIR: artifactsDir,
      OPUS_OUTPUT: 'ROOT_CAUSE=added missing repair\nOPUS_REPAIR=fixed',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"fixed":"true"');
    expect(result.stdout).toContain('"changed":1');
  });
});
