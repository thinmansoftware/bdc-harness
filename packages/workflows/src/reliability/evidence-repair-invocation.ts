/** Authoritative GitHub records assembled by the collector, never agent output. */
export interface RepairInvocation {
  readonly repositoryId: number;
  readonly repository: string;
  readonly pr: number;
  readonly head: string;
  readonly runId: number;
  readonly attempt: number;
  readonly workflowId: number;
  readonly jobId: number;
  readonly checkId: number;
  readonly checkName: string;
  readonly appId: number;
  readonly event: string;
  readonly checkConclusion: string;
  readonly stepConclusion: string;
  readonly callerSha: string;
  readonly reusableSha: string;
  readonly scriptsSha: string;
  readonly checkoutSha: string;
  readonly checkoutParents: readonly string[];
  readonly stepNumber: number;
  readonly stepName: string;
}
export interface RepairIdentityBinding {
  readonly repairHead: string;
  readonly baseSha: string;
  readonly finalLocalHead: string;
  readonly finalRemoteHead: string;
  readonly callerSha: string;
  readonly reusableSha: string;
  readonly scriptsSha: string;
}
export type RepairIdentityResult =
  | { readonly state: 'verified' }
  | { readonly state: 'unknown'; readonly reason: string };

/** Identity gate only: input-body proof and manifest/stops remain separate gates. */
export function verifyRepairInvocation(
  original: RepairInvocation,
  current: RepairInvocation,
  binding: RepairIdentityBinding
): RepairIdentityResult {
  const unknown = (reason: string): RepairIdentityResult => ({ state: 'unknown', reason });
  const sha = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
  for (const record of [original, current]) {
    if (
      ![
        record.repositoryId,
        record.pr,
        record.runId,
        record.attempt,
        record.workflowId,
        record.jobId,
        record.checkId,
        record.appId,
        record.stepNumber,
      ].every(positive) ||
      ![
        record.head,
        record.callerSha,
        record.reusableSha,
        record.scriptsSha,
        record.checkoutSha,
      ].every(sha)
    ) {
      return unknown('invocation_identity_missing');
    }
  }
  if (
    original.checkConclusion !== 'failure' ||
    current.runId === original.runId ||
    current.jobId === original.jobId ||
    current.checkId === original.checkId
  ) {
    return unknown('original_failed_check_new_invocation_required');
  }
  for (const key of [
    'repositoryId',
    'repository',
    'pr',
    'head',
    'workflowId',
    'checkName',
    'appId',
    'stepNumber',
    'stepName',
  ] as const) {
    if (!original[key] || current[key] !== original[key])
      return unknown('invocation_identity_mismatch');
  }
  if (
    current.appId !== 15368 ||
    current.event !== 'pull_request' ||
    original.event !== 'pull_request' ||
    current.checkId !== current.jobId ||
    original.checkId !== original.jobId
  )
    return unknown('producer_or_event_mismatch');
  if (
    ![binding.repairHead, binding.finalLocalHead, binding.finalRemoteHead].every(sha) ||
    current.head !== binding.repairHead ||
    binding.finalLocalHead !== binding.repairHead ||
    binding.finalRemoteHead !== binding.repairHead
  )
    return unknown('repair_head_changed');
  for (const key of ['callerSha', 'reusableSha', 'scriptsSha'] as const) {
    if (!sha(binding[key]) || current[key] !== binding[key])
      return unknown('execution_source_mismatch');
  }
  // A merge checkout is acceptable only with exactly two independently verified
  // parents, including this PR head. Merely reporting a PR head in run metadata
  // does not prove that the validator checked out that scope.
  if (
    current.checkoutSha !== current.head &&
    (current.checkoutParents.length !== 2 ||
      !current.checkoutParents.every(sha) ||
      !current.checkoutParents.includes(current.head) ||
      !sha(binding.baseSha) ||
      !current.checkoutParents.includes(binding.baseSha))
  )
    return unknown('checkout_scope_mismatch');
  if (current.stepConclusion !== 'success' || current.checkConclusion !== 'success') {
    return unknown('validation_not_successful');
  }
  return { state: 'verified' };
}
