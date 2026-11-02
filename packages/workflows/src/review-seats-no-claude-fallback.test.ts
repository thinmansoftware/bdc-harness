/**
 * review-seats-no-claude-fallback.test.ts
 *
 * WO-HARNESS-REVIEW-SEATS-NO-CLAUDE-FALLBACK-01:
 * served feature-development review seats fail closed on Codex. They use
 * provider codex-native-strict, carry no failover_provider, and every listed
 * strict seat is pinned to gpt-5.6-terra. No review-family node in these
 * lanes remains on plain provider codex.
 *
 * WO-HARNESS-SEAT-GATE-HONORS-FIRED-LANE-TIER-01 (John Ranson 2026-10-27,
 * "use kimi k3.1 it scored high"): on the claude and fable lanes the four
 * reviewer seats fail over to Kimi K3.1 Pro on openrouter -- never Claude.
 * Every other listed lane keeps no failover at all. No listed seat may ever
 * fail over to claude (ruling D0, M-20261021c).
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const LANES_DIR = join(import.meta.dir, '..', '..', '..', '.archon/workflows/defaults');

const SEVEN_SEATS = [
  'plan-review',
  'war-council-validator',
  'diff-review',
  'diff-review-final',
  'opus-rereview',
  'findings-consolidate',
  'apply-diff-review-final',
] as const;

const FOUR_SEATS = [
  'diff-review',
  'diff-review-final',
  'opus-rereview',
  'apply-diff-review-final',
] as const;

const KIMI_FAILOVER = {
  provider: 'openrouter',
  model: 'moonshotai/kimi-k3.1-pro',
  agent: 'opr-adversarial-reviewer',
} as const;

const LANES: ReadonlyArray<{
  file: string;
  seats: readonly string[];
  failover: typeof KIMI_FAILOVER | null;
}> = [
  { file: 'bdc-feature-development-cursor.yaml', seats: SEVEN_SEATS, failover: null },
  { file: 'bdc-feature-development-codex.yaml', seats: SEVEN_SEATS, failover: null },
  { file: 'bdc-feature-development-codex-only.yaml', seats: SEVEN_SEATS, failover: null },
  { file: 'bdc-feature-development-fable.yaml', seats: FOUR_SEATS, failover: KIMI_FAILOVER },
  { file: 'bdc-feature-development.yaml', seats: FOUR_SEATS, failover: KIMI_FAILOVER },
];

interface NodeDef {
  id: string;
  provider?: string;
  model?: string;
  persona?: string;
  agent?: string;
  failover_provider?: string;
  failover_model?: string;
  failover_agent?: string;
}

interface LaneDef {
  nodes?: NodeDef[];
}

function loadLane(filename: string): LaneDef {
  const content = readFileSync(join(LANES_DIR, filename), 'utf-8');
  return (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(content) as LaneDef;
}

function isReviewFamily(node: NodeDef): boolean {
  const names = [node.agent, node.persona];
  if (names.includes('codex-adversarial-reviewer')) return true;
  if (node.id === 'plan-review' && names.includes('war-council-architect-opr')) {
    return true;
  }
  if (node.persona === 'captain-ci-validator-codex') return true;
  if (node.persona === 'xo-opr') return true;
  return false;
}

describe('review seats fail closed (no Claude fallback)', () => {
  for (const { file, seats, failover } of LANES) {
    it(`${file}: listed seats keep strict model policy and never fail over to Claude`, () => {
      const nodes = loadLane(file).nodes ?? [];
      for (const id of seats) {
        const node = nodes.find(candidate => candidate.id === id);
        expect(node, id).toBeDefined();
        expect(node?.provider, `${id}:provider`).toBe('codex-native-strict');
        expect(node?.failover_provider, `${id}:failover_provider`).not.toBe('claude');
        if (failover === null) {
          expect(node?.failover_provider, `${id}:failover_provider`).toBeUndefined();
        } else {
          expect(node?.failover_provider, `${id}:failover_provider`).toBe(failover.provider);
          expect(node?.failover_model, `${id}:failover_model`).toBe(failover.model);
          expect(node?.failover_agent, `${id}:failover_agent`).toBe(failover.agent);
        }
        if (node?.agent || node?.persona) {
          expect(node?.model, `${id}:model`).toBe('gpt-5.6-terra');
        }
      }
    });

    it(`${file}: no review-family node remains on provider codex`, () => {
      const nodes = loadLane(file).nodes ?? [];
      const offenders = nodes
        .filter(node => node.provider === 'codex' && isReviewFamily(node))
        .map(node => node.id);
      expect(offenders).toEqual([]);
    });
  }
});
