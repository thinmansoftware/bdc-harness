/**
 * Overseer bridge for dag-executor node-failure handlers.
 *
 * Wires the @archon/overseer decision layer into the executor without growing
 * dag-executor.ts further. Each of the executor's node-failure sites calls
 * `handleNodeFailure` instead of inlining the log + persist + emit + return pattern.
 *
 * v1 scope (WO-HARNESS-OVERSEER-WIRE-V1-01 / bdc-xo#151):
 *   - AI-node failure sites only (4 sites in dag-executor.ts: command-load,
 *     cancelled-during-streaming, credit-exhaustion, empty-output)
 *   - Bash-node failures are out of scope; sibling WO to follow
 *   - All 4 v1 sites currently classify as `unknown` -> `escalate` -> returns
 *     `{ state: 'failed' }`. Net behavioral change at these 4 sites is zero;
 *     the v1 win is the structured `overseer.decision` log line and the wired
 *     decision path for future extension.
 *
 * v2 deferred (per @archon/overseer README):
 *   - createWorkflowEvent persistence for Mission Control "Workflow Decisions" tab
 *   - Per-WO-class override rules
 *   - LLM provider failover
 *
 * Node-failure Dispatch notification (WO-HARNESS-OVERSEER-NODE-FAILURE-REPAIR-AND-ESCALATION-01):
 *   handleNodeFailure now calls notifyNodeFailureEscalation on EVERY `escalate`
 *   decision -- any node (bash or AI), any error class including `unknown`, with
 *   or without an escalationContext. It writes one Dispatch message to recipient
 *   'duty-officer' (so the Duty Officer digest carries the run id + failing node)
 *   and, when the failure is a blocker (out_of_credits / auth_failed, or
 *   commit_hook_lint_failure on attempt >= 2), ALSO one message to recipient 'xo'
 *   at priority 'blocker'. This replaces the prior silent-exit behaviour where a
 *   context-less escalate produced no operator-visible signal (anchor run
 *   3993fe05, 2026-10-14). The write never throws and never re-enters this
 *   handler; it does NOT replace the runEscalation operator-card path, it runs
 *   alongside it.
 */

import type { Logger } from '@archon/paths';
import {
  bdcXoSubjectKeyForRun,
  classifyError,
  decide,
  isAlwaysBlockerClass,
  notifyNodeFailureEscalation,
  permitFromMetadata,
  runAuthorizedEscalation,
  runEscalation,
  type Decision,
} from '@archon/overseer';
import type { WorkflowRun, NodeOutput } from './schemas/workflow-run.ts';
import type { DagNode } from './schemas/dag-node.ts';
import { buildGateResultField } from './event-emitter';
import type { WorkflowEmitterEvent, GateResult } from './event-emitter';
import type { IWorkflowStore } from './store.ts';
import type { WorkflowEventRecord } from './store.ts';

export interface HandleNodeFailureDeps {
  store: IWorkflowStore;
  emitter: { emit: (event: WorkflowEmitterEvent) => void };
  log: Logger;
  logNodeError: (
    logDir: string,
    workflowRunId: string,
    nodeId: string,
    errorMsg: string
  ) => Promise<void>;
}

