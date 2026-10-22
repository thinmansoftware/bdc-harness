import type { WorkflowEventRecord } from './store';

const LOOP_ITERATION_EVENT_TYPES = new Set(['loop_iteration_completed', 'loop_iteration_failed']);
const TERMINAL_EVENT_TYPES = new Set(['node_completed', 'node_failed']);

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function portionUsd(data: Record<string, unknown> | undefined): number {
  return (finiteNumber(data?.cost_usd) ?? 0) + (finiteNumber(data?.cost_usd_estimate) ?? 0);
}

function hasFiniteCost(data: Record<string, unknown> | undefined): boolean {
  return (
    finiteNumber(data?.cost_usd) !== undefined ||
    finiteNumber(data?.cost_usd_estimate) !== undefined
  );
}

/**
 * Sum a run's durable spend once per step.
 *
 * A step that recorded any loop iteration cost is counted from those iteration
 * events only (cost_usd plus cost_usd_estimate). Its terminal node events are
 * ignored so a cumulative node_failed does not count the same spend again.
 * Every other step is counted from node_completed and node_failed.
 * Absent or non-finite amounts contribute nothing. This function does not throw.
 */
export function sumRunSpendUsd(events: readonly WorkflowEventRecord[]): number {
  const byStep = new Map<string, WorkflowEventRecord[]>();
  for (const event of events) {
    const step = event.step_name ?? '';
    const group = byStep.get(step);
    if (group) group.push(event);
    else byStep.set(step, [event]);
  }

  let total = 0;
  for (const records of byStep.values()) {
    const pricedIterations = records.filter(
      event => LOOP_ITERATION_EVENT_TYPES.has(event.event_type) && hasFiniteCost(event.data)
    );
    if (pricedIterations.length > 0) {
      for (const event of pricedIterations) total += portionUsd(event.data);
      continue;
    }
    for (const event of records) {
      if (!TERMINAL_EVENT_TYPES.has(event.event_type)) continue;
      total += portionUsd(event.data);
    }
  }
  return total;
}
