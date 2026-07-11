import { makeAction, type ActionEvidence, type OverseerAction } from './types';

export interface RefireInput {
  runId: string;
  workflow: string;
  dispatchId: string;
  fencingToken: number;
}

export function planRefireAction(input: RefireInput): OverseerAction {
  const evidence: ActionEvidence[] = [
    { key: 'workflow', value: input.workflow },
    { key: 'dispatch_id', value: input.dispatchId },
    { key: 'fencing_token', value: String(input.fencingToken) },
  ];
  return {
    ...makeAction('refire', {
      runId: input.runId,
      reason: 'Refire is allowed only with current overseer fencing token',
      evidence,
    }),
    fencingToken: input.fencingToken,
  };
}
