import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseWorkflow } from './loader';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

// The 10-minute per-node idle-timeout override wired by
// WO-HARNESS-IDLE-TIMEOUT-REASONING-NODES-01. Value must match the literal
// added to the lane YAMLs (ms).
const REASONING_IDLE_TIMEOUT_MS = 600000;

// Lanes whose plan-review / implement / diff-repair loop nodes are bound to
// claude-family / fable / codex reasoning models. These 3 loop nodes get the
// override so a deep-reasoning pass thinking >3 min is not killed as a dead
// stream.
const ADD_LANES = [
  'bdc-feature-development.yaml',
  'bdc-feature-development-fable.yaml',
  'bdc-feature-development-codex.yaml',
  'bdc-feature-development-codex-only.yaml',
];

// Open / fusion lanes: plan-review is deepseek (open model, keeps 3-min default)
// and implement / diff-repair are grok-bound (x-ai/grok-4.5) and explicitly left
// untouched by this WO pending a separate classification decision. NONE of their
// loop nodes may carry the override.
const OPEN_LANES = [
  'bdc-feature-development-zero.yaml',
  'bdc-feature-development-fusion-cx-qwen.yaml',
  'bdc-feature-development-zero-open.yaml',
];

// The three loop nodes (only these have a loop: block in the live YAML).
const LOOP_NODES = ['plan-review', 'implement', 'diff-repair'];

// Non-loop nodes that already default to the 30-min STEP_IDLE_TIMEOUT_MS and
// must NOT gain the 10-min override (that would be a regression, not a fix).
const NON_LOOP_CONTROL_NODES = ['opus-repair', 'diff-review'];

function loadNodes(file: string) {
  const content = readFileSync(join(LANES_DIR, file), 'utf-8');
  const result = parseWorkflow(content, file);
  if (!result.workflow) {
    throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
  }
  const workflow = result.workflow;
  return (id: string) => workflow.nodes.find(n => n.id === id);
}

describe('idle-timeout lane wiring', () => {
  for (const file of ADD_LANES) {
    it(`${file} wires idle_timeout: 600000 on all three reasoning loop nodes`, () => {
      const node = loadNodes(file);
      for (const id of LOOP_NODES) {
        expect(node(id)).toBeDefined();
        expect(node(id)?.idle_timeout).toBe(REASONING_IDLE_TIMEOUT_MS);
      }
    });
  }

  for (const file of OPEN_LANES) {
    it(`${file} leaves all three loop nodes on the default (no idle_timeout override)`, () => {
      const node = loadNodes(file);
      // plan-review is deepseek (open); implement / diff-repair are grok-bound and
      // explicitly untouched. This is the concrete regression guard for the
      // ambiguity decision -- not just narrated intent.
      for (const id of LOOP_NODES) {
        expect(node(id)).toBeDefined();
        expect(node(id)?.idle_timeout).toBeUndefined();
      }
    });
  }

  it('does not add idle_timeout to non-loop nodes (control: zero lane)', () => {
    // opus-repair / diff-review are single-shot nodes with no loop: block; they
    // already run on the 30-min STEP_IDLE_TIMEOUT_MS default. Adding the 10-min
    // override here would REGRESS their timeout. Guard against scope creep.
    const node = loadNodes('bdc-feature-development-zero.yaml');
    for (const id of NON_LOOP_CONTROL_NODES) {
      expect(node(id)).toBeDefined();
      expect(node(id)?.loop).toBeUndefined();
      expect(node(id)?.idle_timeout).toBeUndefined();
    }
  });

  it('does not add idle_timeout to non-loop nodes on the ADD lanes either', () => {
    // Same scope-creep guard on a lane that DID receive the override, proving the
    // override landed only on loop nodes there.
    const node = loadNodes('bdc-feature-development.yaml');
    for (const id of NON_LOOP_CONTROL_NODES) {
      expect(node(id)).toBeDefined();
      expect(node(id)?.loop).toBeUndefined();
      expect(node(id)?.idle_timeout).toBeUndefined();
    }
  });
});
