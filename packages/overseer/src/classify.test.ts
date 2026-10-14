/**
 * WO-HARNESS-OVERSEER-NODE-FAILURE-REPAIR-AND-ESCALATION-01
 *
 * commit_hook_lint_failure classification. The error text is the verbatim shape
 * captured live on run 3993fe05 (2026-10-14): husky ran lint-staged
 * (eslint --fix --max-warnings 0) as a pre-commit hook and rejected the staged
 * delta on @typescript-eslint/explicit-function-return-type.
 */
import { describe, expect, test } from 'bun:test';
import { classifyError } from './classify.ts';

// Verbatim shape of the live commit-and-push hook failure (Excerpt 1).
const HOOK_ERROR = [
  'husky - pre-commit script failed (code 1)',
  '',
  'lint-staged',
  '  packages/server/src/taskmaster/loop.ts:',
  '    1419:19  error  Missing return type on function  @typescript-eslint/explicit-function-return-type',
  '[FAILED] eslint --fix --max-warnings 0 --no-warn-ignored',
].join('\n');

describe('classifyError -- commit_hook_lint_failure (WO node-failure-repair)', () => {
  test('1a verbatim husky/lint-staged failure on commit-and-push is commit_hook_lint_failure', () => {
    expect(classifyError({ message: HOOK_ERROR, nodeId: 'commit-and-push', exitCode: 1 })).toBe(
      'commit_hook_lint_failure'
    );
  });

  test('1a husky marker alone (no lint-staged block) still classifies on commit-and-push', () => {
    expect(
      classifyError({
        message: 'husky - pre-commit script failed (code 1)',
        nodeId: 'commit-and-push',
        exitCode: 1,
      })
    ).toBe('commit_hook_lint_failure');
  });

  test('2 same hook text on a DIFFERENT node id is NOT commit_hook_lint_failure', () => {
    expect(classifyError({ message: HOOK_ERROR, nodeId: 'build-manifest', exitCode: 1 })).not.toBe(
      'commit_hook_lint_failure'
    );
  });

  test('2 a plain git push rejection on commit-and-push is NOT commit_hook_lint_failure', () => {
    const pushReject = [
      'To github.com:thinmansoftware/bdc-harness.git',
      ' ! [rejected]        feature -> feature (non-fast-forward)',
      "error: failed to push some refs to 'github.com:thinmansoftware/bdc-harness.git'",
    ].join('\n');
    expect(classifyError({ message: pushReject, nodeId: 'commit-and-push', exitCode: 1 })).not.toBe(
      'commit_hook_lint_failure'
    );
  });

  test('3 an unrecognised message on patch-pr-body is still unknown (baseline unchanged)', () => {
    expect(
      classifyError({
        message: 'could not resolve PR URL from open-pr-if-needed output',
        nodeId: 'patch-pr-body',
      })
    ).toBe('unknown');
  });
});
