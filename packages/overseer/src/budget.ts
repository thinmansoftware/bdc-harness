export interface OverseerBudget {
  maxActionsPerRun: number;
  maxRefiresPerRun: number;
  maxRateLimitRetries: number;
}

export const DEFAULT_OVERSEER_BUDGET: OverseerBudget = {
  maxActionsPerRun: 8,
  maxRefiresPerRun: 1,
  maxRateLimitRetries: 3,
};

export function assertWithinBudget(
  budget: OverseerBudget,
  currentActionCount: number,
  currentRefireCount: number
): { ok: true } | { ok: false; reason: string } {
  if (currentActionCount >= budget.maxActionsPerRun) {
    return { ok: false, reason: 'overseer action budget exhausted for run' };
  }
  if (currentRefireCount >= budget.maxRefiresPerRun) {
    return { ok: false, reason: 'overseer refire budget exhausted for run' };
  }
  return { ok: true };
}
