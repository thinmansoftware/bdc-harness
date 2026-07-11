export type OverseerActionKind = 'merge_ready' | 'salvage' | 'rate_limit' | 'refire';
export type OverseerActionStatus = 'planned' | 'reserved' | 'completed' | 'failed' | 'blocked';

export interface ActionEvidence {
  key: string;
  value: string;
}

export interface OverseerAction {
  id: string;
  runId: string;
  kind: OverseerActionKind;
  status: OverseerActionStatus;
  reason: string;
  createdAt: string;
  updatedAt: string;
  fencingToken?: number;
  evidence: ActionEvidence[];
}

export interface OverseerActionInput {
  runId: string;
  reason: string;
  evidence?: ActionEvidence[];
}

export function makeAction(
  kind: OverseerActionKind,
  input: OverseerActionInput,
  status: OverseerActionStatus = 'planned'
): OverseerAction {
  const now = new Date().toISOString();
  return {
    id: `${input.runId}:${kind}:${now}`,
    runId: input.runId,
    kind,
    status,
    reason: input.reason,
    createdAt: now,
    updatedAt: now,
    evidence: input.evidence ?? [],
  };
}
