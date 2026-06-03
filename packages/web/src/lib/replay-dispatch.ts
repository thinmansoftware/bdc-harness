/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 — replay dispatch builder.
 *
 * v1: per-node replay is not yet supported by the engine — so a "replay"
 * action re-fires the WO (the parent workflow). When the operator picks
 * "replay with alt model" we both:
 *   1. prepend a `[model:<name>]` marker to the message (visible in the
 *      audit log so operators can SEE which override was attempted, and
 *      consumable by future orchestrator-side marker parsers), AND
 *   2. populate the structured `model` field so the API client
 *      (`runWorkflow`) can forward it on the wire as a first-class
 *      `model` body field. This avoids the silent-discard pattern the
 *      diff reviewer flagged — the override is no longer trapped in the
 *      client; it actually leaves the browser.
 *
 * TODO: per-node replay — fast-follow: engine node-level replay not yet
 * supported. When the engine exposes a node-level replay endpoint, swap
 * `buildReplayRequest` for one that hits that endpoint directly.
 *
 * Pure: no React, no I/O.
 */

export interface ReplayRequest {
  message: string;
  model?: string;
}

export function buildReplayRequest(
  _workflowName: string,
  originalMessage: string,
  altModel?: string
): ReplayRequest {
  const base = originalMessage ?? '';
  if (altModel && altModel.length > 0) {
    return {
      message: `[model:${altModel}] ${base}`,
      model: altModel,
    };
  }
  return { message: base };
}
