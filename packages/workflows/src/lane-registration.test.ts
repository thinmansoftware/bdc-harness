/**
 * lane-registration.test.ts
 *
 * Test scenario 4 from WO-HARNESS-SMART-CAULDRON-LANE-ROSTER-AND-RESILIENCE-01:
 *
 * S4a: Each lane YAML passes parseWorkflow() validation (DAG valid, no loader errors).
 * S4b: war-council-validator pin matches the lane's dual-cap / quality intent:
 *      standard/codex/fable -> Claude judge; zero/zero-open/qwen dual-cap -> open models.
 *
 * Design: uses the real parseWorkflow() loader so validation logic matches production.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseWorkflow } from './loader';
import {
  clearRegistry,
  getMissingProviderExecutionCapabilities,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import { deriveNodeExecutionRequirements, isEvidenceNode } from './schemas/dag-node';

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
  bash?: string;
}

interface LaneDef {
  name: string;
  provider?: string;
  model?: string;
  nodes?: NodeDef[];
  run_authority?: {
    required?: boolean;
    spec_repository?: string;
    spec_revision?: string;
    spec_paths?: string[];
  };
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
      expect(result.error).toBeNull();
      expect(result.workflow).not.toBeNull();
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
        // Dual-cap (2026-07-09): DeepSeek judge via glm/OpenRouter.
        expect(wcv.provider).toBe('glm');
        return;
      }

      if (file === 'bdc-feature-development-zero-open.yaml') {
        // Dual-cap: DeepSeek on opr-zero (no Claude, no Codex).
        expect(wcv.provider).toBe('opr-zero');
        return;
      }

      if (file === 'bdc-feature-development-fusion-cx-qwen.yaml') {
        // Dual-cap qwen: OpenRouter judge.
        expect(wcv.provider).toBe('opr');
        return;
      }

      if (file === 'bdc-feature-development-codex-only.yaml') {
        // Claude-out / Codex-in: validator on codex with model-free persona.
        expect(wcv.provider).toBe('codex');
        return;
      }

      if (file === 'bdc-feature-development-codex.yaml') {
        // Fable test seat (John 2026-07-02: "add fable in to one for testing for
        // now"). Superseded by the apex-rung WO (bdc-xo issue #575) when it lands.
        expect(wcv.provider).toBe('claude');
        expect(wcv.model).toBe('claude-fable-5');
        return;
      }

      const expectedModel =
        file === 'bdc-feature-development-fable.yaml' ? 'claude-fable-5' : 'sonnet';
      expect(wcv.provider).toBe('claude');
      expect(wcv.model).toBe(expectedModel);
    });
  }

  for (const file of LANE_FILES) {
    it(`S4c: ${file} never assigns a chat-only provider to a builder or repair seat`, () => {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      const result = parseWorkflow(content, file);
      if (!result.workflow) throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
      for (const node of result.workflow.nodes) {
        if (!['implement', 'diff-repair', 'opus-repair'].includes(node.id)) continue;
        const provider = node.provider ?? result.workflow.provider;
        if (!provider) continue;
        const missing = getMissingProviderExecutionCapabilities(
          provider,
          deriveNodeExecutionRequirements(node)
        );
        expect(missing, `${file}:${node.id}:${provider}`).toEqual([]);
      }
    });

    it(`S4d: ${file} consumes the frozen work-order artifact`, () => {
      const lane = loadLane(file);
      expect(lane.run_authority).toEqual({
        required: true,
        spec_repository: 'bluedevilcollectibles/bdc-xo',
        spec_revision: 'main',
        spec_paths: ['docs/work-orders/{WO_ID}.md', 'docs/superpowers/specs/{WO_ID}.md'],
      });
      const readSpec = lane.nodes?.find(node => node.id === 'read-spec');
      const authoritativePrefix = readSpec?.bash?.split('exit 0', 1)[0] ?? '';
      expect(authoritativePrefix).toContain('run-authority.json');
      expect(authoritativePrefix).toContain('work-order.md');
      expect(authoritativePrefix).toContain('sha256sum');
      expect(authoritativePrefix).toContain('cat "$AUTHORITY_SPEC"');
    });

    it(`S4e: ${file} derives its manifest from mechanical evidence`, () => {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      const result = parseWorkflow(content, file);
      if (!result.workflow) throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
      const manifestNode = result.workflow.nodes.find(node => node.id === 'build-manifest');
      expect(manifestNode).toBeDefined();
      expect(manifestNode && isEvidenceNode(manifestNode)).toBe(true);
      expect(manifestNode && 'prompt' in manifestNode).toBe(false);
    });
  }
});
