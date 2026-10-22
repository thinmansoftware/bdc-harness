import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

interface NodeDef {
  id: string;
  provider?: string;
  model?: string;
  agent?: string;
  persona?: string;
  failover_provider?: string;
  failover_model?: string;
}

interface LaneDef {
  nodes?: NodeDef[];
  failover_provider?: string;
  failover_model?: string;
  failoverProvider?: string;
  failoverModel?: string;
}

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

const ALL_REVIEW_SEATS = [
  'plan-review',
  'war-council-validator',
  'diff-review',
  'diff-review-final',
  'opus-rereview',
  'findings-consolidate',
  'apply-diff-review-final',
] as const;

const DIFF_REVIEW_SEATS = [
  'diff-review',
  'diff-review-final',
  'opus-rereview',
  'apply-diff-review-final',
] as const;

const LANE_SEATS: Record<string, readonly string[]> = {
  'bdc-feature-development-cursor.yaml': ALL_REVIEW_SEATS,
  'bdc-feature-development-codex.yaml': ALL_REVIEW_SEATS,
  'bdc-feature-development-codex-only.yaml': ALL_REVIEW_SEATS,
  'bdc-feature-development-fable.yaml': DIFF_REVIEW_SEATS,
  'bdc-feature-development.yaml': DIFF_REVIEW_SEATS,
};

function loadLane(filename: string): LaneDef {
  const source = readFileSync(join(LANES_DIR, filename), 'utf8');
  return Bun.YAML.parse(source) as LaneDef;
}

function isReviewFamilyNode(node: NodeDef): boolean {
  return (
    node.agent === 'codex-adversarial-reviewer' ||
    (node.id === 'plan-review' && node.agent === 'war-council-architect-opr') ||
    node.persona === 'captain-ci-validator-codex' ||
    node.persona === 'xo-opr'
  );
}

describe('review seats fail closed instead of falling back to Claude', () => {
  for (const [filename, expectedSeats] of Object.entries(LANE_SEATS)) {
    test(`${filename} wires exactly ${expectedSeats.length} strict review seats`, () => {
      const lane = loadLane(filename);
      const nodes = lane.nodes ?? [];

      expect(lane.failover_provider, `${filename}:workflow failover_provider`).toBeUndefined();
      expect(lane.failover_model, `${filename}:workflow failover_model`).toBeUndefined();
      expect(lane.failoverProvider, `${filename}:workflow failoverProvider`).toBeUndefined();
      expect(lane.failoverModel, `${filename}:workflow failoverModel`).toBeUndefined();

      for (const id of expectedSeats) {
        const node = nodes.find(candidate => candidate.id === id);
        expect(node, `${filename}:${id}:exists`).toBeDefined();
        expect(node?.provider, `${filename}:${id}:provider`).toBe('codex-native-strict');
        expect(node?.failover_provider, `${filename}:${id}:failover_provider`).toBeUndefined();
        expect(node?.failover_model, `${filename}:${id}:failover_model`).toBeUndefined();
        if (node?.agent || node?.persona) {
          expect(node.model, `${filename}:${id}:model`).toBeUndefined();
        }
      }

      expect(
        nodes.filter(node => expectedSeats.includes(node.id)).length,
        `${filename}:seat count`
      ).toBe(expectedSeats.length);
      expect(
        nodes.filter(node => isReviewFamilyNode(node) && node.provider === 'codex'),
        `${filename}:plain Codex review-family nodes`
      ).toEqual([]);
    });
  }
});
