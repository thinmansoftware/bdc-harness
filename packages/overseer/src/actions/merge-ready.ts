import type { DecisionResult } from '../decide.ts';
import { isPrMergeReady } from '../judge-pr';
import type { GitHubClientDeps, OverseerActionsDeps, WatchedRunRecord } from '../types.ts';

const INTERNAL_REPO_ALLOWLIST = new Set(['bdc-harness', 'bdc-xo']);

export interface MergeReadyResult {
  decision: DecisionResult;
  action: 'merged' | 'report_only' | 'not_ready' | 'dry_run';
  merged: boolean;
  result: string;
}

export interface HandleMergeReadyOptions {
  dryRun?: boolean;
}

export function isInternalMergeAllowed(repo: string): boolean {
  return INTERNAL_REPO_ALLOWLIST.has(repo);
}

export async function handleMergeReady(
  record: WatchedRunRecord,
  deps: GitHubClientDeps & OverseerActionsDeps,
  options: HandleMergeReadyOptions = {}
): Promise<MergeReadyResult> {
  const decision: DecisionResult = {
    decision: 'merge_ready',
    reason: record.reason,
  };

  if (!isPrMergeReady(record.prEvidence) || !record.prEvidence.pr) {
    const result = 'PR evidence is not green and mergeable';
    await deps.insertOverseerAction({
      runId: record.runId,
      woId: record.woId,
      class: 'tail_node_false_fail',
      action: 'merge_ready',
      result,
    });
    return { decision, action: 'not_ready', merged: false, result };
  }

  if (options.dryRun) {
    return { decision, action: 'dry_run', merged: false, result: 'dry run: merge skipped' };
  }

  if (!isInternalMergeAllowed(record.repo)) {
    const result = `report-only: ${record.repo} is outside internal merge allowlist`;
    await deps.insertOverseerAction({
      runId: record.runId,
      woId: record.woId,
      class: 'tail_node_false_fail',
      action: 'report_only',
      result,
    });
    return { decision, action: 'report_only', merged: false, result };
  }

  const merge = await deps.mergePullRequest({
    ...record.prEvidence.pr,
    commitTitle: `Merge ${record.woId} after overseer PR-evidence check`,
  });
  const result = merge.message ?? (merge.merged ? 'merged' : 'merge API returned not merged');
  await deps.insertOverseerAction({
    runId: record.runId,
    woId: record.woId,
    class: 'tail_node_false_fail',
    action: 'merge_ready',
    result,
  });
  return { decision, action: 'merged', merged: merge.merged, result };
}
