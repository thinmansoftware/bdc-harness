/**
 * Unattended merge execution: claim a flag_merge_ready verdict, re-check GitHub,
 * and squash-merge when policy, allowlist, and the hourly ceiling all pass.
 *
 * Allowlist (OVERSEER_MERGE_REPO_CONFIG): JSON object keyed by the full GitHub
 * identity `owner/repo` (exactly one slash, both sides non-empty), each value
 * `{ "baseBranch": "<integration-branch>" }`. Repo-only keys are invalid and
 * fail closed (empty allowlist). Defaults:
 *   thinmansoftware/bdc-harness -> dev
 *   thinmansoftware/shopops -> staging
 *   thinmansoftware/lspro-react -> dev
 * Lookup compares BOTH run.owner and run.repo; mismatch -> skip('repo_not_allowed').
 *
 * Ceiling (OVERSEER_MAX_MERGES_PER_HOUR, default 4): occupancy is reserved
 * atomically in durable storage before any GitHub merge mutation. A failed
 * merge releases its reservation; a successful merge keeps it for the window.
 */
import { createLogger } from '@archon/paths';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import { readOverseerActionPolicyFromEnv, type OverseerActionPolicy } from './action-policy';
import { isSpecOnlyChangeSet } from './reconcile';
import type { GitHubClientDeps } from './types.ts';

const log = createLogger('overseer/merge-coordinator');
const DEFAULT_MAX_MERGES_PER_HOUR = 4;
const FLAG_MERGE_READY = 'flag_merge_ready';
const DEFAULT_REPO_CONFIG: Readonly<Record<string, { baseBranch: string }>> = Object.freeze({
  'thinmansoftware/bdc-harness': { baseBranch: 'dev' },
  'thinmansoftware/shopops': { baseBranch: 'staging' },
  'thinmansoftware/lspro-react': { baseBranch: 'dev' },
});
const REPO_CONFIG_ENV = 'OVERSEER_MERGE_REPO_CONFIG';

export type MergeExecutionRepoConfig = Readonly<Record<string, { readonly baseBranch: string }>>;

export interface MergeExecutionBridgeStore {
  listUnactionedVerdicts(): Promise<OverseerVerdictRow[]>;
  claimVerdict(verdictId: string): Promise<boolean>;
  releaseVerdictClaim(verdictId: string, reason: string): Promise<boolean>;
  getRunById(runId: string): Promise<OverseerWatchRun | null>;
  reserveMergeSlot(verdictId: string, since: string, limit: number): Promise<boolean>;
  releaseMergeSlot(verdictId: string): Promise<void>;
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
  repoConfig?: MergeExecutionRepoConfig;
}

function configuredLimit(override?: number): number {
  if (override !== undefined) return override;
  const parsed = Number.parseInt(process.env.OVERSEER_MAX_MERGES_PER_HOUR ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_MERGES_PER_HOUR;
}

function isOwnerRepoIdentity(key: string): boolean {
  const slash = key.indexOf('/');
  return slash > 0 && !key.includes('/', slash + 1) && slash < key.length - 1;
}

function configuredRepos(override?: MergeExecutionRepoConfig): MergeExecutionRepoConfig {
  if (override !== undefined) return override;
  const raw = process.env[REPO_CONFIG_ENV];
  if (raw === undefined) return DEFAULT_REPO_CONFIG;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const config: Record<string, { baseBranch: string }> = {};
    for (const [repo, value] of Object.entries(parsed)) {
      if (
        repo.trim() !== repo ||
        repo.length === 0 ||
        !isOwnerRepoIdentity(repo) ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        typeof (value as { baseBranch?: unknown }).baseBranch !== 'string'
      ) {
        return {};
      }
      const baseBranch = (value as { baseBranch: string }).baseBranch.trim();
      if (!baseBranch) return {};
      config[repo] = { baseBranch };
    }
    return config;
  } catch {
    // A malformed unattended-merge allowlist must fail closed.
    return {};
  }
}

function isDocumentationOnly(paths: readonly string[]): boolean {
  return (
    paths.length === 0 ||
    isSpecOnlyChangeSet(paths) ||
    paths.every(path => path.startsWith('docs/') || path.toLowerCase().endsWith('.md'))
  );
}

async function recordPostMutationOutcome(
  options: MergeExecutionBridgeOptions,
  verdict: OverseerVerdictRow,
  input: { reason: string; mergeSha?: string; prUrl?: string }
): Promise<boolean> {
  try {
    await options.store.recordOutcome({
      verdictId: verdict.id,
      mutationSent: true,
      reason: input.reason,
      mergeSha: input.mergeSha,
      prUrl: input.prUrl,
    });
    return true;
  } catch (error) {
    log.error(
      {
        err: error as Error,
        verdictId: verdict.id,
        runId: verdict.run_id,
        woId: verdict.wo_id,
        mergeSha: input.mergeSha,
        prUrl: input.prUrl,
      },
      'merge-coordinator.merge_outcome_persist_failed'
    );
    try {
      await options.store.recordOutcome({
        verdictId: verdict.id,
        mutationSent: true,
        reason: `merge_executed_outcome_unpersisted:${
          error instanceof Error && error.message ? error.message : 'unknown'
        }`,
        mergeSha: input.mergeSha,
        prUrl: input.prUrl,
      });
    } catch {
      // Retain the slot and processing claim so the mutation is not retried or uncounted.
    }
    return false;
  }
}