export interface HandleNodeFailureContext {
  /** Error message text -- used for classification + persisted in node_failed event */
  errorMsg: string;
  /** Standard log dir for logNodeError */
  logDir: string;
  /** Node-level retry counter (1-based). Defaults to 1 if caller doesn't track. */
  attempt?: number;
  /** Has the node produced any output so far? Used by sentinel_mismatch heuristic. */
  hasOutput?: boolean;
  /** Node output captured before failure (returned in NodeOutput.output) */
  outputSoFar?: string;
  /** Node type string for classify disambiguation. AI-node sites can omit (only `loop` matters for v1). */
  nodeType?: string;
  /** Optional bash exit code (not present at AI-node sites; reserved for future bash-site wiring) */
  exitCode?: number;
  /** Optional HTTP status code (not present at AI-node sites; reserved) */
  statusCode?: number;
  /** Optional extra data fields to attach to the persisted node_failed event */
  extraEventData?: Record<string, unknown>;
  /**
   * Structured gate outcome to attach to the node_failed store + emitter events.
   * Set by Phase 5 cascade engine when a gate check fires before failure.
   * (WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01)
   */
  gateResult?: GateResult;
  /**
   * Optional war-council-validator stdout captured from a sibling node output map.
   * Forwarded to classify/decide so the silent-dead-end classes can detect
   * actionable validator feedback vs. a REJECT/BLOCK/FAIL verdict.
   */
  validatorOutput?: string;
  /**
   * Optional WO ID parsed from the workflow user_message. Surfaced into the
   * escalation payload so the authorized boundary can notify the right WO page.
   */
  woId?: string;
  /** Optional: commits-ahead-of-origin count on the thread branch (escalation context only). */
  threadCommitsAhead?: number;
  /** Optional: whether the unique remote branch exists at origin (classifier discriminator). */
  hasOriginBranch?: boolean;
}

export interface HandleNodeFailureResult {
  output: NodeOutput;
  decision: Decision;
  errorClass: string;
}

/**
 * Shared node-failure handler. Replaces the 5-step log + logNodeError + createWorkflowEvent +
 * emitter.emit + return-failed pattern at each AI-node failure site in dag-executor.ts.
 *
 * Returns a NodeOutput the caller returns directly. The caller remains responsible for
 * site-specific housekeeping (throttle-map cleanup, etc).
 */
/**
 * Attempt number the lane reports for a commit-hook failure, as the literal
 * `commit_hook_attempt=<n>` token.
 */
const COMMIT_HOOK_ATTEMPT_PATTERN = /commit_hook_attempt=(\d{1,3})\b/i;

/**
 * Effective attempt for a commit-hook lint failure.
 *
 * Bash node-failure sites do not carry a retry counter, so `ctx.attempt` is 1 at
 * every one of them. For `commit_hook_lint_failure` that default is WRONG on the
 * second failure: decide() keys the blocker on `attempt >= 2`, so a dead-ended
 * hook failure reported with attempt 1 would be answered with "feed the hook
 * output back for one bounded repair pass" even though that pass already ran.
 *
 * The lane therefore stamps the real attempt count -- taken from the commit-core's
 * own attempt file, i.e. the number of times `git commit` actually ran -- into the
 * failure text as `commit_hook_attempt=<n>`. Honour it only for this class, and
 * only when it is HIGHER than the caller's value, so the token can escalate the
 * attempt but never silently downgrade a real retry counter.
 */
function effectiveCommitHookAttempt(errorClass: string, errorMsg: string, attempt: number): number {
  if (errorClass !== 'commit_hook_lint_failure') return attempt;
  const match = COMMIT_HOOK_ATTEMPT_PATTERN.exec(errorMsg);
  const raw = match?.[1];
  if (raw === undefined) return attempt;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > attempt ? parsed : attempt;
}

