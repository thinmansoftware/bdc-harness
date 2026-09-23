/**
 * node-timeouts.ts -- Resolves per-node configured timeouts from the workflow
 * definition so the poll watchdog can honor them.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * poll.ts accepts a `nodeTimeoutsMs` map so an open node can be granted its own
 * configured budget instead of the generic 60-minute default (WO-HARNESS-
 * CONDUCTOR-STALL-DETECTOR-FIX-01 Scope IN item 2). That map is the ONLY channel
 * by which a configured timeout can reach the watchdog: the run event feed
 * carries node ids and timestamps only, never the node's `timeout`. Without a
 * production caller that actually populates it, the option is inert and a node
 * configured ABOVE 60 minutes is still cut at 60 -- the healthy-run-cancelled
 * defect this WO exists to fix. This module is that caller's resolver.
 *
 * KEYING
 * ------
 * Keyed by node id. The DAG executor persists `step_name: node.id` on every
 * node_started / node_completed / node_failed event (dag-executor.ts), and
 * poll.ts derives its open-node names from those same `step_name` values, so
 * node id is the correct join key.
 *
 * THE FLOOR -- configured timeouts may only EXTEND, never shorten
 * --------------------------------------------------------------
 * The poll budget measures silence on the PERSISTED EVENT FEED. The workflow
 * timeout fields do not measure the same thing:
 *
 *   - `timeout` (bash / script) IS a sound whole-node bound: it is a subprocess
 *     wall clock the executor enforces, and the node cannot outlive it.
 *   - `idle_timeout` is enforced by `withIdleTimeout()` over SDK message chunks.
 *     Most chunks (assistant text, reasoning) persist NO workflow event, so a
 *     healthy node can be silent on the event feed far longer than its
 *     idle_timeout without the executor considering it idle at all.
 *   - `wall_timeout_ms` is a per-ITERATION cap on a loop node. A loop node stays
 *     open across every iteration, so its total legitimate open time is a
 *     multiple of this value, not this value.
 *
 * Only the first is a safe upper bound on event-feed silence. Rather than
 * special-casing node kinds and betting on the other two, this resolver clamps
 * every resolved budget to `floorMs` (the caller's generous open-node default).
 * A configured timeout can therefore only RAISE a node's budget above the
 * default -- which is exactly the reported defect -- and can never lower it.
 * Lowering is the dangerous direction: it re-creates the original incident of
 * cancelling healthy long-running work, and `implement` (a loop with
 * idle_timeout 600000 / wall_timeout_ms 1800000 that legitimately runs for
 * hours) is precisely the node an unclamped mapping would cut at 30 minutes.
 *
 * FAIL-OPEN
 * ---------
 * Resolution is a best-effort enrichment, never a gate. Any failure (workflow
 * not found, API down, malformed body) yields an empty map, and poll falls back
 * to the same generous default it used before this file existed. Failing a poll
 * because a workflow lookup 404'd would be strictly worse than the status quo.
 *
 * Secret boundary: token comes from the caller or ARCHON_OPERATOR_TOKEN; never
 * hardcoded in source.
 */

import { DEFAULT_OPEN_NODE_BUDGET_MS } from './poll.js';

/** Timeout-bearing fields on a DAG node, as parsed from the workflow definition. */
interface WorkflowNodeShape {
  id?: unknown;
  /** Bash / script subprocess wall clock (ms). */
  timeout?: unknown;
  /** SDK-chunk idle cap (ms). */
  idle_timeout?: unknown;
  /** Per-loop-iteration absolute cap (ms). */
  wall_timeout_ms?: unknown;
}

interface WorkflowShape {
  nodes?: unknown;
}

interface GetWorkflowResponse {
  workflow?: WorkflowShape;
}

/** A finite, strictly positive number, or null. */
function positiveMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Build the `nodeTimeoutsMs` map for a parsed workflow definition.
 *
 * Pure and total -- no I/O, never throws, tolerates an arbitrarily malformed
 * `workflow` object (the API response is parsed JSON, not a trusted type).
 *
 * @param workflow Parsed workflow definition (the `workflow` field of GET
 *                 /api/workflows/:name).
 * @param floorMs  Minimum budget any node may be assigned. Resolved values are
 *                 clamped up to this. Defaults to the poll open-node default.
 * @returns Map of node id -> silence budget (ms). Only nodes whose configured
 *          budget EXCEEDS `floorMs` are included; every other node is omitted so
 *          poll applies `openNodeBudgetMs` unchanged.
 */
