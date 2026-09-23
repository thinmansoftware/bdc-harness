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
 * THE FLOOR -- only non-whole-node timeouts must exceed the default
 * ---------------------------------------------------------------
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
 * A valid `timeout` is preserved as configured, even at or below `floorMs`.
 * The other two fields may only extend a budget above `floorMs`, never shorten
 * it. With a valid `timeout`, use the maximum of that bound and any valid
 * non-whole-node value above `floorMs`. Without one, emit only the largest
 * non-whole-node value if it exceeds `floorMs`; otherwise omit the node so poll
 * uses its default. Only finite, strictly positive numbers are valid.
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
 * @param floorMs  Threshold that non-whole-node fields must exceed to extend a
 *                 budget. Defaults to the poll open-node default.
 * @returns Map of node id -> silence budget (ms). Valid `timeout` values are
 *          preserved even at or below `floorMs`, taking the maximum with any
 *          `idle_timeout` or `wall_timeout_ms` above `floorMs`. Without a valid
 *          `timeout`, only the largest non-whole-node value above `floorMs` is
 *          emitted. Invalid values (anything other than finite, positive
 *          numbers) are ignored; nodes with no qualifying values are omitted.
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

    const timeout = positiveMs(node.timeout);
    const extension = Math.max(
      positiveMs(node.idle_timeout) ?? 0,
      positiveMs(node.wall_timeout_ms) ?? 0
    );
    if (extension > 0 && extension > floorMs) {
      out[id] = Math.max(timeout ?? 0, extension);
    } else if (timeout !== null) {
      out[id] = timeout;
    }
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
  /** Threshold for non-whole-node extensions. See extractNodeTimeoutsMs. */
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
        `with configured budgets (open-node default: ${String(floorMs)}ms) -- ` +
        Object.entries(map)
          .map(([id, ms]) => `${id}=${String(ms)}ms`)
          .join(', ')
    );
  }
  return map;
}
