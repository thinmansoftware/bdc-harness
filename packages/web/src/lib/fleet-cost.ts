/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 — fleet grouping + cost meter.
 *
 * Pure helpers for FleetStrip. Two functions:
 *
 *   - groupRunsByCodebase: group live runs by their codebase binding so
 *     CoFireBadge can flag any codebase with >=2 active runs (the
 *     "running 2x" anchor from 2026-06-02).
 *
 *   - computeCostMeter: render a CostBurnMeter display string. The
 *     DashboardRunResponse shape (api.ts:279-294) does NOT include a
 *     `cost_usd` field — surfacing it is a fast-follow (TODO below). For
 *     now the meter shows live run count + elapsed; when cost arrives in
 *     the API we light up `hasLiveCost: true` and sum it. We do NOT fake
 *     a number.
 *
 * Pure: no React, no DOM, no I/O.
 */

import type { DashboardRunResponse } from './api';
import { formatCostUsd } from './cost-utils';

/**
 * Group runs by the codebase key. Prefers `codebase_id` (the SQL key); falls
 * back to `codebase_name` when `codebase_id` is null (orphaned / unbound run).
 * Runs missing both are skipped (cannot co-fire).
 */
export function groupRunsByCodebase(
  runs: readonly DashboardRunResponse[]
): Map<string, DashboardRunResponse[]> {
  const groups = new Map<string, DashboardRunResponse[]>();
  for (const run of runs) {
    const key = run.codebase_id ?? run.codebase_name ?? null;
    if (key === null) continue;
    const list = groups.get(key);
    if (list) list.push(run);
    else groups.set(key, [run]);
  }
  return groups;
}

/**
 * Subset of DashboardRunResponse used by the cost meter — exposed as a
 * type alias so a hypothetical future `cost_usd` field is the only thing
 * to add when the API ships it.
 */
export interface CostMeterRun {
  started_at: string;
  // TODO: cost field unavailable in DashboardRunResponse — add cost_usd
  // to the dashboard query as a fast-follow WO and surface here.
  cost_usd?: number;
}

export interface CostMeterResult {
  /** Display string for the meter ("2 runs / 21min" or "$0.42 / 5min"). */
  displayValue: string;
  /** True if we actually summed cost from the runs; false = count+elapsed only. */
  hasLiveCost: boolean;
  /** Was the result an estimate (because cost was unavailable)? */
  isEstimate: boolean;
  /** Summed cost across runs (0 when hasLiveCost === false). */
  totalCostUsd: number;
  /** Elapsed milliseconds since the earliest started_at. */
  elapsedMs: number;
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${String(minutes)}min`;
}

/**
 * Compute the cost meter display for a set of live runs.
 *
 * If any run carries a numeric `cost_usd` we sum it and report
 * `hasLiveCost: true`. Otherwise we fall back to "<n> runs / <elapsed>" —
 * still useful at a glance (how many lanes are burning, how long), but
 * surfaces nothing fake.
 */
export function computeCostMeter(
  runs: readonly CostMeterRun[],
  now: number = Date.now()
): CostMeterResult {
  if (runs.length === 0) {
    return {
      displayValue: '0 runs',
      hasLiveCost: false,
      isEstimate: false,
      totalCostUsd: 0,
      elapsedMs: 0,
    };
  }

  // Earliest started_at across all live runs sets "session" elapsed.
  let earliest = Number.POSITIVE_INFINITY;
  for (const run of runs) {
    const ts = new Date(run.started_at).getTime();
    if (Number.isFinite(ts) && ts < earliest) earliest = ts;
  }
  const elapsedMs = Number.isFinite(earliest) ? Math.max(0, now - earliest) : 0;

  let hasLiveCost = false;
  let total = 0;
  for (const run of runs) {
    if (typeof run.cost_usd === 'number' && Number.isFinite(run.cost_usd)) {
      hasLiveCost = true;
      total += run.cost_usd;
    }
  }

  if (hasLiveCost) {
    return {
      displayValue: `${formatCostUsd(total)} / ${formatElapsed(elapsedMs)}`,
      hasLiveCost: true,
      isEstimate: false,
      totalCostUsd: total,
      elapsedMs,
    };
  }

  // Fallback: run count + elapsed; flagged as estimate so the UI can label it.
  return {
    displayValue: `${String(runs.length)} runs / ${formatElapsed(elapsedMs)}`,
    hasLiveCost: false,
    isEstimate: true,
    totalCostUsd: 0,
    elapsedMs,
  };
}