export function extractNodeTimeoutsMs(
  workflow: unknown,
  floorMs: number = DEFAULT_OPEN_NODE_BUDGET_MS
): Record<string, number> {
  const out: Record<string, number> = {};
  const nodes = (workflow as WorkflowShape | null | undefined)?.nodes;
  if (!Array.isArray(nodes)) return out;

  for (const raw of nodes) {
    if (raw === null || typeof raw !== 'object') continue;
    const node = raw as WorkflowNodeShape;
    const id = typeof node.id === 'string' ? node.id.trim() : '';
    if (!id) continue;

    // Take the LARGEST configured bound present on the node. A node carrying
    // several (e.g. a loop with both idle_timeout and wall_timeout_ms) is alive
    // as long as the most permissive one allows.
    const configured = Math.max(
      positiveMs(node.timeout) ?? 0,
      positiveMs(node.idle_timeout) ?? 0,
      positiveMs(node.wall_timeout_ms) ?? 0
    );
    if (configured <= 0) continue;

    // Clamp: only an ABOVE-floor configured timeout changes behavior. Emitting a
    // below-floor value would shorten the budget and could cancel healthy work
    // (see the module header).
    if (configured > floorMs) out[id] = configured;
  }

  return out;
}

export interface FetchNodeTimeoutsOptions {
  /** Workflow name as bound to the tier (ladder.config.json workflowName). */
  workflowName: string;
  /** Archon API base URL, e.g. http://localhost:3090. */
  apiBaseUrl: string;
  /** Operator token. Defaults to ARCHON_OPERATOR_TOKEN env. */
  token?: string;
  /** Minimum budget any node may be assigned. See extractNodeTimeoutsMs. */
  floorMs?: number;
}

/**
 * Read a workflow definition from the Archon API and derive its per-node
 * silence budgets for poll's `nodeTimeoutsMs`.
 *
 * NEVER throws and never rejects -- returns {} on any failure so the cascade
 * keeps its previous (generous-default) behavior instead of losing a run to a
 * lookup problem.
 */
export async function fetchNodeTimeoutsMs(
  opts: FetchNodeTimeoutsOptions
): Promise<Record<string, number>> {
  const { workflowName, apiBaseUrl, floorMs = DEFAULT_OPEN_NODE_BUDGET_MS } = opts;
  const token = opts.token ?? process.env.ARCHON_OPERATOR_TOKEN ?? '';

  if (!workflowName) return {};

  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl}/api/workflows/${encodeURIComponent(workflowName)}`, {
      headers: { 'x-archon-operator-token': token },
    });
  } catch (err) {
    console.log(
      `[smart-cauldron/node-timeouts] could not read workflow ${workflowName} ` +
        `(${(err as Error).message}); open nodes fall back to the ${String(floorMs)}ms default`
    );
    return {};
  }

  if (!res.ok) {
    console.log(
      `[smart-cauldron/node-timeouts] HTTP ${String(res.status)} reading workflow ${workflowName}; ` +
        `open nodes fall back to the ${String(floorMs)}ms default`
    );
    return {};
  }

  let body: GetWorkflowResponse;
  try {
    body = (await res.json()) as GetWorkflowResponse;
  } catch (err) {
    console.log(
      `[smart-cauldron/node-timeouts] unparseable workflow body for ${workflowName} ` +
        `(${(err as Error).message}); open nodes fall back to the ${String(floorMs)}ms default`
    );
    return {};
  }

  const map = extractNodeTimeoutsMs(body.workflow, floorMs);
  const count = Object.keys(map).length;
  if (count > 0) {
    console.log(
      `[smart-cauldron/node-timeouts] workflow ${workflowName}: ${String(count)} node(s) ` +
        `configured above the ${String(floorMs)}ms open-node default -- ` +
        Object.entries(map)
          .map(([id, ms]) => `${id}=${String(ms)}ms`)
          .join(', ')
    );
  }
  return map;
}
