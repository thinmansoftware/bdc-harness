/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 Scenario 6 — cost burn meter.
 *
 * computeCostMeter degrades gracefully when DashboardRunResponse lacks
 * `cost_usd` (Ambiguity #2) — it returns count+elapsed only, no faked dollar
 * value, with isEstimate=true so the UI can label the degraded mode.
 */
import { describe, expect, it } from 'bun:test';
import { computeCostMeter, type CostMeterRun } from './fleet-cost';

const NOW = new Date('2026-06-03T10:21:00Z').getTime();
const STARTED = '2026-06-03T10:00:00Z';

describe('computeCostMeter', () => {
  it('renders count + elapsed (no fake dollar) when no run has cost_usd', () => {
    const runs: CostMeterRun[] = [{ started_at: STARTED }, { started_at: STARTED }];
    const r = computeCostMeter(runs, NOW);
    expect(r.hasLiveCost).toBe(false);
    expect(r.isEstimate).toBe(true);
    expect(r.totalCostUsd).toBe(0);
    expect(r.displayValue).toContain('2 runs');
    expect(r.displayValue).toContain('21min');
  });

  it('sums cost_usd and emits hasLiveCost=true when costs are present', () => {
    const runs: CostMeterRun[] = [
      { started_at: STARTED, cost_usd: 4.83 },
      { started_at: STARTED, cost_usd: 0.42 },
    ];
    const r = computeCostMeter(runs, NOW);
    expect(r.hasLiveCost).toBe(true);
    expect(r.isEstimate).toBe(false);
    expect(r.totalCostUsd).toBeCloseTo(5.25, 5);
    // formatCostUsd format: "$5.25 / 21min"
    expect(r.displayValue).toContain('$5.25');
    expect(r.displayValue).toContain('21min');
  });

  it('returns "0 runs" with zero totals for an empty fleet', () => {
    const r = computeCostMeter([], NOW);
    expect(r.displayValue).toBe('0 runs');
    expect(r.hasLiveCost).toBe(false);
    expect(r.totalCostUsd).toBe(0);
    expect(r.elapsedMs).toBe(0);
  });

  it('uses the earliest started_at for the elapsed window', () => {
    const runs: CostMeterRun[] = [
      { started_at: '2026-06-03T10:10:00Z' },
      { started_at: STARTED }, // earlier
    ];
    const r = computeCostMeter(runs, NOW);
    // 21min back to 10:00 (earliest)
    expect(r.elapsedMs).toBeGreaterThanOrEqual(20 * 60_000);
  });
});
