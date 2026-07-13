import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseWorkflow } from './loader';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import {
  LOOP_ITERATION_IDLE_TIMEOUT_MS,
  resolveLoopIterationIdleTimeoutMs,
} from './utils/idle-timeout';

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

const REASONING_LANES = [
  'bdc-feature-development.yaml',
  'bdc-feature-development-codex.yaml',
  'bdc-feature-development-codex-only.yaml',
  'bdc-feature-development-fable.yaml',
];

const OPEN_LANES = [
  'bdc-feature-development-fusion-cx-qwen.yaml',
  'bdc-feature-development-zero-open.yaml',
  'bdc-feature-development-zero.yaml',
];

const LOOP_NODES = ['plan-review', 'implement', 'diff-repair'];
const NON_LOOP_NODES = ['opus-repair', 'diff-review'];

function loadWorkflow(file: string) {
  const content = readFileSync(join(WORKFLOWS_DIR, file), 'utf-8');
  const result = parseWorkflow(content, file);
  if (!result.workflow) throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
  return result.workflow;
}

describe('idle timeout lane wiring', () => {
  for (const file of REASONING_LANES) {
    it(`${file} uses 10-minute loop idle timeout on reasoning-heavy loop nodes`, () => {
      const workflow = loadWorkflow(file);

      for (const id of LOOP_NODES) {
        const node = workflow.nodes.find(candidate => candidate.id === id);
        expect(node).toBeDefined();
        expect(node?.idle_timeout).toBe(600000);
        expect(resolveLoopIterationIdleTimeoutMs(node?.idle_timeout)).toBe(600000);
      }
    });
  }

  for (const file of OPEN_LANES) {
    it(`${file} keeps the default loop idle timeout on open-model loop nodes`, () => {
      const workflow = loadWorkflow(file);

      for (const id of LOOP_NODES) {
        const node = workflow.nodes.find(candidate => candidate.id === id);
        expect(node).toBeDefined();
        expect(node?.idle_timeout).toBeUndefined();
        expect(resolveLoopIterationIdleTimeoutMs(node?.idle_timeout)).toBe(
          LOOP_ITERATION_IDLE_TIMEOUT_MS
        );
      }
    });
  }

  for (const file of [...REASONING_LANES, ...OPEN_LANES]) {
    it(`${file} does not wire loop idle timeout onto non-loop repair/review nodes`, () => {
      const workflow = loadWorkflow(file);

      for (const id of NON_LOOP_NODES) {
        const node = workflow.nodes.find(candidate => candidate.id === id);
        expect(node).toBeDefined();
        expect(node?.idle_timeout).toBeUndefined();
      }
    });
  }
});
