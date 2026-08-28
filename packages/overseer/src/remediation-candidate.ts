interface DispatchCreateInput {
  correlation_id: string;
  idempotency_key: string;
  task_type: 'agent_message';
  sender: string;
  recipient: string;
  body: string;
  subject_key: string;
  repeat_reason: string;
}

type DispatchCreateMessage = (input: DispatchCreateInput) => Promise<unknown>;

export const REMEDIATION_MESSAGE_KIND = 'overseer_remediation_candidate_v1' as const;
export const REMEDIATION_WO_ID =
  'WO-HARNESS-OVERSEER-VERDICT-TO-TASKMASTER-REMEDIATION-01' as const;
export const DEFAULT_MAX_REMEDIATION_ATTEMPTS = 2;

export interface RemediationCandidateBody {
  kind: typeof REMEDIATION_MESSAGE_KIND;
  woId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  attempt: number;
  verdictId: string;
  verdictBody: string;
}

export type RemediationCandidateInput = Omit<RemediationCandidateBody, 'kind'>;

export interface RemediationCandidateDeps {
  createMessage: DispatchCreateMessage;
}

export function buildRemediationIdempotencyKey(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  attempt: number
): string {
  return `overseer-remediation:${owner.toLowerCase()}/${repo.toLowerCase()}#${prNumber}:${headSha}:${attempt}`;
}

export async function emitRemediationCandidate(
  input: RemediationCandidateInput,
  deps?: RemediationCandidateDeps
): Promise<unknown> {
  const create = deps?.createMessage ?? (await import('@archon/core/db/dispatch')).createMessage;
  const body: RemediationCandidateBody = { kind: REMEDIATION_MESSAGE_KIND, ...input };
  return create({
    correlation_id: input.verdictId,
    idempotency_key: buildRemediationIdempotencyKey(
      input.owner,
      input.repo,
      input.prNumber,
      input.headSha,
      input.attempt
    ),
    task_type: 'agent_message',
    sender: 'overseer',
    recipient: 'taskmaster',
    body: JSON.stringify(body),
    subject_key: `gh:${input.owner}/${input.repo}#${input.prNumber}`,
    repeat_reason: `Overseer remediation attempt ${input.attempt} for reviewed head ${input.headSha}`,
  });
}
