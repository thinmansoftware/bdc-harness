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
 * registry order.
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
  for (const candidate of candidates) {
    if (candidate === input.currentProvider) continue;
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
