/**
 * WO-HARNESS-PERSONA-MODEL-DECLARED-01. Board decision D0 (M-20261021c): review
 * seats never fall back to Claude. Every review node in every shipped
 * bdc-feature-development lane declares a non-Claude failover that the runtime
 * selectors accept, and every NON-review persona node on a Codex seat resolves an
 * allowed Claude model if the seat gate reroutes it to Claude.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import { parseWorkflow } from '../loader';
import { selectQuotaExhaustionRoute } from '../node-failover';
import { resolveAgentPersona } from '../executor-shared';
import { loadAgentRegistry, resolveAgent } from '../agents/registry';
import type { DagNode, WorkflowDefinition } from '../schemas';
import { seatForProvider } from './seat-usage';
import {
  DEFAULT_CLAUDE_FAILOVER_MODEL,
  isReviewNode,
  REVIEW_NODE_IDS,
  selectSeatNodeFailover,
} from './seat-node-failover';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const DEFAULTS = join(ROOT, '.archon', 'workflows', 'defaults');
const CODE_REVIEW_IDS = [
  'diff-review',
  'diff-review-final',
  'opus-rereview',
  'apply-diff-review-final',
];

interface Lane {
  file: string;
  workflow: WorkflowDefinition;
}

function loadLanes(): Lane[] {
  const files = readdirSync(DEFAULTS)
    .filter(name => /^bdc-feature-development(-[a-z0-9-]+)?\.yaml$/.test(name))
    .sort();
  return files.map(file => {
    const parsed = parseWorkflow(readFileSync(join(DEFAULTS, file), 'utf8'), file);
    if (!parsed.workflow) throw new Error(`${file} failed to load: ${parsed.error?.error}`);
    return { file, workflow: parsed.workflow };
  });
}

function effectiveProvider(node: DagNode, wf: WorkflowDefinition): string {
  return (node as { provider?: string }).provider ?? wf.provider ?? 'claude';
}

function personaName(node: DagNode): string | undefined {
  const ref = node as { agent?: string; persona?: string };
  return ref.agent ?? ref.persona;
}

beforeAll(() => {
  clearRegistry();
  registerBuiltinProviders();
  registerCommunityProviders();
});

afterAll(() => {
  clearRegistry();
});

describe('D0: shipped lane review nodes declare a non-Claude failover', () => {
  test('lane_review_nodes_declare_non_claude_failover', () => {
    const lanes = loadLanes();
    expect(lanes).toHaveLength(13);
    let checked = 0;
    for (const { file, workflow } of lanes) {
      for (const id of REVIEW_NODE_IDS) {
        const node = workflow.nodes.find(entry => entry.id === id);
        expect({ file, id, found: node !== undefined }).toEqual({ file, id, found: true });
        if (!node) continue;
        expect(isReviewNode(node)).toBe(true);
        const declared = node as {
          failover_provider?: string;
          failover_model?: string;
          failover_agent?: string;
        };
        const provider = effectiveProvider(node, workflow);
        // A declared failover exists and is never Claude.
        expect({ file, id, has: typeof declared.failover_provider === 'string' }).toEqual({
          file,
          id,
          has: true,
        });
        expect({ file, id, failover: declared.failover_provider }).not.toEqual({
          file,
          id,
          failover: 'claude',
        });
        expect(typeof declared.failover_model).toBe('string');
        // The executor's quota route and the seat gate's selector both accept it as a
        // capability-eligible route.
        const route = selectQuotaExhaustionRoute(provider, node, {});
        expect({ file, id, route }).toEqual({
          file,
          id,
          route: {
            kind: 'failover',
            provider: declared.failover_provider as string,
            model: declared.failover_model,
          },
        });
        const chosen = selectSeatNodeFailover({
          node,
          currentProvider: provider,
          hasHeadroom: candidate => candidate === declared.failover_provider,
        });
        expect({ file, id, chosen }).toEqual({ file, id, chosen: declared.failover_provider });
        // The failover target is not a gated seat.
        expect(seatForProvider(declared.failover_provider as string)).toBeNull();
        // The Kimi declaration carries the openrouter review persona on the code-review
        // nodes (zero-claude keeps its own deepseek route, unchanged by this WO).
        if (
          CODE_REVIEW_IDS.includes(id) &&
          personaName(node) === 'codex-adversarial-reviewer' &&
          declared.failover_model === 'moonshotai/kimi-k3.1-pro'
        ) {
          expect({ file, id, agent: declared.failover_agent }).toEqual({
            file,
            id,
            agent: 'opr-adversarial-reviewer',
          });
        }
        checked += 1;
      }
    }
    console.log(`review nodes checked: ${String(checked)} across ${String(lanes.length)} lanes`);
    expect(checked).toBe(91);
  });

  test('review_node_never_selects_claude_even_with_only_claude_headroom', () => {
    let checked = 0;
    for (const { workflow } of loadLanes()) {
      for (const id of REVIEW_NODE_IDS) {
        const node = workflow.nodes.find(entry => entry.id === id);
        if (!node) continue;
        const provider = effectiveProvider(node, workflow);
        if (provider === 'claude') continue;
        expect(
          selectSeatNodeFailover({
            node,
            currentProvider: provider,
            workflowFailoverProvider: 'claude',
            hasHeadroom: candidate => candidate === 'claude',
          })
        ).toBeNull();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('non-review persona nodes rerouted to Claude resolve a model', () => {
  test('rerouted_non_review_persona_resolves_a_model_sweep', async () => {
    const registry = await loadAgentRegistry(join(ROOT, '.archon', 'agents'));
    let checked = 0;
    for (const { file, workflow } of loadLanes()) {
      for (const node of workflow.nodes) {
        if (isReviewNode(node)) continue;
        const name = personaName(node);
        if (!name) continue;
        const provider = effectiveProvider(node, workflow);
        if (provider !== 'codex' && provider !== 'codex-native-strict') continue;
        const persona = resolveAgent(name, registry);
        expect({ file, node: node.id, persona: name, found: persona !== undefined }).toEqual({
          file,
          node: node.id,
          persona: name,
          found: true,
        });
        if (!persona) continue;
        // The same fallback dag-executor applies to a claude per-node override with no
        // model and an assistants config with no claude model.
        const forResolution = {
          ...persona,
          model: persona.model ?? (isReviewNode(node) ? undefined : DEFAULT_CLAUDE_FAILOVER_MODEL),
        };
        const resolved = resolveAgentPersona(forResolution, undefined, 'claude');
        expect({ file, node: node.id, model: resolved.model }).toEqual({
          file,
          node: node.id,
          model: DEFAULT_CLAUDE_FAILOVER_MODEL,
        });
        checked += 1;
      }
    }
    console.log(`non-review codex persona nodes checked: ${String(checked)}`);
    expect(checked).toBeGreaterThan(0);
  });
});
