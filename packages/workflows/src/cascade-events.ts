/**
 * Layer 1 cascade-step emitter (WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01).
 *
 * Phase 3 (this WO) lands the EVENT SCHEMA and a callable entry point. Phase 5
 * (WO-HARNESS-V1-PERRUN-CASCADE-01) is the cascade engine that ACTUALLY invokes
 * `emitCascadeStep` -- until then this file's exports remain unused (no-op until
 * the cascade fires).
 *
 * Kept as a separate module from `dag-executor.ts` so tests can import it
 * without triggering dag-executor's heavy module-load chain (same rationale
 * as `overseer-bridge.ts`).
 *
 * NOTE: `cascade_step` is DISTINCT from `overseer_decision = escalate`.
 *   - `overseer_decision = escalate` (overseer-bridge): salvage path inside one rung.
 *   - `cascade_step` (this file): a real tier CLIMB from one rung to a higher rung
 *     because a gate at the lower rung failed.
 */

import { createLogger } from '@archon/paths';
import type { IWorkflowStore } from './store.ts';
import type { WorkflowRun } from './schemas/workflow-run.ts';
// Value import deliberately drops the `.ts` extension (TS5097 forbids `.ts`
// extensions on value imports). Type-only imports above retain `.ts` because
// type-only imports are erased and not subject to the extension restriction.
import { getWorkflowEventEmitter } from './event-emitter';
import type { GateName } from './event-emitter.ts';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.cascade-events');
  return cachedLog;
}

/**
 * Parameters for a single tier-climb event.
 *
 * All four fields are REQUIRED -- the cascade-trace UI and the Phase 5
 * cost-cascade decision logic both need every one to be queryable structured
 * data, not parsed text.
 */
export interface CascadeStepParams {
  /** Rung the job started from (e.g. "haiku"). */
  from_tier: string;
  /** Rung the job climbed to (e.g. "sonnet"). */
  to_tier: string;
  /** Which gate at `from_tier` failed and triggered the climb. */
  gate: GateName;
  /** Short reason the gate failed -- displayed in the cascade-trace UI. */
  reason: string;
}

/**
 * Record a tier-climb. Persists a `cascade_step` workflow event (freeform JSON
 * payload -- no DB migration required since `events.data` is freeform) AND
 * emits the matching `cascade_step` event on the workflow event emitter for
 * any subscribed observers (SSE adapter, Mission Control, tests).
 *
 * Fire-and-forget semantics for the persistence call: errors are logged but
 * do not propagate, mirroring every other workflow-event persist site in the
 * codebase. The cascade engine that calls this is itself failure-tolerant;
 * losing a single observability event must never abort a tier-climb.
 *
 * @param store - workflow store for event persistence
 * @param workflowRun - the workflow run that is climbing rungs
 * @param nodeId - the node id within `workflowRun` whose gate failed
 * @param params - all four required cascade-step fields
 */
export async function emitCascadeStep(
  store: IWorkflowStore,
  workflowRun: WorkflowRun,
  nodeId: string,
  params: CascadeStepParams
): Promise<void> {
  // Persist to the workflow_events table (freeform JSON in `data`).
  store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
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
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'cascade_step' },
        'workflow_event_persist_failed'
      );
    });

  // Emit on the in-process event emitter for live subscribers.
  getWorkflowEventEmitter().emit({
    type: 'cascade_step',
    runId: workflowRun.id,
    nodeId,
    from_tier: params.from_tier,
    to_tier: params.to_tier,
    gate: params.gate,
    reason: params.reason,
  });
}
