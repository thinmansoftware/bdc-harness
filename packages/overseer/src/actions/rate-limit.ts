import { makeAction, type ActionEvidence, type OverseerAction } from './types';

export interface RateLimitInput {
  runId: string;
  attempt: number;
  resetAt?: string;
}

export function planRateLimitAction(input: RateLimitInput): OverseerAction {
  const waitMs = Math.min(60000, 1000 * Math.pow(2, Math.max(1, input.attempt)));
  const evidence: ActionEvidence[] = [
    { key: 'attempt', value: String(input.attempt) },
    { key: 'wait_ms', value: String(waitMs) },
  ];
  if (input.resetAt) evidence.push({ key: 'reset_at', value: input.resetAt });
  return makeAction('rate_limit', {
    runId: input.runId,
    reason: `Rate limited; retry after ${waitMs}ms`,
    evidence,
  });
}
