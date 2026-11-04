/**
 * Node-level seat reroute (WO-HARNESS-NODE-USAGE-REFUSAL-FAILOVER-01).
 *
 * When the seat a node would run on is at or over the Fuelglass cutoff, the
 * run-start gate used to refuse the whole run unless the node declared a
 * failover. This selector picks the provider the node should run on instead.
 * Fuelglass headroom is the only cap: there is no fixed spend number here.
 */
import {
  getMissingProviderExecutionCapabilities,
  getRegisteredProviders,
  isRegisteredProvider,
} from '@archon/providers';
import { deriveNodeExecutionRequirements } from '../schemas/dag-node';
import type { DagNode } from '../schemas/dag-node';

/**
 * Review node ids (WO-HARNESS-PERSONA-MODEL-DECLARED-01). Board decision D0 on
 * M-20261021c: review seats never fall back to Claude. Every review node in every
 * bdc-feature-development lane declares a non-Claude failover (Kimi K3.1 Pro on
 * the repository-capable OpenRouter tool loop, or the zero-claude lane's own
 * non-Claude route). The seat-node selector drops `claude` from a review node's
 * candidates, and a review node with no other route fails closed with
 * REVIEW_FAILOVER_CLAUDE_REFUSED_D0 instead of quietly running on Claude.
 */
export const REVIEW_NODE_IDS: readonly string[] = [
  'plan-review',
  'war-council-validator',
  'diff-review',
  'diff-review-final',
  'opus-rereview',
  'findings-consolidate',
  'apply-diff-review-final',
];

/** Reason a review node refuses rather than reroute to Claude (D0). */
export const REVIEW_FAILOVER_CLAUDE_REFUSED_D0 = 'review_failover_claude_refused_d0';

/** True when the node id is one of REVIEW_NODE_IDS. */
export function isReviewNodeId(nodeId: string): boolean {
  return REVIEW_NODE_IDS.includes(nodeId);
}

/** True when the node is a review node (D0 applies: never reroute it to Claude). */
export function isReviewNode(node: { id: string }): boolean {
  return isReviewNodeId(node.id);
}

/**
 * Last-resort Claude model for a NON-review node rerouted to Claude when neither
 * the node's failover_model nor config assistants.claude.model is set. Without
 * it the per-node override carries no model and a model-less persona throws
 * "must declare a 'model:'" (run 8849e767). Source: harness model allowlist
 * (xo-wiki doctrine harness-model-allowlist-gpt6-claude55-fable51), strongest
 * allowed Claude model. NEVER applied to a review node: review nodes do not
 * reroute to Claude at all (D0).
 */
export const DEFAULT_CLAUDE_FAILOVER_MODEL = 'claude-opus-5-5';

export interface SeatNodeFailoverInput {
  node: DagNode;
  /** Provider the node currently resolves to (the over-cutoff one). */
  currentProvider: string;
  /** Workflow-level declared failover provider, if any. */
  workflowFailoverProvider?: string;
  /**
   * True when the candidate provider's seat is admissible: not the same seat as
   * the node's current seat, and its Fuelglass reading is under the cutoff,
   * UNKNOWN, on-credits, or the provider maps to no seat.
   */
  hasHeadroom: (providerId: string) => boolean;
}

/**
 * Return the provider a node on an over-cutoff seat should run on, or null when
 * no candidate is admissible. Order: the node's declared failover provider, the
 * workflow-level failover provider, then every other registered provider in
 * registry order (claude is first in registry order). For a review node the
 * provider `claude` is removed from the candidates wherever it came from -- a
 * declared claude failover is ignored, never honored (D0).
 */
export function selectSeatNodeFailover(input: SeatNodeFailoverInput): string | null {
  const declared = input.node as { failover_provider?: string };
  const candidates: string[] = [];
  const push = (id: string | undefined): void => {
    if (id && !candidates.includes(id)) candidates.push(id);
  };
  push(declared.failover_provider);
  push(input.workflowFailoverProvider);
  for (const registration of getRegisteredProviders()) push(registration.id);

  const required = deriveNodeExecutionRequirements(input.node);
  const review = isReviewNode(input.node);
  for (const candidate of candidates) {
    if (candidate === input.currentProvider) continue;
    if (review && candidate === 'claude') continue;
    if (!isRegisteredProvider(candidate)) continue;
    if (getMissingProviderExecutionCapabilities(candidate, required).length > 0) continue;
    if (!input.hasHeadroom(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Clone a node so it dispatches on the rerouted provider from its first
 * attempt. The model is cleared on purpose so the primary provider's model id
 * never leaks to the new provider; the provider's own configured model applies.
 * No model id is introduced here.
 *
 * A declared persona stays on the node (instructions and tool restrictions are
 * kept). The executor also writes a per-node model override for the route, which
 * the persona binding reads to adapt the persona's model pin to the new provider.
 */
export function buildSeatRerouteNode(
  node: DagNode,
  provider: string,
  failoverModel?: string,
  failoverAgent?: string
): DagNode {
  return {
    ...node,
    provider,
    model: failoverModel,
    ...(failoverAgent !== undefined ? { agent: failoverAgent, persona: undefined } : {}),
  } as DagNode;
}
