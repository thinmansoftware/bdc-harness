/**
 * lane-cross-model.test.ts
 *
 * Test scenarios 1-2 from WO-HARNESS-SMART-CAULDRON-LANE-ROSTER-AND-RESILIENCE-01:
 *
 * S1: Cross-model review in codex lane -- the 4 review nodes must NOT use provider: codex.
 * S2: No self-review (general) -- for every lane, builder-model != reviewer-model
 *     (model ID differs between implement and the review nodes diff-review / diff-review-final /
 *     opus-rereview / apply-diff-review-final).
 *
 * Design: parse the actual on-disk YAML files using Bun.YAML.parse so the tests catch
 * real regressions -- they read the same files the executor loads.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Resolve lane directory relative to this test file
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

// The 4 review node IDs that must never be the same species as the builder
const REVIEW_NODE_IDS = new Set([
  'diff-review',
  'diff-review-final',
  'opus-rereview',
  'apply-diff-review-final',
]);

// Builder node IDs (the implement + repair trio)
const BUILD_NODE_IDS = new Set(['implement', 'diff-repair', 'opus-repair']);

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

function resolveProvider(node: NodeDef, lane: LaneDef): string {
  return node.provider ?? lane.provider ?? 'claude';
}

function resolveModel(node: NodeDef, lane: LaneDef): string {
  return node.model ?? lane.model ?? 'sonnet';
}

// All bdc-feature-development-*.yaml files (plus the main one)
const LANE_FILES = readdirSync(LANES_DIR)
  .filter(f => f.startsWith('bdc-feature-development') && f.endsWith('.yaml'))
  .sort();

describe('lane cross-model review', () => {
  it('S1: codex lane has 0 review nodes with provider: codex', () => {
    const lane = loadLane('bdc-feature-development-codex.yaml');
    const nodes = lane.nodes ?? [];
    const reviewNodesWithCodex = nodes.filter(
      n => REVIEW_NODE_IDS.has(n.id) && resolveProvider(n, lane) === 'codex'
    );
    expect(reviewNodesWithCodex).toHaveLength(0);
  });

  it('S2: every lane -- builder-model differs from reviewer-model (no self-review)', () => {
    const violations: string[] = [];

    for (const file of LANE_FILES) {
      const lane = loadLane(file);
      const nodes = lane.nodes ?? [];

      const buildNodes = nodes.filter(n => BUILD_NODE_IDS.has(n.id));
      const reviewNodes = nodes.filter(n => REVIEW_NODE_IDS.has(n.id));

      if (buildNodes.length === 0 || reviewNodes.length === 0) continue;

      // Get the set of build (provider, model) pairs
      const buildPairs = new Set(
        buildNodes.map(n => `${resolveProvider(n, lane)}:${resolveModel(n, lane)}`)
      );

      // Check that no review node uses an identical (provider, model) to a build node
      for (const rev of reviewNodes) {
        const revPair = `${resolveProvider(rev, lane)}:${resolveModel(rev, lane)}`;
        if (buildPairs.has(revPair)) {
          violations.push(
            `${file}: review node '${rev.id}' uses same provider:model as builder (${revPair})`
          );
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        'Self-review violations detected:\n' + violations.map(v => '  ' + v).join('\n')
      );
    }
  });
});
