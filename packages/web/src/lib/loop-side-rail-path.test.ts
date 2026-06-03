/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 — geometric assertion that the loop
 * back-edge SVG path actually travels through the right gutter.
 *
 * Pins the contract that the custom `loopSideRail` edge component reads
 * `data.sideRailX` / `data.sideRailOffset` and emits an orthogonal path:
 *
 *   M sx sy  H railX  V ty  H tx
 *
 * If a future refactor swaps the custom edge back to smoothstep, the
 * path will no longer touch railX and these assertions will fail.
 */
import { describe, expect, it } from 'bun:test';
import { buildSideRailPath } from '@/components/workflows/LoopSideRailEdge';

describe('buildSideRailPath (Scenario 3 follow-up)', () => {
  it('routes a non-self back-edge through the right gutter', () => {
    // sourceX = 100, sourceY = 300 (lower node, e.g. C)
    // targetX = 100, targetY = 100 (upper node, e.g. A)
    // gutterX = 300 (right of the forward spine)
    const path = buildSideRailPath(100, 300, 100, 100, 300, 0, false);
    // The path MUST contain the gutter x as a horizontal-then-vertical bend.
    expect(path).toBe('M 100 300 H 300 V 100 H 100');
  });

  it('applies the per-arc offset so multiple arcs do not overlap', () => {
    const arc0 = buildSideRailPath(100, 300, 100, 100, 300, 0, false);
    const arc1 = buildSideRailPath(100, 300, 100, 100, 300, 20, false);
    expect(arc0).not.toBe(arc1);
    // arc1's vertical leg must be 20 px further right than arc0's.
    expect(arc1).toBe('M 100 300 H 320 V 100 H 100');
  });

  it('draws a self-loop in the gutter without overlapping the node', () => {
    // Self-loop: source === target at (100, 200).
    const path = buildSideRailPath(100, 200, 100, 200, 300, 0, true);
    // Goes out to the gutter, down a fixed loop height, back to the node.
    // The vertical leg at railX must extend BELOW the source y (so the
    // loop sits in the gutter, not on top of the node).
    expect(path).toContain('M 100 200');
    expect(path).toContain('H 300');
    // The downward leg's end y must be greater than the source y (drops
    // into the gutter below the node).
    const match = path.match(/V (\d+)/);
    expect(match).not.toBeNull();
    if (match) {
      const downTo = Number(match[1]);
      expect(downTo).toBeGreaterThan(200);
    }
  });

  it('falls back gracefully when offset is zero and gutterX is the only rail position', () => {
    const path = buildSideRailPath(50, 50, 80, 250, 200, 0, false);
    // Forward spine right edge ~ 80; gutter at 200. The middle vertical
    // leg MUST be at x=200 (gutter), not somewhere in between (which
    // would risk crossing forward nodes).
    expect(path).toBe('M 50 50 H 200 V 250 H 80');
  });
});
