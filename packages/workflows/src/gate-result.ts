/**
 * GateResult - structured gate outcome type + helper.
 *
 * Phase 3 Layer 1 data contract (WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01).
 * Pure type + utility. Zero deps on other @archon/* packages.
 * Safe to import from any module without circular-dependency or mock concerns.
 */

export type GateName = 'tests' | 'validator' | 'manifest' | 'ci';

export interface GateResult {
  gate: GateName;
  result: 'pass' | 'fail';
  reason?: string;
}

/**
 * Spreads gate_result into a data object when gateResult is defined.
 * Identity when gateResult is undefined (backward-compatible no-op).
 * Called at every node_completed createWorkflowEvent emit-site.
 */
export function applyGateResult(
  data: Record<string, unknown>,
  gateResult: GateResult | undefined
): Record<string, unknown> {
  if (gateResult === undefined) return data;
  return { ...data, gate_result: gateResult };
}
