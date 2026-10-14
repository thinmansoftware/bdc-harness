import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyError } from './classify';
import { decide } from './decide';

const hookFailure = `lint-staged\n[FAILED] eslint\npackages/server/src/taskmaster/loop.ts 1419:19 error Missing return type on function @typescript-eslint/explicit-function-return-type\nhusky - pre-commit script failed`;

describe('commit hook repair contract', () => {
  test('lint_hook_failure_classified_and_decided', () => {
    const errorClass = classifyError({ nodeId: 'commit-and-push', message: hookFailure });
    expect(errorClass).toBe('commit_hook_lint_failure');
    expect(decide({ errorClass, attempt: 1 })).toMatchObject({
      repairableOnce: true,
      blocker: false,
    });
    expect(decide({ errorClass, attempt: 2 })).toMatchObject({
      repairableOnce: false,
      blocker: true,
    });
  });

  test('hook_failure_text_on_other_node_not_captured', () => {
    expect(classifyError({ nodeId: 'build-manifest', message: hookFailure })).not.toBe(
      'commit_hook_lint_failure'
    );
    expect(classifyError({ nodeId: 'commit-and-push', message: 'git push rejected' })).not.toBe(
      'commit_hook_lint_failure'
    );
    expect(classifyError({ nodeId: 'commit-and-push-retry', message: hookFailure })).not.toBe(
      'commit_hook_lint_failure'
    );
  });

  test('real_hook_repair_roundtrip', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'commit-hook-roundtrip-'));
    const remote = join(fixture, 'remote.git');
    const repo = join(fixture, 'repo');
    execFileSync('git', ['init', '--bare', remote]);
    execFileSync('git', ['init', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
    writeFileSync(join(repo, 'checked.js'), 'bad\n');
    const hooks = join(repo, '.hooks');
    execFileSync('mkdir', ['-p', hooks]);
    writeFileSync(
      join(hooks, 'eslint'),
      '#!/bin/sh\nif grep -q bad "$1"; then echo "lint-staged [FAILED] eslint"; exit 1; fi\n'
    );
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\n.hooks/eslint checked.js\n');
    chmodSync(join(hooks, 'eslint'), 0o755);
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '.hooks']);
    const env = {
      ...process.env,
      UNIQUE_BRANCH: 'repair',
      ARTIFACTS_DIR: join(fixture, 'artifacts'),
      COMMIT_MESSAGE: 'test',
    };
    const first = spawnSync(process.cwd() + '/.archon/scripts/commit-and-push.sh', ['1'], {
      cwd: repo,
      env,
    });
    expect(first.status).not.toBe(0);
    expect(readFileSync(join(fixture, 'artifacts', 'commit-hook-output.txt'), 'utf8')).toContain(
      '[FAILED]'
    );
    writeFileSync(join(repo, 'checked.js'), 'good\n');
    const second = spawnSync(process.cwd() + '/.archon/scripts/commit-and-push.sh', ['2'], {
      cwd: repo,
      env,
    });
    expect(second.status).toBe(0);
    expect(
      execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/repair'], {
        encoding: 'utf8',
      }).trim()
    ).toBe(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  });

  test('second_failure_does_not_loop', () => {
    const lane = readFileSync(
      '.archon/workflows/defaults/bdc-feature-development-codex.yaml',
      'utf8'
    );
    expect(lane).toContain('.archon/scripts/commit-and-push.sh 1');
    expect(lane).toContain('.archon/scripts/commit-and-push.sh 2');
    expect(lane).not.toContain('.archon/scripts/commit-and-push.sh 3');
  });

  test('lane_yaml_structure_has_one_bounded_repair', () => {
    const lane = readFileSync(
      '.archon/workflows/defaults/bdc-feature-development-codex.yaml',
      'utf8'
    );
    expect(lane.match(/id: commit-hook-repair/g)?.length).toBe(1);
    expect(lane).toContain('OPUS_REPAIR=fixed');
    expect(lane).toContain('id: qualify-commit-hook-repair');
  });

  test('unpushed_repair_makes_open_pr_draft', () => {
    const lane = readFileSync(
      '.archon/workflows/defaults/bdc-feature-development-codex.yaml',
      'utf8'
    );
    expect(lane).toContain('gh pr ready "$PR"');
    expect(lane).toContain('NOT pushed');
  });
});
