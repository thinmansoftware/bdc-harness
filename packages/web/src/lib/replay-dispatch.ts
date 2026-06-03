/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 — replay dispatch builder.
 *
 * v1: per-node replay is not yet supported by the engine — so a "replay"
 * action re-fires the WO (the parent workflow). When the operator picks
 * "replay with alt model" we prepend a `[model:<name>]` marker to the
 * message so the dispatch can be routed to a model override on the server
 * side (or, at minimum, the marker is visible in the audit log so the
 * operator can see which override was attempted).
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
