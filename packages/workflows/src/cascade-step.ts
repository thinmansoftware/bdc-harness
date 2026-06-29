/**
 * emitCascadeStep - wired emit-site for tier-climb events.
 *
 * Phase 3 Layer 1 data contract (WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01).
 * The emit-site is wired here; the cascade engine that calls it lands in Phase 5
 * (WO-HARNESS-V1-PERRUN-CASCADE-01). Until Phase 5, no live caller sets these fields.
 *
 * Distinct from overseer_decision=escalate (salvage): a tier CLIMB is a proactive
 * cost-cascade decision (from_tier -> to_tier), not a post-failure salvage escalation.
 */

import type { IWorkflowStore, WorkflowEventType } from './store';
import type { WorkflowEmitterEvent } from './event-emitter';
import type { WorkflowRun } from './schemas/workflow-run';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.cascade-step');
  return cachedLog;
}

export interface CascadeStepDeps {
  store: IWorkflowStore;
  emitter: { emit: (e: WorkflowEmitterEvent) => void };
}

export interface CascadeStepFields {
  from_tier: string;
  to_tier: string;
  failed_gate: string;
  reason: string;
}

/**
 * Emit a cascade_step event -- both persisted (store) and in-process (emitter).
 *
 * Both calls are fire-and-forget: workflow execution continues regardless of
 * whether persistence succeeds. Emitter errors are swallowed by the emitter itself.
 */
export async function emitCascadeStep(
  deps: CascadeStepDeps,
  workflowRun: WorkflowRun,
  nodeId: string,
  fields: CascadeStepFields
): Promise<void> {
  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'cascade_step' as WorkflowEventType,
      step_name: nodeId,
      data: {
        from_tier: fields.from_tier,
        to_tier: fields.to_tier,
        failed_gate: fields.failed_gate,
        reason: fields.reason,
      },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, nodeId, eventType: 'cascade_step' },
        'workflow_event_persist_failed'
      );
    });

  deps.emitter.emit({
    type: 'cascade_step',
    runId: workflowRun.id,
    nodeId,
    fromTier: fields.from_tier,
    toTier: fields.to_tier,
    failedGate: fields.failed_gate,
    reason: fields.reason,
  });
}
