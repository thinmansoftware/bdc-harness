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
  test('allows CI-green gate waits beyond the default idle timeout', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const nodeStart = workflow.indexOf('  - id: implement-pipeline');
    expect(nodeStart).toBeGreaterThanOrEqual(0);

    const nextNodeStart = workflow.indexOf('\n  - id:', nodeStart + 1);
    const nodeText = workflow.slice(nodeStart, nextNodeStart === -1 ? undefined : nextNodeStart);
    const idleTimeout = nodeText.match(/^    idle_timeout: (\d+)\s*$/m);

    expect(idleTimeout).not.toBeNull();
    expect(Number(idleTimeout?.[1])).toBeGreaterThanOrEqual(900000);
  });

  test('uses the mechanical lifecycle reducer before status mutation', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const reducerIndex = workflow.indexOf('multi-stage-lifecycle.ts');
    const statusMutationIndex = workflow.indexOf('  - id: review-issue');

    expect(reducerIndex).toBeGreaterThan(0);
    expect(statusMutationIndex).toBeGreaterThan(reducerIndex);
    expect(workflow).toContain('depends_on: [consolidated-manifest]');
    expect(workflow).toContain('PARENT_PROJECTION');
  });

  test('cannot promote a blocked parent to REVIEW through the tail', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const blockedGate = workflow.indexOf('not marking issue status:review');
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
