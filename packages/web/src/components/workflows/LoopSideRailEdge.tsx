/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 — LoopSideRailEdge.
 *
 * Custom ReactFlow edge that ACTUALLY routes a loop back-arc through a
 * right-gutter side-rail (vs the default smoothstep path that just bends
 * directly between source and target and can cross the forward spine).
 *
 * The companion helper `routeLoopArcsAsSideRail` (in `lib/dag-layout.ts`)
 * stamps `data.sideRailX` (the gutter x) and `data.sideRailOffset` (per-arc
 * y stagger) onto each back-edge. This component reads that metadata and
 * emits an explicit SVG path:
 *
 *   source.right -> (gutterX + offset, source.y)
 *                -> (gutterX + offset, target.y)
 *                -> target.right
 *
 * That keeps the back-edge OUTSIDE the forward spine — it travels in the
 * right gutter, never crossing forward edges. For self-loops the path
 * makes a small loop in the gutter at the source y.
 *
 * Why a custom edge instead of just stamping data:
 *   The diff reviewer (codex) flagged that storing `sideRailX` in `data`
 *   without a consuming renderer means the routing claim is FALSE — the
 *   default smoothstep edge ignores `data` entirely. This component is
 *   the consumer that makes the side-rail real.
 */

import { memo } from 'react';
import { BaseEdge } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';

interface LoopSideRailData {
  /** Computed gutter x (max forward node x + NODE_WIDTH + pad). Set by
   *  `routeLoopArcsAsSideRail`. Fallback: route directly if missing. */
  sideRailX?: number;
  /** Per-arc y stagger so multiple arcs do not overlap. */
  sideRailOffset?: number;
  /** True if source === target (self-loop). */
  isSelf?: boolean;
  /** Iteration count for the loop arc; shown as `xN` label. */
  count?: number;
  /** Loop arc semantic type — review-repair / gate-resume / self-loop. */
  loopArcType?: string;
}

/**
 * Build the SVG path for a side-rail back-edge.
 *
 * The path is an orthogonal polyline routed through the right gutter:
 *   M sourceX sourceY
 *   H gutterX                 (exit horizontally to the gutter)
 *   V targetY                 (travel vertically along the gutter)
 *   H targetX                 (return horizontally to the target)
 *
 * For self-loops (source === target), the path goes out to the gutter,
 * down a fixed self-loop height, then back to the target — drawing a
 * small loop in the gutter that does not overlap the node itself.
 *
 * Exported for unit-testing the geometry (Scenario 3 of the WO).
 */
const SELF_LOOP_HEIGHT = 40;

export function buildSideRailPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  gutterX: number,
  offset: number,
  isSelf: boolean
): string {
  const railX = gutterX + offset;
  if (isSelf) {
    // Small loop in the gutter at the source row.
    const loopBottomY = sourceY + SELF_LOOP_HEIGHT;
    return [
      `M ${sourceX.toString()} ${sourceY.toString()}`,
      `H ${railX.toString()}`,
      `V ${loopBottomY.toString()}`,
      `H ${targetX.toString()}`,
      `V ${targetY.toString()}`,
    ].join(' ');
  }
  return [
    `M ${sourceX.toString()} ${sourceY.toString()}`,
    `H ${railX.toString()}`,
    `V ${targetY.toString()}`,
    `H ${targetX.toString()}`,
  ].join(' ');
}

function LoopSideRailEdgeRender(
  props: EdgeProps & { data?: LoopSideRailData }
): React.ReactElement {
  const { id, sourceX, sourceY, targetX, targetY, style, markerEnd, data, label, labelStyle } =
    props;
  const gutterX = data?.sideRailX ?? sourceX;
  const offset = data?.sideRailOffset ?? 0;
  const isSelf = data?.isSelf ?? false;

  const path = buildSideRailPath(sourceX, sourceY, targetX, targetY, gutterX, offset, isSelf);

  // Place label at the vertical midpoint of the gutter segment so it sits
  // out in the side-rail (not over the forward spine).
  const labelX = gutterX + offset;
  const labelY = isSelf ? sourceY + SELF_LOOP_HEIGHT / 2 : (sourceY + targetY) / 2;

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {label !== undefined && (
        <text
          x={labelX}
          y={labelY}
          textAnchor="middle"
          dominantBaseline="central"
          style={labelStyle}
          // Foreground above the path so the label is readable.
          className="pointer-events-none select-none"
        >
          {label}
        </text>
      )}
    </>
  );
}

export const loopSideRailEdge = memo(LoopSideRailEdgeRender);
