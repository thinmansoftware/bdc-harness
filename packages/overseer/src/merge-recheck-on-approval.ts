import { createLogger } from '@archon/paths';
import type { OverseerRunRecord, WatchedRunRecord } from './types';
import type { MergeManagerResult } from './merge-manager';

const log = createLogger('overseer/merge-recheck-on-approval');
export const OVERSEER_MERGE_RECHECK_ON_APPROVAL = 'OVERSEER_MERGE_RECHECK_ON_APPROVAL';
export const mergeRecheckOnApprovalEnabled = (env = process.env): boolean =>
  env[OVERSEER_MERGE_RECHECK_ON_APPROVAL] === 'true';

export interface ApprovalMergeRecheckInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  reviewId: number;
  runId: string;
  woId: string;
}

export interface ApprovalMergeRecheckDeps {
  claim(input: { runId: string; woId: string; key: string }): Promise<string | null>;
  finish(input: { id: string; key: string; outcome: string }): Promise<void>;
  getRun(runId: string): Promise<OverseerRunRecord | null>;
  assessRun(run: OverseerRunRecord): Promise<WatchedRunRecord>;
  mergeManager(record: WatchedRunRecord): Promise<MergeManagerResult>;
}

export async function runMergeRecheckOnApproval(
  input: ApprovalMergeRecheckInput,
  deps: ApprovalMergeRecheckDeps
): Promise<void> {
  if (!mergeRecheckOnApprovalEnabled()) return;
  const key = `${input.owner.toLowerCase()}/${input.repo.toLowerCase()}#${input.prNumber}@${input.headSha}:review:${input.reviewId}`;
  const id = await deps.claim({ runId: input.runId, woId: input.woId, key });
  if (!id) return;
  let outcome = 'held:recheck_failed';
  try {
    const run = await deps.getRun(input.runId);
    if (
      !run ||
      run.owner?.toLowerCase() !== input.owner.toLowerCase() ||
      run.repo?.toLowerCase() !== input.repo.toLowerCase()
    ) {
      outcome = 'denied:run_context_unresolvable';
    } else {
      const record = await deps.assessRun(run);
      const pr = record.prEvidence;
      if (pr.headSha !== input.headSha) outcome = 'denied:head_moved';
      else if (
        pr.pr?.number !== input.prNumber ||
        pr.pr.owner.toLowerCase() !== input.owner.toLowerCase() ||
        pr.pr.repo.toLowerCase() !== input.repo.toLowerCase()
      ) {
        outcome = 'denied:pr_identity_mismatch';
      } else {
        const result = await deps.mergeManager({
          ...record,
          // The manager re-reads GitHub during assembly. Keep its existing
          // expectedHeadSha contract pinned to the approval even if a push
          // races that read; the GitHub merge precondition will reject it.
          metadata: { ...record.metadata, head_sha: input.headSha },
        });
        outcome =
          result.status === 'executed'
            ? result.execution.merged
              ? 'merged'
              : `denied:${result.execution.message ?? 'merge_failed'}`
            : `held:${result.reason}`;
      }
    }
  } catch {
    log.warn({ key }, 'overseer.merge_recheck_on_approval.failed');
  }
  // A crash or ambiguous post-mutation error retains the claimed row. Replays
  // never attempt a second merge, including after a process restart.
  await deps.finish({ id, key, outcome });
}
