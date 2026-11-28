// Rule 4 parity. Raw evidence includes an optional failing job and can include a
// required job from a different head. Only the current head is sent by GitHub's
// exact-head readers. The manager also checks the SHA on assembled check evidence.
import type { PrReviewCheck } from '../../pr-review-evaluator';

export const REQUIRED_CHECK_NAME = 'Windows CI gate';

interface CheckCase {
  readonly name: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly stale?: boolean;
  readonly outcome: 'pass' | 'fail' | 'pending';
}

export const requiredCheckCases: readonly CheckCase[] = [
  { name: 'success', status: 'completed', conclusion: 'success', outcome: 'pass' },
  { name: 'skipped', status: 'completed', conclusion: 'skipped', outcome: 'pass' },
  { name: 'neutral', status: 'completed', conclusion: 'neutral', outcome: 'pass' },
  { name: 'failure', status: 'completed', conclusion: 'failure', outcome: 'fail' },
  { name: 'running', status: 'in_progress', conclusion: null, outcome: 'pending' },
  { name: 'missing', outcome: 'pending' },
  {
    name: 'stale head',
    status: 'completed',
    conclusion: 'skipped',
    stale: true,
    outcome: 'pending',
  },
];

export function reportedChecksForHead({ status, conclusion, stale }: CheckCase): PrReviewCheck[] {
  const optional = { name: 'optional preview', status: 'completed', conclusion: 'failure' };
  if (!status || stale) return [optional];
  return [{ name: REQUIRED_CHECK_NAME, status, conclusion: conclusion ?? null }, optional];
}
