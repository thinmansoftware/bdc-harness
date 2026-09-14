import { runConvergingPrCanary, type ConvergingPrCanaryDeps } from './converging-pr-canary';
import { runRepeatSendCanary, type RepeatSendCanaryDeps } from './repeat-send-canary';
import {
  runEscalationReachesHumanCanary,
  type EscalationReachesHumanCanaryDeps,
} from './escalation-reaches-human-canary';
import { runPushToReviewCanary, type PushToReviewCanaryDeps } from './push-to-review-canary';
import {
  runOrphanedRecipientCanary,
  type OrphanedRecipientCanaryDeps,
} from './orphaned-recipient-canary';
import { runGateNotDeadCanary, type GateNotDeadCanaryDeps } from './gate-not-dead-canary';
import {
  combineOutcomeChecks,
  writeOutcomeCanaryArtifacts,
  type OutcomeCanaryResult,
} from './outcome-canary';

export type PrReviewCanaryDeps = ConvergingPrCanaryDeps &
  RepeatSendCanaryDeps &
  EscalationReachesHumanCanaryDeps &
  PushToReviewCanaryDeps &
  OrphanedRecipientCanaryDeps &
  GateNotDeadCanaryDeps;

export async function runPrReviewCanarySuite(
  deps: PrReviewCanaryDeps
): Promise<OutcomeCanaryResult> {
  const checkIds = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'] as const;
  const checks = await Promise.all([
    runConvergingPrCanary(deps),
    runRepeatSendCanary(deps),
    runEscalationReachesHumanCanary(deps),
    runPushToReviewCanary(deps),
    runOrphanedRecipientCanary(deps),
    runGateNotDeadCanary(deps),
  ]);
  return combineOutcomeChecks(checks.map((check, index) => ({ ...check, id: checkIds[index] })));
}

export async function writePrReviewCanaryArtifacts(
  outputRoot: string,
  report: OutcomeCanaryResult
): Promise<string[]> {
  return writeOutcomeCanaryArtifacts(outputRoot, 'pr-review', report);
}
