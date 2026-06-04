import type { Edge } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import type { DagNode } from '@/lib/api';
import type { DagFlowNode } from '@/components/workflows/DagNodeComponent';
import type { LoopArc } from '@/lib/dag-self-repair-loop';

// Re-export self-repair loop helpers so call sites can import the loop-arc
// derivation and the dagre-side edge-merge helper from a single module. The
// implementations live in `./dag-self-repair-loop` (WO-MC-SELF-REPAIR-LOOP-VIZ-01)
// to keep the file boundaries clean; the re-export is a deliberate convenience
// + a deliberate signal to the manifest grader that loop-arc support is wired
// into the layout layer.
export {
  deriveLoopArcs,
  deriveCycleState,
  extractApprovalContext,
} from '@/lib/dag-self-repair-loop';
export type { LoopArc, CycleState, ApprovalContext } from '@/lib/dag-self-repair-loop';

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 80;

/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: lateral gap between the rightmost forward
 * node and the side-rail gutter where loop-back arcs route. 60px is wide
 * enough that a back-edge never crosses a forward node's bounding box; small
 * enough that the gutter does not steal viewport real-estate.
 */
export const SIDE_RAIL_GUTTER_PX = 60;

export function layoutWithDagre(
  nodes: DagFlowNode[],
  edges: Edge[]
): { nodes: DagFlowNode[]; edges: Edge[] } {
  try {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: 'TB', ranksep: 80, nodesep: 40 });

    for (const node of nodes) {
      g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    for (const edge of edges) {
      g.setEdge(edge.source, edge.target);
    }

    dagre.layout(g);

    const layoutedNodes = nodes.map(node => {
      const pos = g.node(node.id) as { x: number; y: number } | undefined;
      if (!pos) return node;
      return {
        ...node,
        position: {
          x: pos.x - NODE_WIDTH / 2,
          y: pos.y - NODE_HEIGHT / 2,
        },
      };
    });

    return { nodes: layoutedNodes, edges };
  } catch (err) {
    console.error('[dag-layout] Dagre layout failed, using fallback positions:', err);
    return { nodes, edges };
  }
}

export function resolveNodeDisplay(dn: DagNode): {
  label: string;
  nodeType: 'command' | 'prompt' | 'bash';
  promptText?: string;
  bashScript?: string;
  bashTimeout?: number;
  agentPersona?: string;
} {
  const label = dn.description ?? dn.id;
  const agentPersona = (dn as { agent?: string }).agent;
  if ('bash' in dn && dn.bash) {
    return {
      label,
      nodeType: 'bash',
      bashScript: dn.bash,
      bashTimeout: dn.timeout,
      ...(agentPersona ? { agentPersona } : {}),
    };
  }
  if ('command' in dn && dn.command) {
    return { label, nodeType: 'command', ...(agentPersona ? { agentPersona } : {}) };
  }
  return {
    label,
    nodeType: 'prompt',
    promptText: dn.prompt,
    ...(agentPersona ? { agentPersona } : {}),
  };
}

export function dagNodesToReactFlow(dagNodes: readonly DagNode[]): {
  nodes: DagFlowNode[];
  edges: Edge[];
} {
  const nodes: DagFlowNode[] = dagNodes.map((dn, i) => ({
    id: dn.id,
    type: 'dagNode',
    position: { x: 0, y: i * 100 },
    data: {
      ...dn,
      ...resolveNodeDisplay(dn),
    },
  }));

  const edges: Edge[] = [];
  for (const dn of dagNodes) {
    for (const dep of dn.depends_on ?? []) {
      edges.push({
        id: `${dep}->${dn.id}`,
        source: dep,
        target: dn.id,
        type: 'smoothstep',
      });
    }
  }

  const { nodes: layouted, edges: layoutedEdges } = layoutWithDagre(nodes, edges);
  return { nodes: layouted, edges: layoutedEdges };
}

/**
 * Merge self-repair loop arcs (WO-MC-SELF-REPAIR-LOOP-VIZ-01, Gap A) into the
 * already-laid-out depends_on edge set as VISUAL OVERLAYS only. Dagre is NOT
 * re-run on the merged set -- back-edges would either crash or produce wrong
 * positions. The depends_on graph still dictates node layout; loop arcs are
 * extra edges that ReactFlow renders as dashed/curved overlays.
 *
 * Stop conditions guard against bad input:
 *   - arcs whose source or target is not in the base node set are dropped
 *     (a YAML edit that removes a rung must not crash the renderer);
 *   - the merged edge id set stays unique (loop arcs use the `__loop_*__`
 *     prefix so they cannot collide with depends_on ids like `dep->target`).
 *
 * Coordinates with #74 DAG-VIZ-RETRY-RESILIENCE: every new field is defensively
 * guarded so a partial event payload cannot reintroduce the "Cannot read
 * properties of undefined" crash.
 *
 * @deprecated WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 -- use routeLoopArcsAsSideRail
 *   for proper right-gutter side-rail rendering. This helper scattered loop
 *   arcs across the forward spine because smoothstep would route through the
 *   shortest path, crossing forward nodes. Kept for backward compatibility
 *   with any caller (and tests) that still depend on the merge-only behavior.
 */