export async function handleNodeFailure(
  deps: HandleNodeFailureDeps,
  workflowRun: WorkflowRun,
  node: DagNode,
  ctx: HandleNodeFailureContext
): Promise<HandleNodeFailureResult> {
  const hasOutput = ctx.hasOutput ?? false;

  const errorClass = classifyError({
    message: ctx.errorMsg,
    nodeId: node.id,
    nodeType: ctx.nodeType,
    exitCode: ctx.exitCode,
    statusCode: ctx.statusCode,
    validatorOutput: ctx.validatorOutput,
    threadCommitsAhead: ctx.threadCommitsAhead,
    hasOriginBranch: ctx.hasOriginBranch,
  });

  const attempt = effectiveCommitHookAttempt(errorClass, ctx.errorMsg, ctx.attempt ?? 1);

  const result = decide({
    errorClass,
    attempt,
    hasOutput,
    nodeId: node.id,
    validatorOutput: ctx.validatorOutput,
    woId: ctx.woId,
  });

  // Observability -- Mission Control "Workflow Decisions" tab will consume this when
  // persistence lands in v2. For v1 we only emit a structured log line.
  deps.log.info(
    {
      module: 'overseer',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeType: ctx.nodeType,
      errorClass,
      decision: result.decision,
      reason: result.reason,
      attempt,
      hasOutput,
    },
    'overseer.decision'
  );

  // Preserve the existing 4 housekeeping calls.
  await deps.logNodeError(ctx.logDir, workflowRun.id, node.id, ctx.errorMsg);

  const eventInput = {
    workflow_run_id: workflowRun.id,
    event_type: 'node_failed' as const,
    step_name: node.id,
    data: {
      error: ctx.errorMsg,
      overseer_class: errorClass,
      overseer_decision: result.decision,
      ...(ctx.extraEventData ?? {}),
      // Layer 1 gate_result field (WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01).
      // Present only when Phase 5 cascade engine provides gateResult in ctx.
      ...buildGateResultField(ctx.gateResult),
    },
  };
  let persistedActionableEvent: WorkflowEventRecord | null = null;
  if (result.decision === 'escalate' && result.escalationContext) {
    try {
      if (!deps.store.createDurableWorkflowEvent) {
        throw new Error('durable_workflow_event_store_unavailable');
      }
      persistedActionableEvent = await deps.store.createDurableWorkflowEvent(eventInput);
    } catch (err) {
      deps.log.error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_failed' },
        'overseer.escalation_event_persist_failed'
      );
    }
  } else {
    deps.store.createWorkflowEvent(eventInput).catch((err: Error) => {
      deps.log.error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_failed' },
        'workflow_event_persist_failed'
      );
    });
  }

  // Forward gate_result from ctx.gateResult into the emitted event via buildGateResultField.
  // The persisted event receives it via the buildGateResultField spread in the store call above.
  // buildGateResultField returns GateResult | undefined and is the canonical gate_result accessor.
  deps.emitter.emit({
    type: 'node_failed',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.command ?? node.id,
    error: ctx.errorMsg,
    ...buildGateResultField(ctx.gateResult),
  });

  // Silent-dead-end escalation: fire 3 operator-visible signals (escalation.json
  // on disk, builder-monitor webhook, Notion comment) for the new failure classes
  // identified in the 2026-05-18 Wave A anchor incidents. The presence of
  // `result.escalationContext` is the contract -- only the new classes populate it,
  // so existing v1 escalate paths (out_of_credits, auth_failed, etc.) are unaffected.
  //
  if (result.decision === 'escalate' && result.escalationContext) {
    if (!persistedActionableEvent) {
      deps.log.info(
        { runId: workflowRun.id, nodeId: node.id, errorClass },
        'overseer.escalation_denied_missing_durable_event'
      );
      const output = translateDecision(result.decision, ctx.errorMsg, ctx.outputSoFar ?? '');
      return { output, decision: result.decision, errorClass };
    }
    const escalation = await runAuthorizedEscalation(workflowRun.id, {
      permit: permitFromMetadata(workflowRun.metadata),
      actor: 'overseer-workflow-bridge',
    }).catch((err: Error) => {
      deps.log.error(
        { err, workflowRunId: workflowRun.id, nodeId: node.id, errorClass },
        'overseer.escalation_failed'
      );
      return {
        accepted: false as const,
        reason: 'authorization_boundary_failed',
        mutation_sent: false as const,
      };
    });
    if (!escalation.accepted) {
      deps.log.info(
        {
          runId: workflowRun.id,
          nodeId: node.id,
          errorClass,
          reason: escalation.reason,
        },
        'overseer.escalation_denied'
      );
    } else {
      await runEscalation(
        workflowRun.id,
        result,
        {
          ...result.escalationContext,
          errorClass,
          woId: ctx.woId ?? 'unknown',
          repository:
            typeof workflowRun.metadata.targetRepo === 'string'
              ? workflowRun.metadata.targetRepo
              : 'thinmansoftware/bdc-harness',
        },
        {
          sourceEventId: persistedActionableEvent.id,
          eventType: persistedActionableEvent.event_type,
          stepName: persistedActionableEvent.step_name ?? node.id,
          eventCreatedAt: persistedActionableEvent.created_at,
        }
      );
    }
  }

  // Node-failure Dispatch notification (WO-HARNESS-OVERSEER-NODE-FAILURE-REPAIR-AND-ESCALATION-01).
  //
  // Gated on `result.decision === 'escalate'` ALONE -- NOT nested inside the
  // escalationContext branch above -- so EVERY escalate writes a duty-officer
  // message, including the `unknown` class and the older classes that carry no
  // escalationContext (which previously returned failed with no operator-visible
  // signal). A blocker ALSO messages recipient 'xo' at priority blocker. The
  // call never throws and never re-enters this handler (no-loop guarantee lives
  // in notifyNodeFailureEscalation).
  if (result.decision === 'escalate') {
    // A load-bearing node (commit-and-push, commit-hook-gate, ascii-gate, open-pr,
    // etc.) whose failure has NO remaining recovery path is a blocker in its own
    // right: its output is critical to the run, the decision is escalate (never a
    // retry), and nothing downstream will repair it. XO must be told at priority
    // blocker, not just the Duty Officer digest. `repairableOnce` is the one
    // recovery path a load-bearing escalate can still carry (the first
    // commit_hook_lint_failure), so it is excluded. This is what surfaces the
    // UNREPAIRED commit-hook-gate failure (the second hook failure, which arrives
    // as a load_bearing gate failure classified `unknown`) to XO -- previously it
    // escalated with no blocker signal at all.
    const loadBearingDeadEnd = node.load_bearing === true && result.repairableOnce !== true;
    const blocker =
      isAlwaysBlockerClass(errorClass) || result.blocker === true || loadBearingDeadEnd;
    await notifyNodeFailureEscalation(
      { log: deps.log },
      {
        runId: workflowRun.id,
        workflowName: workflowRun.workflow_name,
        nodeId: node.id,
        errorClass,
        decision: result.decision,
        attempt,
        errorMsg: ctx.errorMsg,
        blocker,
        subjectKey: bdcXoSubjectKeyForRun({
          metadata: workflowRun.metadata,
          user_message: workflowRun.user_message,
        }),
      }
    );
  }

  // Translate decision to NodeOutput state.
  // Exhaustiveness: if Decision ever gains a value we don't handle, the `never` assignment
  // becomes a compile error.
  const output = translateDecision(result.decision, ctx.errorMsg, ctx.outputSoFar ?? '');

  return { output, decision: result.decision, errorClass };
}

