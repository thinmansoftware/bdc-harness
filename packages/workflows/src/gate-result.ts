/**
 * Structured gate evaluation outcome carried in node_failed events.
 * Populated by recordGateResult in dag-executor.ts and spread into
 * extraEventData at each handleNodeFailure call site so the persisted
 * node_failed event and the emitted node_failed event both carry the field.
 *
 * Shared here (not in dag-executor.ts) to avoid a circular import:
 * dag-executor.ts imports from event-emitter.ts; event-emitter.ts
 * imports GateResult from this file; no cycle.
 */
export interface GateResult {
  passed: boolean;
  nodeType: 'bash' | 'script' | 'ai';
  exitCode?: number;
  isTimeout?: boolean;
}