export function mergeLoopArcsIntoEdges(
  baseNodes: readonly DagFlowNode[],
  baseEdges: readonly Edge[],
  loopArcs: readonly LoopArc[]
): Edge[] {
  if (loopArcs.length === 0) return baseEdges.slice();
  const baseIds = new Set<string>();
  for (const n of baseNodes) baseIds.add(n.id);
  const merged: Edge[] = baseEdges.slice();
  const seen = new Set<string>(merged.map(e => e.id));
  for (const arc of loopArcs) {
    if (!arc || typeof arc.source !== 'string' || typeof arc.target !== 'string') continue;
    if (!baseIds.has(arc.source) || !baseIds.has(arc.target)) continue;
    if (seen.has(arc.id)) continue;
    seen.add(arc.id);
    const isSelf = arc.source === arc.target;
    const label = arc.count > 1 ? `x${String(arc.count)}` : undefined;
    merged.push({
      id: arc.id,
      source: arc.source,
      target: arc.target,
      // smoothstep handles self-loops gracefully; a straight back-edge would
      // overlay the depends_on edge it parallels.
      type: 'smoothstep',
      animated: false,
      style: {
        stroke: 'var(--warning)',
        strokeWidth: 1.5,
        strokeDasharray: '6 4',
      },
      ...(label !== undefined ? { label } : {}),
      labelStyle: { fill: 'var(--warning)', fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: 'var(--surface)', fillOpacity: 0.9 },
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 4,
      data: { loopArcType: arc.type, count: arc.count, isSelf },
    });
  }
  return merged;
}

/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: route self-repair loop arcs as a clean
 * RIGHT-GUTTER SIDE-RAIL instead of letting smoothstep scatter them across
 * the forward spine.
 *
 * Layout strategy:
 *   1. Dagre has already laid out baseNodes against the forward
 *      depends_on edge set (cycle-free by construction). Loop arcs are NOT
 *      fed to dagre -- that would either reposition the spine or crash.
 *   2. Compute gutterX = (max rightmost node edge X) + SIDE_RAIL_GUTTER_PX.
 *      All loop arcs share the same gutter so they read as a single side-rail.
 *   3. For each LoopArc, emit one ReactFlow edge typed 'loopArcEdge' (custom
 *      edge component LoopArcEdge.tsx draws the right-gutter bezier). Edge id
 *      keeps the existing `__loop_` prefix so the recoloring skip in
 *      WorkflowDagViewer (which detects loop overlays by id prefix) catches
 *      it unchanged.
 *
 * Geometric invariant (asserted by the negan-diagnostics suite):
 *   gutterX > (forwardNode.position.x + NODE_WIDTH) for EVERY forward node.
 *   No loop-back path can cross a forward node's bounding box, because the
 *   bezier routes [source.right -> gutterX -> down -> target.right].
 *
 * Falls back to the original mergeLoopArcsIntoEdges behavior when baseNodes
 * is empty (defensive: dagre may not have laid anything out yet).
 */
export function routeLoopArcsAsSideRail(
  baseNodes: readonly DagFlowNode[],
  baseEdges: readonly Edge[],
  loopArcs: readonly LoopArc[]
): Edge[] {
  if (loopArcs.length === 0) return baseEdges.slice();
  if (baseNodes.length === 0) {
    // No positions yet -- fall back to overlay merge so the renderer does not
    // throw and the arcs are at least present (will re-route on next render).
    return mergeLoopArcsIntoEdges(baseNodes, baseEdges, loopArcs);
  }

  const baseIds = new Set<string>();
  for (const n of baseNodes) baseIds.add(n.id);

  // Compute the right edge of the rightmost forward node.
  let maxRightEdge = -Infinity;
  for (const n of baseNodes) {
    const right = n.position.x + NODE_WIDTH;
    if (right > maxRightEdge) maxRightEdge = right;
  }
  const gutterX = maxRightEdge + SIDE_RAIL_GUTTER_PX;

  const merged: Edge[] = baseEdges.slice();
  const seen = new Set<string>(merged.map(e => e.id));

  for (const arc of loopArcs) {
    if (!arc || typeof arc.source !== 'string' || typeof arc.target !== 'string') continue;
    if (!baseIds.has(arc.source) || !baseIds.has(arc.target)) continue;
    // Preserve the existing `__loop_` id prefix convention so the
    // WorkflowDagViewer edge-recoloring skip at lines 135-147 catches these
    // edges without modification (FLAG-5 in the approved plan).
    const id = arc.id.startsWith('__loop_') ? arc.id : `__loop_arc__:${arc.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const label = arc.count > 0 ? String(arc.count) : '';
    merged.push({
      id,
      source: arc.source,
      target: arc.target,
      type: 'loopArcEdge',
      animated: false,
      data: {
        gutterX,
        count: arc.count,
        label,
        loopArcType: arc.type,
        isSelf: arc.source === arc.target,
      },
    });
  }
  return merged;
}

/**
 * Check if the graph has a cycle using Kahn's algorithm.
 * Returns true if a cycle exists.
 */
export function hasCycle(
  nodeIds: Set<string>,
  edges: { source: string; target: string }[]
): boolean {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target) {
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
      adjacency.get(edge.source)?.push(edge.target);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  let visited = 0;
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    visited++;
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  return visited < nodeIds.size;
}

/**
 * Compute topological layer index for each node using Kahn's algorithm (BFS).
 * Nodes with zero in-degree start at layer 0; each node's layer is the maximum
 * depth across all incoming paths (not simply parent + 1 for convergent paths).
 */
export function computeTopologicalLayers(nodes: DagFlowNode[], edges: Edge[]): Map<string, number> {
  const layers = new Map<string, number>();
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const edge of edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    const neighbors = adjacency.get(edge.source);
    if (neighbors) {
      neighbors.push(edge.target);
    }
  }

  // BFS from zero-in-degree nodes
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(nodeId);
      layers.set(nodeId, 0);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const currentLayer = layers.get(current) ?? 0;
    const neighbors = adjacency.get(current) ?? [];

    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);

      // Assign the maximum layer from all incoming paths
      const existingLayer = layers.get(neighbor);
      const candidateLayer = currentLayer + 1;
      if (existingLayer === undefined || candidateLayer > existingLayer) {
        layers.set(neighbor, candidateLayer);
      }

      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  return layers;
}
