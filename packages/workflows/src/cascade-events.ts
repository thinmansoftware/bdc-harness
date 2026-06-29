/**
 * Layer 1 cascade events (WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01).
 *
 * Owns the structured `cascade_step` event (tier-climb) and the `GateResult`
 * type used as a FIELD on node_completed / node_failed payloads. These are
 * what the Smart Cauldron cost-cascade + UI surfaces need as data, not as
 * parsed error text.
 *
 * SCOPE:
 *   - Phase 3 (this WO): land the event schema + emit helper. Wired now so
 *     downstream WOs (the cascade engine in Phase 5, the UI in Phase 6) can
 *     rely on the contract.
 *   - Phase 5 (WO-HARNESS-V1-PERRUN-CASCADE-01): the cascade engine calls
 *     emitCascadeStep when escalating a tier, and assigns a GateResult to the
 *     `nodeGateResult` placeholder in dag-executor.executeNodeInternal before
 *     node_completed is emitted.
 *
 * DISTINCTION vs overseer_decision='escalate':
 *   - overseer_decision='escalate' = salvage path (the existing classifier
 *     surfacing a failure for operator triage).
 *   - cascade_step = planned tier promotion (e.g. haiku -> sonnet) because a
 *     specific gate failed, with structured from_tier / to_tier / gate / reason.
 *
 * NO new `node_gate_result` event type: gate-pass is recorded via the
 * `gate_result?: GateResult` field on node_completed / node_failed, NOT as
 * an independent event. The DB column workflow_events.data is freeform JSON,
 * so no migration is required.
 *
 * IMPORT GRAPH:
 *   cascade-events.ts -> store.ts, event-emitter.ts, @archon/paths
 *   cascade-events.ts does NOT import from dag-executor.ts or overseer-bridge.ts
 *   -> zero circular imports.
 *
 * ASCII only. No emojis.
 */
import type { Logger } from '@archon/paths';
import type { IWorkflowStore } from './store.ts';
import type { WorkflowEmitterEvent } from './event-emitter.ts';

/**
 * Structured result of a gate evaluation (tests / validator / manifest / ci).
 *
 * Spread into node_completed and node_failed event payloads via the
 * `gate_result` field. Replaces the prior practice of parsing gate outcome
 * out of error text. Phase 5 assigns this before node_completed / node_failed
 * is written; Phase 3 leaves the field undefined (purely additive, no-op).
 */
export interface GateResult {
  gate: 'tests' | 'validator' | 'manifest' | 'ci';
  outcome: 'pass' | 'fail';
  reason: string;
}

/**
 * Injected dependencies for emitCascadeStep. Mirrors the dependency-injection
 * pattern used by overseer-bridge.ts (store + emitter + log) so the helper is
 * trivially testable with inline mocks.
 */
export interface CascadeStepDeps {
  store: IWorkflowStore;
  emitter: { emit: (event: WorkflowEmitterEvent) => void };
  log: Logger;
}

/**
 * Emit a cascade_step event when a job escalates from one tier to another.
 *
 * Phase 5 (WO-HARNESS-V1-PERRUN-CASCADE-01) calls this. Wired now so the UI
 * and cost-cascade WOs can rely on the schema being present.
 *
 * Behavioral contract:
 *   - Persists a `cascade_step` event row to the store (freeform data column,
 *     no migration needed).
 *   - Emits a `cascade_step` event on the WorkflowEventEmitter so subscribers
 *     (SSE adapters, Mission Control) see it in real time.
 *   - Persistence is fire-and-forget; a store failure is logged but never
 *     thrown to the caller -- workflow execution must not depend on event
 *     persistence (same contract as createWorkflowEvent docstring in store.ts).
 *
 * DISTINCT from overseer_decision='escalate' (salvage path):
 *   - cascade_step is a planned tier promotion (gate failed -> climb to next
 *     tier). It records what tier we were on, what tier we are climbing to,
 *     which gate triggered the climb, and the failure reason.
 */
export async function emitCascadeStep(
  deps: CascadeStepDeps,
  workflowRunId: string,
  nodeId: string,
  params: { from_tier: string; to_tier: string; gate: string; reason: string }
): Promise<void> {
  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRunId,
      event_type: 'cascade_step',
      step_name: nodeId,
      data: {
        from_tier: params.from_tier,
        to_tier: params.to_tier,
        gate: params.gate,
        reason: params.reason,
      },
    })
    .catch((err: Error) => {
      deps.log.error(
        { err, workflowRunId, eventType: 'cascade_step' },
        'workflow_event_persist_failed'
      );
    });

  deps.emitter.emit({
    type: 'cascade_step',
    runId: workflowRunId,
    nodeId,
    from_tier: params.from_tier,
    to_tier: params.to_tier,
    gate: params.gate,
    reason: params.reason,
  });
}
