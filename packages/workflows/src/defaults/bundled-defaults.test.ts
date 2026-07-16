import { describe, it, expect } from 'bun:test';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { isBinaryBuild, BUNDLED_COMMANDS, BUNDLED_WORKFLOWS } from './bundled-defaults';
import { parseWorkflow } from '../loader';
import type { DagNode } from '../schemas/dag-node';
import type { WorkflowDefinition } from '../schemas/workflow';
import {
  LOOP_ITERATION_IDLE_TIMEOUT_MS,
  resolveLoopIterationIdleTimeoutMs,
} from '../utils/idle-timeout';

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

// Resolve the on-disk defaults directories relative to this test file so the
// tests work regardless of cwd. From packages/workflows/src/defaults go up
// four levels to the repo root, then into .archon/.
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const COMMANDS_DIR = join(REPO_ROOT, '.archon/commands/defaults');
const WORKFLOWS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

function normalizeBundledText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2010-\u2015]/g, '--')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u00B7/g, '-')
    .replace(/\u2212/g, '-')
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/\u21D2/g, '=>')
    .replace(/\u2264/g, '<=')
    .replace(/\u2265/g, '>=')
    .replace(/\u2260/g, '!=')
    .replace(/\u2713/g, 'PASS')
    .replace(/\u2717/g, 'FAIL')
    .split('')
    .filter(char => char.charCodeAt(0) <= 0x7f)
    .join('');
}

function extractWorkflowNode(content: string, id: string): string {
  const lines = content.split('\n');
  const start = lines.findIndex(line => line === `  - id: ${id}`);
  expect(start).toBeGreaterThanOrEqual(0);

  const end = lines.findIndex((line, index) => index > start && /^  - id: /.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

function parseBundledWorkflow(name: string): WorkflowDefinition {
  const result = parseWorkflow(BUNDLED_WORKFLOWS[name], `${name}.yaml`);
  expect(result.error).toBeNull();
  expect(result.workflow).not.toBeNull();
  return result.workflow!;
}

function getWorkflowNode(workflow: WorkflowDefinition, id: string): DagNode {
  const node = workflow.nodes.find(candidate => candidate.id === id);
  expect(node).toBeDefined();
  return node!;
}

function withDefaultLoopIterationIdleEnv<T>(fn: () => T): T {
  const previous = process.env.ARCHON_LOOP_ITERATION_IDLE_MS;
  delete process.env.ARCHON_LOOP_ITERATION_IDLE_MS;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.ARCHON_LOOP_ITERATION_IDLE_MS;
    } else {
      process.env.ARCHON_LOOP_ITERATION_IDLE_MS = previous;
    }
  }
}

