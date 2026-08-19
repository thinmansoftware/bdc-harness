import { createLogger } from '@archon/paths';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import { readOverseerActionPolicyFromEnv, type OverseerActionPolicy } from './action-policy';
import type { GitHubClientDeps } from './types.ts';

const log = createLogger('overseer/merge-coordinator');
const DEFAULT_MAX_MERGES_PER_HOUR = 4;
const FLAG_MERGE_READY = 'flag_merge_ready';
const REPO_CONFIG: Readonly<Record<string, { baseBranch: string }>> = Object.freeze({
  'bdc-harness': { baseBranch: 'dev' },
  shopops: { baseBranch: 'staging' },
  'lspro-react': { baseBranch: 'dev' },
});

export interface MergeExecutionBridgeStore {
  listUnactionedVerdicts(): Promise<OverseerVerdictRow[]>;
  claimVerdict(verdictId: string): Promise<boolean>;
  getRunById(runId: string): Promise<OverseerWatchRun | null>;
  countRecentMerges(since: string): Promise<number>;
  recordOutcome(input: {
    verdictId: string;
    mutationSent: boolean;
    reason: string;
    mergeSha?: string;
    prUrl?: string;
  }): Promise<unknown>;
}

export interface MergeExecutionBridgeOptions {
  store: MergeExecutionBridgeStore;
  github: GitHubClientDeps;
  readPolicy?: () => OverseerActionPolicy;
  now?: () => Date;
  maxMergesPerHour?: number;
}

function configuredLimit(override?: number): number {
  if (override !== undefined) return override;
  const parsed = Number.parseInt(process.env.OVERSEER_MAX_MERGES_PER_HOUR ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_MERGES_PER_HOUR;
}

function containsCode(paths: readonly string[]): boolean {
  return paths.some(path => !path.startsWith('docs/') && !path.toLowerCase().endsWith('.md'));
}

export async function runMergeExecutionBridgeOnce(
  options: MergeExecutionBridgeOptions
): Promise<void> {
  const verdicts = await options.store.listUnactionedVerdicts();
  for (const verdict of verdicts) {
    if (verdict.proposed_action !== FLAG_MERGE_READY) continue;
    if (!(await options.store.claimVerdict(verdict.id))) continue;
    const skip = async (reason: string, prUrl?: string): Promise<void> => {
      await options.store.recordOutcome({
        verdictId: verdict.id,
        mutationSent: false,
        reason,
        prUrl,
      });
      log.info(
        { verdictId: verdict.id, runId: verdict.run_id, woId: verdict.wo_id, reason, prUrl },
        'merge-coordinator.merge_skipped'
      );
    };

    const policy = (options.readPolicy ?? readOverseerActionPolicyFromEnv)();
    if (policy.emergency_stop) {
      await skip('emergency_stop');
      continue;
    }
    if (!policy.capability_flags.merge) {
      await skip('merge_actions_disabled');
      continue;
    }

    const run = await options.store.getRunById(verdict.run_id);
    if (!run?.owner || !run.repo) {
      await skip('run_context_unresolvable');
      continue;
    }
    const config = REPO_CONFIG[run.repo];
    if (!config) {
      await skip('repo_not_allowed');
      continue;
    }

    const pr = await options.github.findPullRequest({
      owner: run.owner,
      repo: run.repo,
      headBranch: run.headBranch,
      woId: run.woId,
      includeChangedFiles: true,
    });
    if (!pr.exists || pr.state !== 'open' || !pr.pr) {
      await skip(pr.lookupFailed ? 'pr_lookup_failed' : 'open_pr_not_found', pr.htmlUrl);
      continue;
    }
    if (pr.headSha !== verdict.head_sha) {
      await skip('verdict_stale_head', pr.htmlUrl);
      continue;
    }
    if (pr.checks.total === 0 || pr.checks.failed > 0 || pr.checks.pending > 0) {
      await skip('required_checks_not_success', pr.htmlUrl);
      continue;
    }
    if (pr.mergeable !== true || pr.mergeableState !== 'clean') {
      await skip('mergeable_state_not_clean', pr.htmlUrl);
      continue;
    }
    if (!pr.changedFilePaths || !containsCode(pr.changedFilePaths)) {
      await skip('spec_only', pr.htmlUrl);
      continue;
    }
    if (pr.baseBranch !== config.baseBranch) {
      await skip('integration_base_mismatch', pr.htmlUrl);
      continue;
    }

    const now = (options.now ?? (() => new Date()))();
    const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    if (
      (await options.store.countRecentMerges(since)) >= configuredLimit(options.maxMergesPerHour)
    ) {
      await skip('rate_ceiling_exceeded', pr.htmlUrl);
      continue;
    }

    if (options.github.approvePullRequest) {
      try {
        await options.github.approvePullRequest(pr.pr);
      } catch (error) {
        log.warn(
          { err: error as Error, verdictId: verdict.id },
          'merge-coordinator.approval_failed_nonfatal'
        );
      }
    }
    let merged: Awaited<ReturnType<GitHubClientDeps['mergePullRequest']>>;
    try {
      merged = await options.github.mergePullRequest({ ...pr.pr, mergeMethod: 'squash' });
    } catch (error) {
      await skip(
        error instanceof Error && error.message ? `merge_failed:${error.message}` : 'merge_failed',
        pr.htmlUrl
      );
      continue;
    }
    if (!merged.merged) {
      await skip(merged.message ?? 'merge_failed', pr.htmlUrl);
      continue;
    }
    await options.store.recordOutcome({
      verdictId: verdict.id,
      mutationSent: true,
      reason: 'merge_executed',
      mergeSha: merged.mergeSha,
      prUrl: pr.htmlUrl,
    });
    log.info(
      {
        verdictId: verdict.id,
        runId: verdict.run_id,
        woId: verdict.wo_id,
        prUrl: pr.htmlUrl,
        mergeSha: merged.mergeSha,
        mutationSent: true,
        timestamp: now.toISOString(),
      },
      'merge-coordinator.merge_executed'
    );
  }
}
