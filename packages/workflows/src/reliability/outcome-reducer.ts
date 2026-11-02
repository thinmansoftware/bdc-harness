import type {
  DeliverableState,
  ExecutionState,
  OutcomeReasonCode,
  RunOutcome,
  RunOutcomeEvidence,
  RunOutcomeProjection,
  ValidationState,
} from './types';

function deriveDeliverableState(evidence: RunOutcomeEvidence): DeliverableState {
  const { deliverable } = evidence;
  if (deliverable.pullRequest?.ready) return 'pr_ready';
  if (deliverable.pullRequest?.open) return 'pr_open';
  if (deliverable.pushed) return 'pushed';
  if (deliverable.commitSha) return 'committed';
  if (deliverable.worktreeChanges) return 'worktree_changes';
  return 'none';
}

function requiredStageBlockReason(evidence: RunOutcomeEvidence): OutcomeReasonCode | null {
  const required = (evidence.requiredStages ?? []).filter(stage => stage.required);
  if (
    required.some(
      stage =>
        stage.executionState === 'failed' ||
        stage.executionState === 'cancelled' ||
        stage.validationState === 'failed'
    )
  ) {
    return 'required_stage_failed';
  }
  if (required.some(stage => stage.validationState === 'indeterminate')) {
    return 'required_stage_indeterminate';
  }
  return null;
}

function requiredStageValidationState(evidence: RunOutcomeEvidence): ValidationState {
  const required = (evidence.requiredStages ?? []).filter(stage => stage.required);
  if (required.some(stage => stage.validationState === 'failed')) return 'failed';
  if (required.some(stage => stage.validationState === 'indeterminate')) return 'indeterminate';
  return evidence.validation.state;
}

function derivePrimaryReason(
  evidence: RunOutcomeEvidence,
  executionState: ExecutionState,
  deliverableState: DeliverableState,
  requiredStageReason: OutcomeReasonCode | null
): OutcomeReasonCode {
  if (evidence.dryRun) return 'dry_run_planned';
  if (requiredStageReason) return requiredStageReason;
  if (evidence.validation.reasonCode) return evidence.validation.reasonCode;
  if (evidence.reasonCodes?.[0]) return evidence.reasonCodes[0];
  if (evidence.validation.required) {
    if (evidence.validation.state === 'failed') return 'gate_failed';
    if (evidence.validation.state === 'indeterminate') return 'gate_indeterminate';
    if (evidence.validation.state === 'not_run' && executionState === 'completed') {
      return 'gate_not_run';
    }
  }
  if (evidence.routeState === 'escalated') return 'gate_rejection_with_successor';
  if (evidence.routeState === 'failed_over') return 'provider_failed_over';
  if (evidence.routeState === 'spec_repair') return 'spec_repair_required';

  switch (executionState) {
    case 'queued':
      return 'run_queued';
    case 'running':
      return 'run_running';
    case 'waiting_provider':
      return 'provider_quota_wait';
    case 'paused_human':
      return 'paused_for_human';
    case 'interrupted':
      return 'worker_lease_expired';
    case 'cancelled':
      return 'cancelled_by_operator';
    case 'failed':
      return deliverableState === 'pr_ready' ? 'execution_failed_pr_ready' : 'execution_failed';
    case 'completed':
      if (evidence.verifiedNoop) return 'verified_noop';
      if (deliverableState === 'pr_ready') return 'pr_ready';
      if (evidence.requirements.deliverable === 'pr_ready') return 'pr_not_ready';
      return 'execution_completed';
  }
}

function uniqueReasonCodes(
  primaryReason: OutcomeReasonCode,
  evidence: RunOutcomeEvidence
): readonly OutcomeReasonCode[] {
  return [
    ...new Set([
      primaryReason,
      ...(evidence.reasonCodes ?? []),
      ...(evidence.validation.reasonCode ? [evidence.validation.reasonCode] : []),
    ]),
  ];
}

export function reduceRunOutcome(evidence: RunOutcomeEvidence): RunOutcome {
  const requiredStageReason = requiredStageBlockReason(evidence);
  const executionState: ExecutionState = requiredStageReason ? 'failed' : evidence.executionState;
  const validationState = requiredStageReason
    ? requiredStageValidationState(evidence)
    : evidence.validation.state;
  const deliverableState = deriveDeliverableState(evidence);
  const primaryReason = derivePrimaryReason(
    evidence,
    executionState,
    deliverableState,
    requiredStageReason
  );

  return {
    executionState,
    deliverableState,
    validationState,
    recoveryState: evidence.recoveryState,
    routeState: evidence.routeState,
    primaryReason,
    reasonCodes: uniqueReasonCodes(primaryReason, evidence),
    evidenceRefs: [...evidence.evidenceRefs],
  };
}

export function projectRunOutcome(
  outcome: RunOutcome,
  evidence: RunOutcomeEvidence
): RunOutcomeProjection {
  if (evidence.dryRun) return 'planned';
  if (outcome.routeState === 'escalated') return 'escalated';

  switch (outcome.executionState) {
    case 'queued':
      return 'pending';
    case 'running':
      return 'running';
    case 'waiting_provider':
      return 'waiting_provider';
    case 'paused_human':
      return 'paused';
    case 'interrupted':
      return 'interrupted';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'completed':
      if (evidence.validation.required && outcome.validationState !== 'passed') return 'failed';
      if (
        evidence.requirements.deliverable === 'pr_ready' &&
        outcome.deliverableState !== 'pr_ready'
      ) {
        return 'failed';
      }
      if (outcome.routeState === 'spec_repair' || outcome.routeState === 'exhausted') {
        return 'failed';
      }
      return 'completed';
  }
}
