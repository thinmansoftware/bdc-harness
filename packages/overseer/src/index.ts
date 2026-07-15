/**
 * @archon/overseer -- Cauldron workflow-failure decision layer.
 *
 * Minimal v1 (2026-05-16):
 *   - classifyError: maps a workflow failure to a known error class
 *   - decide: given an error class + attempt, returns a decision
 *
 * v2+ (deferred to Cauldron 2.0 era):
 *   - LLM proxy with provider failover (OpenAI  Anthropic)
 *   - Grader integration for output scoring
 *   - bdc_harness_events Supabase logging
 *   - Mission Control "Workflow Decisions" tab
 *
 * Design authority: 2026-05-09 WO-HARNESS-OVERLORD-* specs (Python prior art at
 * C:/Users/pcmed/projects/overlord/overlord/router.py). This skeleton ports the
 * load-bearing slice to TypeScript so it integrates with the bun-only bdc-harness
 * runtime without a Python sidecar.
 *
 * Anchor: 2026-05-16 Wave 1 sortie hit 6 distinct workflow-failure classes that
 * killed valid implementation work. This package centralizes the recognition + recovery
 * logic so future workflows don't bolt that intelligence into each persona prompt.
 */

export { classifyError } from './classify';
export type { ErrorClass, ClassifyInput } from './classify';

export { decide } from './decide';
export type { Decision, DecideInput, DecisionResult } from './decide';

export { runEscalation } from './escalate';
export { buildDispatchRunReportBody } from './escalate';
export type { EscalationContext } from './escalate';

export { watchLoop, watchOnce, DEFAULT_WATCH_INTERVAL_MS } from './watch';
export { judgePullRequest, isPrGreen, isPrMergeReady } from './judge-pr';
export { judgeWithGrok } from './judge-second-opinion';
export { handleMergeReady, isInternalMergeAllowed } from './actions/merge-ready';
export { runOverseerService } from './service';

// M-31 merge-steward substrate (M-42 Slice 2): read-only permit preparation.
export { prepareM31ActionPermit, createFailClosedM31CapabilityGate } from './m31-substrate';
export type {
  M31LiveStateReader,
  M31CapabilityGate,
  M31GateRequest,
  M31GateDecision,
  M31GateDenial,
  PrepareM31ActionPermitInput,
  PrepareM31ActionPermitResult,
  M31PermitPreparationDeps,
  M31ActionKind,
  M31ActionPermit,
  M31ActionProposal,
  M31ExecutionReceipt,
  M31LiveObservation,
  M31TypedFailure,
} from './m31-substrate';
export type {
  GrokJudgeDeps,
  GrokJudgeEvidence,
  GitHubClientDeps,
  OverseerActionsDeps,
  OverseerRunRecord,
  OverseerRunStoreDeps,
  OverseerWorkflowEvent,
  PullRequestEvidence,
  WatchedRunRecord,
} from './types';
