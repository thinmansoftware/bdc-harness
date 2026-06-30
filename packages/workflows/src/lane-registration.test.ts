/**
 * lane-registration.test.ts
 *
 * Test scenario 4 from WO-HARNESS-SMART-CAULDRON-LANE-ROSTER-AND-RESILIENCE-01:
 *
 * S4a: Each lane YAML passes parseWorkflow() validation (DAG valid, no loader errors).
 * S4b: war-council-validator node has `provider: claude` and `model: sonnet` in EVERY lane
 *      (trusted judge always Claude regardless of top-level lane default).
 *
 * Design: uses the real parseWorkflow() loader so validation logic matches production.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { clearRegistry, registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';
import { parseWorkflow } from './loader';

// Register all providers so parseWorkflow can validate provider: claude/codex/glm/opr/pi
// references in lane YAML files. Mirrors the setup pattern used in loader.test.ts,
// executor.test.ts, and validator.test.ts.
clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

// All bdc-feature-development lane YAMLs
const LANE_FILES = readdirSync(LANES_DIR)
  .filter(f => f.startsWith('bdc-feature-development') && f.endsWith('.yaml'))
  .sort();

interface NodeDef {
  id: string;
  provider?: string;
  model?: string;
}

interface LaneDef {
  name: string;
  provider?: string;
  model?: string;
  nodes?: NodeDef[];
}

function loadLane(filename: string): LaneDef {
  const content = readFileSync(join(LANES_DIR, filename), 'utf-8');
  return (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(content) as LaneDef;
}

describe('lane registration and war-council-validator pin', () => {
  for (const file of LANE_FILES) {
    it(`S4a: ${file} passes parseWorkflow() validation`, () => {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      const result = parseWorkflow(content, file);
      // ParseResult is a discriminated union: { workflow: WorkflowDefinition; error: null }
      // or { workflow: null; error: WorkflowLoadError }. A non-null error means failure.
      if (result.error !== null) {
        throw new Error(`${file} has parseWorkflow error: ${JSON.stringify(result.error)}`);
      }
      expect(result.workflow).toBeTruthy();
    });

    it(`S4b: ${file} has war-council-validator pinned to provider: claude model: sonnet`, () => {
      const lane = loadLane(file);
      const nodes = lane.nodes ?? [];
      const wcv = nodes.find((n: NodeDef) => n.id === 'war-council-validator');

      // Every lane MUST include the war-council-validator node -- its presence is
      // the invariant being enforced. A missing node is the regression, not a skip.
      expect(wcv).toBeDefined();
      if (!wcv) return; // narrowing guard; expect above already fails the test

      expect(wcv.provider).toBe('claude');
      expect(wcv.model).toBe('sonnet');
    });
  }
});
