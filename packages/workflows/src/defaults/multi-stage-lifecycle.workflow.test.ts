import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { registerBuiltinProviders } from '@archon/providers';
import { parseWorkflow } from '../loader';
import { isBashNode, isLoopNode } from '../schemas';

registerBuiltinProviders();

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

  test('pins the builder seat to claude-haiku-5-5 and leaves bash gates unbound', () => {
    const raw = readFileSync(workflowPath, 'utf8');
    const modelLines = raw.split('\n').filter(line => line === 'model: claude-haiku-5-5');
    expect(modelLines).toHaveLength(1);
    expect(raw.includes('model: sonnet')).toBe(false);

    const parsed = parseWorkflow(raw, 'bdc-multi-stage-development.yaml');
    expect(parsed.error).toBeNull();
    if (parsed.workflow === null) {
      throw new Error('bdc-multi-stage-development.yaml failed to parse');
    }

    expect(parsed.workflow.provider).toBe('claude');
    expect(parsed.workflow.model).toBe('claude-haiku-5-5');
    expect(parsed.workflow.nodes.map(node => node.id)).toEqual([
      'preflight-github-auth',
      'read-spec',
      'parse-stages',
      'preflight-repo-registry',
      'allocate-stage-worktrees',
      'implement-pipeline',
      'consolidated-manifest',
      'review-issue',
      'blocked-issue',
    ]);

    const loopNodes = parsed.workflow.nodes.filter(isLoopNode);
    expect(loopNodes.map(node => node.id)).toEqual(['implement-pipeline']);
    const implement = loopNodes[0];
    expect(implement?.persona).toBe('major-build-haiku');
    expect(implement?.agent).toBe('major-build-haiku');
    expect(implement?.provider).toBeUndefined();
    expect(implement?.model).toBeUndefined();

    for (const node of parsed.workflow.nodes) {
      expect((node as { model?: string }).model).toBeUndefined();
    }

    const bashPersonas: Readonly<Record<string, string>> = {
      'preflight-github-auth': 'major-build',
      'read-spec': 'xo',
      'parse-stages': 'major-build',
      'preflight-repo-registry': 'major-build',
      'allocate-stage-worktrees': 'major-build',
      'consolidated-manifest': 'major-build',
      'review-issue': 'xo',
      'blocked-issue': 'xo',
    };

    for (const [id, persona] of Object.entries(bashPersonas)) {
      const nodeStart = raw.indexOf(`  - id: ${id}\n`);
      expect(nodeStart).toBeGreaterThanOrEqual(0);
      const nextNodeStart = raw.indexOf('\n  - id:', nodeStart + 1);
      const nodeText = raw.slice(nodeStart, nextNodeStart === -1 ? undefined : nextNodeStart);
      expect(nodeText).toContain(`    persona: ${persona}\n`);
      expect(nodeText).toContain('\n    bash: |');
      expect(nodeText.includes('\n    model:')).toBe(false);
      expect(nodeText.includes('\n    provider:')).toBe(false);
    }

    const review = parsed.workflow.nodes.find(node => node.id === 'review-issue');
    const blocked = parsed.workflow.nodes.find(node => node.id === 'blocked-issue');
    expect(review !== undefined && isBashNode(review)).toBe(true);
    expect(blocked !== undefined && isBashNode(blocked)).toBe(true);
  });
});