describe('bundled-defaults', () => {
  describe('isBinaryBuild', () => {
    it('should return false in dev/test mode', () => {
      // `isBinaryBuild()` reads the build-time constant `BUNDLED_IS_BINARY` from
      // `@archon/paths`. In dev/test mode it is `false`. It is only rewritten to
      // `true` by `scripts/build-binaries.sh` before `bun build --compile`.
      // Coverage of the `true` branch is via local binary smoke testing (see #979).
      expect(isBinaryBuild()).toBe(false);
    });
  });

  describe('bundle completeness', () => {
    // These assertions are the canary for bundle drift: if someone adds a
    // default file without regenerating bundled-defaults.generated.ts, the
    // bundle would be missing in compiled binaries (see #979 context). The
    // generator is `scripts/generate-bundled-defaults.ts`, and
    // `bun run check:bundled` verifies the generated file is up to date.

    it('BUNDLED_COMMANDS contains every .md file in .archon/commands/defaults/', () => {
      const onDisk = readdirSync(COMMANDS_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => f.slice(0, -'.md'.length))
        .sort();
      expect(Object.keys(BUNDLED_COMMANDS).sort()).toEqual(onDisk);
    });

    it('BUNDLED_WORKFLOWS contains every .yaml/.yml file in .archon/workflows/defaults/', () => {
      const onDisk = readdirSync(WORKFLOWS_DIR)
        .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
        .map(f => f.replace(/\.ya?ml$/, ''))
        .sort();
      expect(Object.keys(BUNDLED_WORKFLOWS).sort()).toEqual(onDisk);
    });

    it('bundled content matches on-disk file content (defense against generator corruption)', () => {
      // Bundled content is normalized by the generator so it stays identical
      // across line-ending policies and cannot trip the source ASCII gate.
      const readBundled = (path: string): string =>
        normalizeBundledText(readFileSync(path, 'utf-8'));

      for (const [name, content] of Object.entries(BUNDLED_COMMANDS)) {
        const diskContent = readBundled(join(COMMANDS_DIR, `${name}.md`));
        expect(content).toBe(diskContent);
      }
      for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
        // Workflows may be .yaml or .yml -- prefer .yaml, fall back.
        let diskContent: string;
        try {
          diskContent = readBundled(join(WORKFLOWS_DIR, `${name}.yaml`));
        } catch {
          diskContent = readBundled(join(WORKFLOWS_DIR, `${name}.yml`));
        }
        expect(content).toBe(diskContent);
      }
    });
  });

  describe('BUNDLED_COMMANDS', () => {
    it('every command has meaningful content (>50 chars)', () => {
      for (const content of Object.values(BUNDLED_COMMANDS)) {
        expect(content.length).toBeGreaterThan(50);
      }
    });

    it('archon-pr-review-scope should read .pr-number before other discovery', () => {
      const content = BUNDLED_COMMANDS['archon-pr-review-scope'];
      expect(content).toContain('$ARTIFACTS_DIR/.pr-number');
      expect(content).toContain('PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number');
    });

    it('archon-create-pr should write .pr-number to artifacts', () => {
      const content = BUNDLED_COMMANDS['archon-create-pr'];
      expect(content).toContain('echo "$PR_NUMBER" > "$ARTIFACTS_DIR/.pr-number"');
    });
  });

  describe('BUNDLED_WORKFLOWS', () => {
    it('every workflow has meaningful content (>50 chars)', () => {
      for (const content of Object.values(BUNDLED_WORKFLOWS)) {
        expect(content.length).toBeGreaterThan(50);
      }
    });

    it('archon-workflow-builder should have validate-before-save node ordering and key constraints', () => {
      const content = BUNDLED_WORKFLOWS['archon-workflow-builder'];
      expect(content).toContain('id: validate-yaml');
      expect(content).toContain('depends_on: [validate-yaml]');
      expect(content).toContain('denied_tools: [Edit, Bash]');
      expect(content).toContain('output_format:');
      expect(content).toContain('workflow_name');
    });

    it('archon-adversarial-dev init-workspace should avoid non-portable sed -i', () => {
      const content = BUNDLED_WORKFLOWS['archon-adversarial-dev'];
      expect(content).toContain('STATE_TMP="$ARTIFACTS/state.json.tmp"');
      expect(content).toContain(
        'sed "s/SPRINT_COUNT_PLACEHOLDER/$SPRINT_COUNT/" "$ARTIFACTS/state.json" > "$STATE_TMP"'
      );
      expect(content).not.toContain('sed -i "s/SPRINT_COUNT_PLACEHOLDER/$SPRINT_COUNT/"');
    });

    it('should have valid YAML structure', () => {
      for (const content of Object.values(BUNDLED_WORKFLOWS)) {
        expect(content).toContain('name:');
        expect(content).toContain('description:');
        expect(content.includes('nodes:')).toBe(true);
      }
    });

    describe('feature-development implement wall timeout placement', () => {
      const AFFECTED = [
        'bdc-feature-development',
        'bdc-feature-development-codex',
        'bdc-feature-development-codex-only',
        'bdc-feature-development-fable',
        'bdc-feature-development-fusion-cx-qwen',
        'bdc-feature-development-grok',
        'bdc-feature-development-zero-open',
        'bdc-feature-development-zero',
      ];

      for (const name of AFFECTED) {
        it(`${name} applies the 30-minute wall timeout to implement, not plan-review`, () => {
          const content = BUNDLED_WORKFLOWS[name];
          const planReview = extractWorkflowNode(content, 'plan-review');
          const implement = extractWorkflowNode(content, 'implement');

          expect(planReview).not.toContain('wall_timeout_ms: 1800000');
          expect(implement).toContain('wall_timeout_ms: 1800000');
        });
      }
    });

    describe('feature-development reasoning loop idle timeout placement', () => {
      const REASONING_BOUND = [
        'bdc-feature-development',
        'bdc-feature-development-codex',
        'bdc-feature-development-codex-only',
        'bdc-feature-development-fable',
      ];
      const OPEN_MODEL = [
        'bdc-feature-development-fusion-cx-qwen',
        'bdc-feature-development-grok',
        'bdc-feature-development-zero-open',
        'bdc-feature-development-zero',
      ];
      const OUT_OF_SCOPE_NODES = ['opus-repair', 'diff-review', 'diff-review-final', 'diff-repair'];

      for (const name of REASONING_BOUND) {
        it(`${name} applies the 10-minute idle timeout to plan-review and implement`, () => {
          const content = BUNDLED_WORKFLOWS[name];
          const workflow = parseBundledWorkflow(name);
          const planReview = extractWorkflowNode(content, 'plan-review');
          const implement = extractWorkflowNode(content, 'implement');
          const planReviewNode = getWorkflowNode(workflow, 'plan-review');
          const implementNode = getWorkflowNode(workflow, 'implement');

          expect(planReview).toContain('idle_timeout: 600000');
          expect(implement).toContain('idle_timeout: 600000');
          expect(planReviewNode.idle_timeout).toBe(600000);
          expect(implementNode.idle_timeout).toBe(600000);
          expect(resolveLoopIterationIdleTimeoutMs(planReviewNode.idle_timeout)).toBe(600000);
          expect(resolveLoopIterationIdleTimeoutMs(implementNode.idle_timeout)).toBe(600000);
        });
      }

      for (const name of OPEN_MODEL) {
        it(`${name} keeps the default loop idle timeout on plan-review and implement`, () => {
          withDefaultLoopIterationIdleEnv(() => {
            const content = BUNDLED_WORKFLOWS[name];
            const workflow = parseBundledWorkflow(name);
            const planReview = extractWorkflowNode(content, 'plan-review');
            const implement = extractWorkflowNode(content, 'implement');
            const planReviewNode = getWorkflowNode(workflow, 'plan-review');
            const implementNode = getWorkflowNode(workflow, 'implement');

            expect(planReview).not.toContain('idle_timeout: 600000');
            expect(implement).not.toContain('idle_timeout: 600000');
            expect(planReviewNode.idle_timeout).toBeUndefined();
            expect(implementNode.idle_timeout).toBeUndefined();
            expect(resolveLoopIterationIdleTimeoutMs(planReviewNode.idle_timeout)).toBe(
              LOOP_ITERATION_IDLE_TIMEOUT_MS
            );
            expect(resolveLoopIterationIdleTimeoutMs(implementNode.idle_timeout)).toBe(
              LOOP_ITERATION_IDLE_TIMEOUT_MS
            );
          });
        });
      }

      for (const name of [...REASONING_BOUND, ...OPEN_MODEL]) {
        for (const nodeId of OUT_OF_SCOPE_NODES) {
          it(`${name} does not apply the plan-review/implement idle timeout to ${nodeId}`, () => {
            withDefaultLoopIterationIdleEnv(() => {
              const content = BUNDLED_WORKFLOWS[name];
              const workflow = parseBundledWorkflow(name);
              const nodeSource = extractWorkflowNode(content, nodeId);
              const node = getWorkflowNode(workflow, nodeId);

              expect(nodeSource).not.toContain('idle_timeout: 600000');
              expect(node.idle_timeout).toBeUndefined();
              expect(resolveLoopIterationIdleTimeoutMs(node.idle_timeout)).toBe(
                LOOP_ITERATION_IDLE_TIMEOUT_MS
              );
            });
          });
        }
      }
    });

    // WO-HARNESS-COMMIT-AND-PUSH-BACKSTOP-FALSE-NEGATIVE-01 regression guard:
    // Ensure the false-negative pattern is gone and the corrected COMMITS_AHEAD
    // check is present in all four affected bdc-* workflows.
    describe('commit-and-push backstop false-negative fix', () => {
      const AFFECTED = [
        'bdc-feature-development',
        'bdc-bug-fix',
        'bdc-cleanup-sweep',
        'bdc-doctrine-update',
      ];

      for (const name of AFFECTED) {
        it(`${name} does not contain the false-negative "No changed files found; cannot commit." message`, () => {
          const content = BUNDLED_WORKFLOWS[name];
          expect(content).not.toContain('No changed files found; cannot commit.');
        });

        it(`${name} contains COMMITS_AHEAD check (the corrected backstop logic)`, () => {
          const content = BUNDLED_WORKFLOWS[name];
          expect(content).toContain('COMMITS_AHEAD');
        });
      }
    });
  });
});
