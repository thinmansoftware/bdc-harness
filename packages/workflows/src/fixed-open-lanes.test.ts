import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

const defaults = join(import.meta.dir, '..', '..', '..', '.archon', 'workflows', 'defaults');
const read = (name: string) =>
  YAML.parse(readFileSync(join(defaults, `${name}.yaml`), 'utf8')) as {
    provider: string;
    model: string;
    nodes: Array<{
      id: string;
      depends_on?: string[];
      bash?: string;
      prompt?: string;
      loop?: object;
      provider?: string;
      model?: string;
      allowed_tools?: string[];
      maxBudgetUsd?: number;
      failover_provider?: string;
      failover_model?: string;
    }>;
  };

const source = read('bdc-feature-development-zero-open');
const expectedSeats = source.nodes.filter(node => node.prompt || node.loop).map(node => node.id);

describe('fixed OpenRouter staging lanes', () => {
  for (const [variant, reviewer, judge] of [
    ['a', 'z-ai/glm-5.3', 'moonshotai/kimi-k3'],
    ['b', 'moonshotai/kimi-k3', 'z-ai/glm-5.3'],
  ] as const) {
    test(`lane ${variant} pins every AI seat and keeps review read-only`, () => {
      const lane = read(`bdc-feature-development-open-${variant}`);
      expect(lane.provider).toBe('openrouter');
      expect(lane.model).toBe('deepseek/deepseek-v4.1-flash');
      const ai = lane.nodes.filter(node => node.prompt || node.loop);
      expect(ai.map(node => node.id)).toEqual(expectedSeats);
      const addedCaptures = ['capture-opus-diff', 'capture-apply-diff'];
      expect(
        lane.nodes
          .filter(node => !node.prompt && !node.loop && !addedCaptures.includes(node.id))
          .map(node => node.id)
      ).toEqual(source.nodes.filter(node => !node.prompt && !node.loop).map(node => node.id));
      expect(lane.nodes.find(node => node.id === 'capture-diff')?.depends_on).toContain(
        'run-stop-tests'
      );
      expect(lane.nodes.find(node => node.id === 'war-council-validator')?.depends_on).toContain(
        'capture-diff'
      );
      for (const id of addedCaptures) {
        expect(lane.nodes.find(node => node.id === id)?.bash).toContain('git diff');
      }
      for (const node of ai) {
        expect(node.provider, node.id).toBe('openrouter');
        expect(node.model, node.id).toMatch(/^(deepseek|z-ai|moonshotai)\//);
        expect(node.allowed_tools, node.id).toBeDefined();
        expect(node.maxBudgetUsd, node.id).toBeGreaterThan(0);
        expect(node.failover_provider, node.id).toBeUndefined();
        expect(node.failover_model, node.id).toBeUndefined();
      }
      for (const id of ['implement', 'diff-repair', 'opus-repair', 'apply-suggested-fix']) {
        const node = ai.find(candidate => candidate.id === id);
        expect(node?.model).toBe('deepseek/deepseek-v4-pro-0813');
        expect(node?.allowed_tools).toContain('write_file');
      }
      for (const id of [
        'plan-review',
        'diff-review',
        'diff-review-final',
        'opus-rereview',
        'apply-diff-review-final',
      ]) {
        const node = ai.find(candidate => candidate.id === id);
        expect(node?.model).toBe(reviewer);
        expect(node?.allowed_tools).toContain('read_artifact');
        expect(node?.allowed_tools).not.toContain('bash');
        expect(node?.allowed_tools).not.toContain('write_file');
        expect(node?.allowed_tools).not.toContain('edit_file');
      }
      const validator = ai.find(node => node.id === 'war-council-validator');
      expect(validator?.model).toBe(judge);
      expect(validator?.allowed_tools).not.toContain('bash');
      expect(validator?.prompt).toContain('Do not claim you ran a command');
    });
  }
});