function translateDecision(decision: Decision, errorMsg: string, outputSoFar: string): NodeOutput {
  switch (decision) {
    case 'escalate':
      return { state: 'failed', output: outputSoFar, error: errorMsg };

    case 'skip':
      // Use existing NodeState.skipped -- graceful skip propagates correctly through
      // checkTriggerRule's `all_success` default (downstream nodes also skip).
      return { state: 'skipped', output: outputSoFar };

    case 'retry':
      // v1: retry at AI-node sites requires SDK-level restart that doesn't exist yet.
      // A naive sleep+recursion inside the streaming path would deadlock. Log a warn
      // and fall through to escalate behavior. Bash-node sites (sibling WO) will be
      // the first to honor `retry` for real.
      return { state: 'failed', output: outputSoFar, error: errorMsg };

    case 'commit_and_push_anyway':
      // Only emitted by sentinel_mismatch+hasOutput, which requires nodeType==='loop'
      // and the SDK 'returned success' message. None of the 4 v1 AI-node sites can
      // produce this combination. Reserved for bash/loop-node integration in sibling WO.
      // For v1: treat as escalate (no PR-with-note path wired at AI-node sites).
      return { state: 'failed', output: outputSoFar, error: errorMsg };

    case 'merge_ready':
      // Standing overseer service handles this decision directly after PR evidence
      // judging. The per-node bridge should never auto-merge from an AI-node hook.
      return { state: 'failed', output: outputSoFar, error: errorMsg };

    default: {
      // Compile-time exhaustiveness guard. If Decision gains a 5th variant this fails to build.
      decision satisfies never;
      return { state: 'failed', output: outputSoFar, error: errorMsg };
    }
  }
}
