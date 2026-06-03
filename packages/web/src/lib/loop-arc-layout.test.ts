/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 Scenario 3 — geometric assertion that
 * loop arcs are routed as a clean side-rail, not crossing the forward
 * spine.
 *
 * Setup: a 3-node forward chain A -> B -> C with a back-edge C -> A.
 *  - dagre must receive only the forward edges (so it produces a clean
 *    vertical spine in TB layout).
 *  - the back-arc must be re-added with id prefix `__loop_`.
 *  - its computed sideRailX must be strictly greater than max(node.x) +
 *    NODE_WIDTH (the right edge of the spine), so it cannot overlap.
 */
import { describe, expect, it } from 'bun:test';
import type { Edge } from '@xyflow/react';
import { NODE_WIDTH, layoutWithDagre, routeLoopArcsAsSideRail } from './dag-layout';
import type { DagFlowNode } from '@/components/workflows/DagNodeComponent';
import type { LoopArc } from './dag-self-repair-loop';

function makeNode(id: string): DagFlowNode {
  return {
    id,
    type: 'dagNode',
    position: { x: 0, y: 0 },
    data: { id, label: id, nodeType: 'prompt' as const },
  };
}

describe('routeLoopArcsAsSideRail (Scenario 3)', () => {
  it('feeds only forward edges to dagre and routes back-edges to a right gutter', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')];
    const forwardEdges: Edge[] = [
      { id: 'A->B', source: 'A', target: 'B', type: 'smoothstep' },
      { id: 'B->C', source: 'B', target: 'C', type: 'smoothstep' },
    ];
    const loopArcs: LoopArc[] = [
      { id: '__loop_rr__:C->A', source: 'C', target: 'A', type: 'review-repair', count: 2 },
    ];

    // Step 1: dagre lays out forward graph only.
    const { nodes: laid, edges: laidEdges } = layoutWithDagre(nodes, forwardEdges);
    // Forward edges are returned as-is; back-edges should NOT be present yet.
    expect(laidEdges.some(e => e.id.startsWith('__loop_'))).toBe(false);

    // Step 2: side-rail router adds the back-edge with sideRail metadata.
    const merged = routeLoopArcsAsSideRail(laid, laidEdges, loopArcs);
    const backEdges = merged.filter(e => e.id.startsWith('__loop_'));
    expect(backEdges.length).toBe(1);
    const back = backEdges[0];

    // Geometric assertion: the gutter x is strictly to the right of the
    // forward spine's right edge.
    let maxForwardRight = 0;
    for (const n of laid) {
      const right = (n.position?.x ?? 0) + NODE_WIDTH;
      if (right > maxForwardRight) maxForwardRight = right;
    }
    const data = back.data as { sideRailX?: number } | undefined;
    expect(data?.sideRailX).toBeDefined();
    expect(data?.sideRailX as number).toBeGreaterThan(maxForwardRight);

    // Style sanity: dashed warning stroke, label with iteration count.
    expect(back.label).toBe('x2');
    expect((back.style as { strokeDasharray?: string }).strokeDasharray).toBe('6 4');

    // Contract: back-edges must use the custom `loopSideRail` edge type so the
    // gutter routing actually fires. Storing `sideRailX` in `data` without a
    // consumer would make the side-rail claim false (the default smoothstep
    // edge ignores `data` entirely). Asserting the type pins the contract
    // between `routeLoopArcsAsSideRail` and `LoopSideRailEdge`.
    expect(back.type).toBe('loopSideRail');
  });

  it('returns base edges unchanged when there are no loop arcs', () => {
    const baseEdges: Edge[] = [{ id: 'A->B', source: 'A', target: 'B', type: 'smoothstep' }];
    const merged = routeLoopArcsAsSideRail([makeNode('A'), makeNode('B')], baseEdges, []);
    expect(merged.length).toBe(1);
    expect(merged[0].id).toBe('A->B');
  });

  it('drops a loop arc whose source or target is not in the base node set', () => {
    const baseEdges: Edge[] = [];
    const merged = routeLoopArcsAsSideRail([makeNode('A')], baseEdges, [
      { id: '__loop_x__:ghost->A', source: 'ghost', target: 'A', type: 'self-loop', count: 1 },
    ]);
    // Ghost was dropped; only base edges remain (empty).
    expect(merged.length).toBe(0);
  });

  it('staggers multiple loop arcs to non-overlapping y offsets', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')];
    const baseEdges: Edge[] = [
      { id: 'A->B', source: 'A', target: 'B', type: 'smoothstep' },
      { id: 'B->C', source: 'B', target: 'C', type: 'smoothstep' },
    ];
    const arcs: LoopArc[] = [
      { id: '__loop_a__:C->A', source: 'C', target: 'A', type: 'review-repair', count: 1 },
      { id: '__loop_b__:C->B', source: 'C', target: 'B', type: 'review-repair', count: 1 },
    ];
    const merged = routeLoopArcsAsSideRail(nodes, baseEdges, arcs);
    const backs = merged.filter(e => e.id.startsWith('__loop_'));
    expect(backs.length).toBe(2);
    const o0 = (backs[0].data as { sideRailOffset?: number }).sideRailOffset;
    const o1 = (backs[1].data as { sideRailOffset?: number }).sideRailOffset;
    expect(o0).not.toBe(o1);
  });
});
