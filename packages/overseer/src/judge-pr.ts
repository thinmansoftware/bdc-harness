import type { GitHubClientDeps, OverseerRunRecord, PullRequestEvidence } from './types.ts';

const missingEvidence: PullRequestEvidence = {
  exists: false,
  state: 'missing',
  checks: { total: 0, passed: 0, failed: 0, pending: 0 },
  mergeable: null,
  lookupFailed: false,
};

/**
 * The run carries no identity to look a PR up by, so no lookup was performed and
 * nothing about PR existence was established. Reported as unknown, not as "no PR".
 */
const unresolvableEvidence: PullRequestEvidence = {
  exists: false,
  state: 'lookup_failed',
  checks: { total: 0, passed: 0, failed: 0, pending: 0 },
  mergeable: null,
  lookupFailed: true,
};

export async function judgePullRequest(
  run: Pick<OverseerRunRecord, 'owner' | 'repo' | 'headBranch' | 'woId'>,
  deps: GitHubClientDeps
): Promise<PullRequestEvidence> {
  if (!run.headBranch && !run.woId) return missingEvidence;
  // Without a repo we cannot search anywhere. Previously the repo was defaulted
  // upstream, so this searched bluedevilcollectibles/bdc-harness for every run --
  // wrong repo, confident answer. Fail loud instead of guessing.
  if (!run.owner || !run.repo) return unresolvableEvidence;
  return deps.findPullRequest({
    owner: run.owner,
    repo: run.repo,
    headBranch: run.headBranch,
    woId: run.woId,
  });
}

export function isPrGreen(evidence: PullRequestEvidence): boolean {
  if (!evidence.exists) return false;
  if (evidence.state === 'merged') return true;
  return evidence.checks.total > 0 && evidence.checks.failed === 0 && evidence.checks.pending === 0;
}

export function isPrMergeReady(evidence: PullRequestEvidence): boolean {
  return (
    evidence.exists &&
    evidence.state === 'open' &&
    evidence.mergeable === true &&
    isPrGreen(evidence)
  );
}
