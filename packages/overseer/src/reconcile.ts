import { planRateLimitAction } from './actions/rate-limit';
import { planSalvageAction } from './actions/salvage';
import type { OverseerAction } from './actions/types';
import { assertWithinBudget, DEFAULT_OVERSEER_BUDGET, type OverseerBudget } from './budget';

export interface ReconcileInput {
  runId: string;
  failureClass: string;
  attempt: number;
  hasCommittedDiff: boolean;
  hasUnstagedDiff: boolean;
  actionCount?: number;
  refireCount?: number;
  budget?: OverseerBudget;
}

export function reconcileRun(input: ReconcileInput): OverseerAction {
  const budget = input.budget ?? DEFAULT_OVERSEER_BUDGET;
  const budgetResult = assertWithinBudget(budget, input.actionCount ?? 0, input.refireCount ?? 0);
  if (!budgetResult.ok) {
    return planSalvageAction({
      runId: input.runId,
      failureClass: input.failureClass,
      hasCommittedDiff: false,
      hasUnstagedDiff: false,
    });
  }
  if (input.failureClass === 'rate_limit_exceeded') {
    return planRateLimitAction({ runId: input.runId, attempt: input.attempt });
  }
  return planSalvageAction(input);
}
