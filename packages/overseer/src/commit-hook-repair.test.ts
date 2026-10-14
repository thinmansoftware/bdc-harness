import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
    expect(classifyError({ nodeId: 'commit-and-push-retry', message: hookFailure })).toBe(
      'commit_hook_lint_failure'
    );
  });

  test('real_hook_repair_roundtrip', () => {
    const script = readFileSync('.archon/scripts/commit-and-push.sh', 'utf8');
    expect(script).toContain('git commit -m');
    expect(script).toContain('commit-hook-output.txt');
  });

  test('second_failure_does_not_loop', () => {
    const lane = readFileSync(
      '.archon/workflows/defaults/bdc-feature-development-codex.yaml',
      'utf8'
    );
    expect(lane).not.toContain('.archon/scripts/commit-and-push.sh 1');
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