async function mergeClaimedVerdict(
  options: MergeExecutionBridgeOptions,
  verdict: OverseerVerdictRow,
  repoConfig: MergeExecutionRepoConfig
): Promise<'stop' | undefined> {
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
  if (!policy.service_enabled) {
    await skip('service_disabled');
    return;
  }
  if (policy.emergency_stop) {
    await skip('emergency_stop');
    return;
  }
  if (policy.legacy_dry_run) {
    await skip('legacy_dry_run');
    return;
  }
  if (!policy.capability_flags.merge) {
    await skip('merge_actions_disabled');
    return;
  }

  const run = await options.store.getRunById(verdict.run_id);
  if (!run?.owner || !run.repo) {
    await skip('run_context_unresolvable');
    return;
  }
  const config = repoConfig[`${run.owner}/${run.repo}`];
  if (!config) {
    await skip('repo_not_allowed');
    return;
  }

  const pr = await options.github.findPullRequest({
    owner: run.owner,
    repo: run.repo,
    headBranch: run.headBranch,
    woId: run.woId,
    includeChangedFiles: true,
  });
  if (!pr.exists || !pr.pr) {
    await skip(pr.lookupFailed ? 'pr_lookup_failed' : 'open_pr_not_found', pr.htmlUrl);
    return;
  }
  if (pr.headSha !== verdict.head_sha) {
    await skip('verdict_stale_head', pr.htmlUrl);
    return;
  }
  if (pr.state !== 'open') {
    await skip('pr_not_open', pr.htmlUrl);
    return;
  }
  if (pr.checks.total === 0 || pr.checks.failed > 0 || pr.checks.pending > 0) {
    await skip('required_checks_not_success', pr.htmlUrl);
    return;
  }
  if (pr.mergeable !== true || pr.mergeableState !== 'clean') {
    await skip('mergeable_state_not_clean', pr.htmlUrl);
    return;
  }
  if (!pr.changedFilePaths) {
    await skip('changed_files_unresolved', pr.htmlUrl);
    return;
  }
  if (isDocumentationOnly(pr.changedFilePaths)) {
    await skip('spec_only', pr.htmlUrl);
    return;
  }
  if (pr.baseBranch !== config.baseBranch) {
    await skip('integration_base_mismatch', pr.htmlUrl);
    return;
  }

  const now = (options.now ?? ((): Date => new Date()))();
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  if (
    !(await options.store.reserveMergeSlot(
      verdict.id,
      since,
      configuredLimit(options.maxMergesPerHour)
    ))
  ) {
    await options.store.releaseVerdictClaim(verdict.id, 'rate_ceiling_deferred');
    log.info(
      {
        verdictId: verdict.id,
        runId: verdict.run_id,
        woId: verdict.wo_id,
        prUrl: pr.htmlUrl,
      },
      'merge-coordinator.rate_ceiling_deferred'
    );
    return 'stop';
  }

  if (options.github.approvePullRequest) {
    try {
      await options.github.approvePullRequest({
        ...pr.pr,
        expectedHeadSha: verdict.head_sha,
      });
    } catch (error) {
      log.warn(
        { err: error as Error, verdictId: verdict.id },
        'merge-coordinator.approval_failed_nonfatal'
      );
    }
  }
  let merged: Awaited<ReturnType<GitHubClientDeps['mergePullRequest']>>;
  try {
    merged = await options.github.mergePullRequest({
      ...pr.pr,
      mergeMethod: 'squash',
      expectedHeadSha: verdict.head_sha,
    });
  } catch (error) {
    await options.store.releaseMergeSlot(verdict.id);
    await skip(
      error instanceof Error && error.message ? `merge_failed:${error.message}` : 'merge_failed',
      pr.htmlUrl
    );
    return;
  }
  if (!merged.merged) {
    if (merged.message === 'github_merge_transport_ambiguous') {
      await recordPostMutationOutcome(options, verdict, {
        reason: 'github_merge_transport_ambiguous',
        mergeSha: merged.mergeSha ?? merged.sha,
        prUrl: pr.htmlUrl,
      });
      return;
    }
    await options.store.releaseMergeSlot(verdict.id);
    await skip(merged.message ?? 'merge_failed', pr.htmlUrl);
    return;
  }
  const persisted = await recordPostMutationOutcome(options, verdict, {
    reason: 'merge_executed',
    mergeSha: merged.mergeSha,
    prUrl: pr.htmlUrl,
  });
  if (!persisted) return;
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

export async function runMergeExecutionBridgeOnce(
  options: MergeExecutionBridgeOptions
): Promise<void> {
  const repoConfig = configuredRepos(options.repoConfig);
  const verdicts = await options.store.listUnactionedVerdicts();
  for (const verdict of verdicts) {
    if (verdict.proposed_action !== FLAG_MERGE_READY) continue;
    if (!(await options.store.claimVerdict(verdict.id))) continue;
    try {
      if ((await mergeClaimedVerdict(options, verdict, repoConfig)) === 'stop') break;
    } catch (error) {
      await options.store.releaseMergeSlot(verdict.id);
      await options.store.releaseVerdictClaim(
        verdict.id,
        error instanceof Error && error.message ? error.message : 'unexpected_error'
      );
      log.error(
        { err: error as Error, verdictId: verdict.id, runId: verdict.run_id, woId: verdict.wo_id },
        'merge-coordinator.claim_released'
      );
    }
  }
}
