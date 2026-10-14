import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL(
    '../../../.archon/workflows/defaults/bdc-feature-development-codex.yaml',
    import.meta.url
  ),
  'utf8'
);

test('commit hook repair is classified, bounded, and contains an unpushed PR', () => {
  const repair = workflow.slice(
    workflow.indexOf('- id: classify-commit-hook-failure'),
    workflow.indexOf('- id: open-pr-if-needed')
  );
  expect(repair).toContain('error_class":"commit_hook_lint_failure');
  expect(repair).toContain(
    'when: "$classify-commit-hook-failure.output.error_class == \'commit_hook_lint_failure\'"'
  );
  expect(repair.match(/- id: commit-and-push-retry/g)).toHaveLength(1);
  expect(repair).toContain('gh pr ready "$PR_NUMBER" --undo');
  expect(repair).toContain('The run repair delta was NOT pushed');
});
