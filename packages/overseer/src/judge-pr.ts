import { planMergeReadyAction, type MergeReadyInput } from './actions/merge-ready';
import type { OverseerAction } from './actions/types';

export interface JudgePrInput extends MergeReadyInput {
  diffHasContent: boolean;
  asciiClean: boolean;
}

export interface JudgePrResult {
  verdict: 'merge_ready' | 'blocked';
  action: OverseerAction;
}

export function judgePr(input: JudgePrInput): JudgePrResult {
  const action = planMergeReadyAction(input);
  const ok =
    action.status !== 'blocked' &&
    input.diffHasContent &&
    input.asciiClean &&
    input.prUrl.length > 0;
  return {
    verdict: ok ? 'merge_ready' : 'blocked',
    action: ok
      ? action
      : {
          ...action,
          status: 'blocked',
          reason: 'PR failed overseer merge-ready checks',
        },
  };
}
