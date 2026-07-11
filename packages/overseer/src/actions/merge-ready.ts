import { makeAction, type ActionEvidence, type OverseerAction } from './types';

export interface MergeReadyInput {
  runId: string;
  prUrl: string;
  mergeable: 'MERGEABLE' | 'UNKNOWN' | 'CONFLICTING';
  checksPassing: boolean;
  manifestValid: boolean;
}

export function planMergeReadyAction(input: MergeReadyInput): OverseerAction {
  const evidence: ActionEvidence[] = [
    { key: 'pr_url', value: input.prUrl },
    { key: 'mergeable', value: input.mergeable },
    { key: 'checks_passing', value: String(input.checksPassing) },
    { key: 'manifest_valid', value: String(input.manifestValid) },
  ];
  const ready = input.mergeable === 'MERGEABLE' && input.checksPassing && input.manifestValid;
  return makeAction(
    'merge_ready',
    {
      runId: input.runId,
      reason: ready
        ? 'PR is mergeable with passing checks and valid manifest'
        : 'PR is not merge ready',
      evidence,
    },
    ready ? 'planned' : 'blocked'
  );
}
