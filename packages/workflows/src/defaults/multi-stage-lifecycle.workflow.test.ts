import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const workflowPath = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '.archon',
  'workflows',
  'defaults',
  'bdc-multi-stage-development.yaml'
);

describe('multi-stage workflow lifecycle guards', () => {
  test('uses the mechanical lifecycle reducer before status mutation', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const reducerIndex = workflow.indexOf('multi-stage-lifecycle.ts');
    const flipIndex = workflow.indexOf('  - id: flip-notion');

    expect(reducerIndex).toBeGreaterThan(0);
    expect(flipIndex).toBeGreaterThan(reducerIndex);
    expect(workflow).toContain('depends_on: [consolidated-manifest]');
    expect(workflow).toContain('PARENT_PROJECTION');
  });

  test('cannot promote a blocked parent to REVIEW through the tail', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const blockedGate = workflow.indexOf('parent reducer refused REVIEW');
    const reviewMutation = workflow.indexOf('gh label create status:review');

    expect(blockedGate).toBeGreaterThan(0);
    expect(reviewMutation).toBeGreaterThan(blockedGate);
    expect(workflow).toContain(
      'gh issue edit "$ISSUE_NUM" --repo "$ISSUE_REPO" --add-label status:blocked'
    );
  });

  test('threads frozen per-stage base authority into lifecycle artifacts', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain('baseSha: result.baseSha');
    expect(workflow).toContain('git merge-base --is-ancestor "${baseSha}" HEAD');
    expect(workflow).toContain('"attempts"');
    expect(workflow).toContain('"evidence"');
  });
});
