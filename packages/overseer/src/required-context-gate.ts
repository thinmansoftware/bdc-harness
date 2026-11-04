/**
 * The required-context check gate, shared by the merge bridge and merge
 * candidate discovery so both judge a pull request's checks the same way.
 *
 * Moved here from merge-execution-bridge.ts (PR 1449 logic, unchanged) so
 * discovery can reuse it without importing the bridge, which already imports
 * discovery.
 */
import type { PullRequestCommitStatus } from './types.ts';
import {
  conclusionIsPassing,
  latestAttemptPerCheck,
  type RecheckCheckRun,
} from './pr-review-check-ingest';

function commitStatusRank(status: PullRequestCommitStatus): number {
  const created = typeof status.createdAt === 'string' ? Date.parse(status.createdAt) : NaN;
  if (Number.isFinite(created)) return created;
  const updated = typeof status.updatedAt === 'string' ? Date.parse(status.updatedAt) : NaN;
  if (Number.isFinite(updated)) return updated;
  return Number.NEGATIVE_INFINITY;
}

function commitStatusIsNewer(
  candidate: PullRequestCommitStatus,
  current: PullRequestCommitStatus
): boolean {
  const candidateRank = commitStatusRank(candidate);
  const currentRank = commitStatusRank(current);
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  return (candidate.id ?? 0) > (current.id ?? 0);
}

/** Latest status per context name. Names match after trim and case fold. */
function latestCommitStatusPerContext(
  statuses: readonly PullRequestCommitStatus[]
): Map<string, PullRequestCommitStatus> {
  const latest = new Map<string, PullRequestCommitStatus>();
  for (const status of statuses) {
    const key = status.context.trim().toLowerCase();
    if (key.length === 0) continue;
    const held = latest.get(key);
    if (!held || commitStatusIsNewer(status, held)) latest.set(key, status);
  }
  return latest;
}

function commitStatusIsPassing(state: string): boolean {
  return state.trim().toLowerCase() === 'success';
}

/**
 * Required contexts that are missing, still running, or completed without a
 * passing conclusion. Names match after trim and case fold. Only the latest
 * attempt per check name and app is considered. A context with no check run
 * can still pass when its latest commit status state is success. When the
 * same context has both a check run and a commit status, both must pass: a
 * successful run does not hide a failed or pending status, and a successful
 * status does not hide a failing run. The returned strings are the required
 * context names, not the check-run display names.
 */
export function blockingRequiredContexts(
  contexts: readonly string[],
  runs: readonly RecheckCheckRun[],
  statuses: readonly PullRequestCommitStatus[]
): string[] {
  const latest = latestAttemptPerCheck([...runs]);
  const latestStatuses = latestCommitStatusPerContext(statuses);
  const blocking: string[] = [];
  for (const context of contexts) {
    const want = context.trim().toLowerCase();
    const matches = latest.filter(run => (run.name ?? '').trim().toLowerCase() === want);
    const status = latestStatuses.get(want);
    if (matches.length === 0 && !status) {
      blocking.push(context);
      continue;
    }
    const runBlocking = matches.some(
      run => run.status !== 'completed' || !conclusionIsPassing(run.conclusion)
    );
    const statusBlocking = status !== undefined && !commitStatusIsPassing(status.state);
    if (runBlocking || statusBlocking) blocking.push(context);
  }
  return blocking;
}

function commitStatusIsPending(state: string): boolean {
  return state.trim().toLowerCase() === 'pending';
}

/**
 * The blocking required contexts from `blockingRequiredContexts`, split into
 * failing and pending. A context is failing when its latest run completed
 * without a passing conclusion, or its latest commit status is neither success
 * nor pending. Every other blocking context is pending: missing from the run
 * and status lists, still running, or carrying a pending status. Failing wins
 * when a context has both a failing and a pending signal.
 */
export function partitionBlockingRequiredContexts(
  contexts: readonly string[],
  runs: readonly RecheckCheckRun[],
  statuses: readonly PullRequestCommitStatus[]
): { failing: string[]; pending: string[] } {
  const blocking = blockingRequiredContexts(contexts, runs, statuses);
  const latest = latestAttemptPerCheck([...runs]);
  const latestStatuses = latestCommitStatusPerContext(statuses);
  const failing: string[] = [];
  const pending: string[] = [];
  for (const context of blocking) {
    const want = context.trim().toLowerCase();
    const runFailed = latest.some(
      run =>
        (run.name ?? '').trim().toLowerCase() === want &&
        run.status === 'completed' &&
        !conclusionIsPassing(run.conclusion)
    );
    const status = latestStatuses.get(want);
    const statusFailed =
      status !== undefined &&
      !commitStatusIsPassing(status.state) &&
      !commitStatusIsPending(status.state);
    if (runFailed || statusFailed) failing.push(context);
    else pending.push(context);
  }
  return { failing, pending };
}
