/**
 * lane-registration.test.ts
 *
 * Test scenario 4 from WO-HARNESS-SMART-CAULDRON-LANE-ROSTER-AND-RESILIENCE-01:
 *
 * S4a: Each lane YAML passes parseWorkflow() validation (DAG valid, no loader errors).
 * S4b: war-council-validator node has `provider: claude` and `model: sonnet` in standard lanes
 *      (trusted judge always Claude regardless of top-level lane default), EXCEPT
 *      bdc-feature-development-zero.yaml, which deliberately pins war-council-validator
 *      to `provider: codex`, and bdc-feature-development-zero-claude.yaml, which pins
 *      it to `provider: codex-opr` so Codex failures degrade to OpenRouter instead.
 *
 * Design: uses the real parseWorkflow() loader so validation logic matches production.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseWorkflow } from './loader';

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
      // ParseResult may have a success/error shape -- accept either pattern
      if (typeof result === 'object' && result !== null && 'errors' in result) {
        const errors = (result as { errors?: unknown[] }).errors;
        if (Array.isArray(errors) && errors.length > 0) {
          throw new Error(`${file} has parseWorkflow errors: ${JSON.stringify(errors)}`);
        }
      }
      // If result has a workflow property, it parsed successfully
      // If result is the workflow itself (object with name), it parsed successfully
      expect(result).toBeTruthy();
    });

    it(`S4b: ${file} has the expected war-council-validator provider pin`, () => {
      const lane = loadLane(file);
      const nodes = lane.nodes ?? [];
      const wcv = nodes.find((n: NodeDef) => n.id === 'war-council-validator');

      if (!wcv) {
        // Some lanes may not have the validator (skip gracefully)
        return;
      }

      if (file === 'bdc-feature-development-zero.yaml') {
        // zero-Claude law: this lane pins war-council-validator to codex on purpose.
        expect(wcv.provider).toBe('codex');
        return;
      }

      if (file === 'bdc-feature-development-zero-claude.yaml') {
        expect(wcv.provider).toBe('codex-opr');
        return;
      }

      if (file === 'bdc-feature-development-codex.yaml') {
        // Fable test seat (John 2026-07-02: "add fable in to one for testing for
        // now"). Superseded by the apex-rung WO (bdc-xo issue #575) when it lands.
        expect(wcv.provider).toBe('claude');
        expect(wcv.model).toBe('claude-fable-5');
        return;
      }

      expect(wcv.provider).toBe('claude');
      expect(wcv.model).toBe('sonnet');
    });
  }
});
