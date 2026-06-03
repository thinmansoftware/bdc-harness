/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: custom ReactFlow edge that renders a
 * self-repair loop-back as a clean right-gutter side-rail.
 *
 * Routing:
 *   - source.right -> right to gutterX (provided by routeLoopArcsAsSideRail
 *     in dag-layout.ts via edge.data.gutterX)
 *   - down (or up) the gutter
 *   - left back to target.right
 *
 * Geometric invariant: gutterX is computed in dag-layout.ts to be greater than
 * every forward node's right edge + SIDE_RAIL_GUTTER_PX, so the vertical
 * gutter segment CANNOT pass through a forward node's bounding box.
 *
 * Idle/healthy runs render the arc with reduced opacity (count === 0). When
 * the loop has actually fired, the iteration count renders as the arc label.
 */
import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';

export interface LoopArcEdgeData {
  /** Right-gutter x coordinate, shared across all loop arcs in the run. */
  gutterX: number;
  /** Number of traversals; 0 means the arc is present in the topology but
   *  has not fired yet (idle / dim). */
  count: number;
  /** Pre-formatted label string ("" when count === 0). */
  label?: string;
  /** Forwarded arc-type from LoopArc (self-loop / review-repair / gate-resume). */
  loopArcType?: 'self-loop' | 'review-repair' | 'gate-resume';
  /** True when source === target. */
  isSelf?: boolean;
  [key: string]: unknown;
}

function LoopArcEdgeRender(props: EdgeProps): React.ReactElement {
  const { id, sourceX, sourceY, targetX, targetY, data } = props;
  const arcData = (data as LoopArcEdgeData | undefined) ?? {
    gutterX: 0,
    count: 0,
  };
  const gutterX = arcData.gutterX;
  const count = arcData.count;
  const isSelf = arcData.isSelf === true;

  // Self-loops use the source y as the only anchor and circle back through
  // the gutter at +20px so the loop is visible above the node.
  const selfLoopOffsetY = 30;
  const startY = sourceY;
  const endY = isSelf ? sourceY - selfLoopOffsetY : targetY;

  // Build the path: from (sourceX, sourceY) right to gutterX, down/up the
  // gutter, then left to (targetX, endY).
  // Use cubic beziers for smooth corners; the geometric invariant
  // (gutterX > max forward node right edge) is what guarantees no spine
  // crossing — the bezier curvature is purely cosmetic.
  const cornerRadius = 16;
  const enterX = gutterX;
  const exitX = gutterX;
  const path = [
    `M ${String(sourceX)},${String(startY)}`,
    // Horizontal segment with a curved corner into the gutter
    `L ${String(enterX - cornerRadius)},${String(startY)}`,
    `Q ${String(enterX)},${String(startY)} ${String(enterX)},${String(startY + (endY > startY ? cornerRadius : -cornerRadius))}`,
    // Vertical gutter segment
    `L ${String(exitX)},${String(endY - (endY > startY ? cornerRadius : -cornerRadius))}`,
    // Curved corner out of the gutter, horizontal back to target
    `Q ${String(exitX)},${String(endY)} ${String(exitX - cornerRadius)},${String(endY)}`,
    `L ${String(targetX)},${String(endY)}`,
  ].join(' ');

  const dim = count <= 0;
  const stroke = dim ? 'var(--text-tertiary)' : 'var(--warning)';
  const opacity = dim ? 0.35 : 0.85;

  // Label centered on the gutter midpoint.
  const labelX = gutterX;
  const labelY = (startY + endY) / 2;
  const label = arcData.label ?? (count > 0 ? String(count) : '');

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke,
          strokeWidth: 1.5,
          strokeDasharray: '6 4',
          opacity,
          fill: 'none',
        }}
      />
      {label.length > 0 && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${String(labelX)}px, ${String(labelY)}px)`,
              pointerEvents: 'none',
              fontSize: 10,
              fontWeight: 600,
              padding: '1px 4px',
              borderRadius: 4,
              background: 'var(--surface)',
              color: 'var(--warning)',
              border: '1px solid var(--border)',
            }}
            data-testid={`loop-arc-label-${id}`}
          >
            x{label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const loopArcEdgeComponent = memo(LoopArcEdgeRender);
