import { makeAction, type ActionEvidence, type OverseerAction } from './types';

export interface SalvageInput {
  runId: string;
  hasCommittedDiff: boolean;
  hasUnstagedDiff: boolean;
  failureClass: string;
}

export function planSalvageAction(input: SalvageInput): OverseerAction {
  const hasWork = input.hasCommittedDiff || input.hasUnstagedDiff;
  const evidence: ActionEvidence[] = [
    { key: 'has_committed_diff', value: String(input.hasCommittedDiff) },
    { key: 'has_unstaged_diff', value: String(input.hasUnstagedDiff) },
    { key: 'failure_class', value: input.failureClass },
  ];
  return makeAction(
    'salvage',
    {
      runId: input.runId,
      reason: hasWork
        ? 'Recover existing work before retrying the failed lane'
        : 'No work exists to salvage',
      evidence,
    },
    hasWork ? 'planned' : 'blocked'
  );
}
