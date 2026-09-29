/**
 * Unattended merge execution: claim a flag_merge_ready verdict, re-check GitHub,
 * and squash-merge when policy, allowlist, and the hourly ceiling all pass.
 *
 * Policy (MERGE_MANAGER_REPO_POLICY) is keyed by full GitHub identity and base.
 * OVERSEER_MERGE_REPO_CONFIG remains a deprecated one-release compatibility input.
 * Lookup compares BOTH run.owner and run.repo; mismatch -> skip('repo_not_allowed').
 *
 * Run-less verdicts (bdc-harness #846): a PR-first candidate has no run row, so
 * its verdict carries the PR identity in the synthetic `pr-discovery:owner/repo#N`
 * run id (or a `gh:owner/repo#N` wo_id). The bridge resolves those from GitHub by
 * PR number and applies the same allowlist to the live base. Their skip reasons
 * are `pr_context_unresolvable`, `pr_not_open`, `head_moved`, `base_not_allowlisted`;
 * `run_context_unresolvable` stays reserved for a real run id whose row is gone.
 *
 * Ceiling (OVERSEER_MAX_MERGES_PER_HOUR, default 4): occupancy is reserved
 * atomically in durable storage before any GitHub merge mutation. A failed
 * merge releases its reservation; a successful merge keeps it for the window.
 */
import { createLogger } from '@archon/paths';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import { readOverseerActionPolicyFromEnv, type OverseerActionPolicy } from './action-policy';
import { PR_DISCOVERY_RUN_ID_PREFIX } from './merge-candidate-discovery';
import {
  getRepoBasePolicy,
  hasRepoPolicyEntry,
  LEGACY_REPO_CONFIG_ENV,
  MERGE_MANAGER_REPO_POLICY_ENV,
  resolveMergeRepoPolicy,
  type MergeRepoPolicy,
  type RepoBasePolicy,
  warnLegacyMergePolicy,
} from './merge-repo-policy';
import { isSpecOnlyChangeSet } from './reconcile';
import type { GitHubClientDeps, PullRequestEvidence } from './types.ts';
import { createRealOctokitClient } from './adapters/github-real-deps';
import {
  getScopeApprovalDecision,
  getScopeApprovalMetadata,
} from '@archon/core/db/board-scope-approvals';
import {
  ceScopePremergeRecheck,
  CE_GATE_NAME,
  type CeScopeRecheckDeps,
} from './ce-scope-premerge-recheck';

const log = createLogger('overseer/merge-coordinator');
const DEFAULT_MAX_MERGES_PER_HOUR = 4;
const FLAG_MERGE_READY = 'flag_merge_ready';
const RECEIPT_MARKER = '<!-- merge-manager-receipt -->';
const RECEIPT_KEY_PREFIX = '<!-- merge-manager-receipt-key';
export type MergeExecutionRepoConfig = Readonly<Record<string, { readonly baseBranch: string }>>;

export interface MergeExecutionBridgeStore {
  listUnactionedVerdicts(): Promise<OverseerVerdictRow[]>;
  claimVerdict(verdictId: string): Promise<boolean>;
  releaseVerdictClaim(verdictId: string, reason: string): Promise<boolean>;
  getRunById(runId: string): Promise<OverseerWatchRun | null>;
  // Optional so older/test stores that predate the active-run guard keep prior
  // behavior (bdc-harness #1046): when absent, no run-in-flight deferral runs.
  hasActiveRunForWo?(woId: string): Promise<boolean>;
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
  ceScopeRecheckDeps?: CeScopeRecheckDeps;
}

export interface MinimalCompareClient {
  repos: {
    compareCommits(input: Record<string, unknown>): Promise<{
      data: { files?: { filename: string; status: string; previous_filename?: string }[] };
    }>;
  };
}

export function buildCeScopeCompareAdapter(
  client: MinimalCompareClient
): CeScopeRecheckDeps['compare'] {
  return async (owner, repo, base, head) => {
    const data = (
      await client.repos.compareCommits({ owner, repo, base, head, per_page: 100, page: 1 })
    ).data;
    if (!data.files) return { complete: false };
    return { files: data.files, complete: data.files.length < 300 };
  };
}

function productionCeScopeRecheckDeps(): CeScopeRecheckDeps {
  const client = createRealOctokitClient() as unknown as {
    pulls: {
      get(input: Record<string, unknown>): Promise<{
        data: {
          number: number;
          state: string;
          head: { sha: string; ref: string };
          base: { ref: string };
        };
      }>;
    };
    repos: {
      getBranch(input: Record<string, unknown>): Promise<{ data: { commit: { sha: string } } }>;
      compareCommits(input: Record<string, unknown>): Promise<{
        data: { files?: { filename: string; status: string; previous_filename?: string }[] };
      }>;
    };
    actions: {
      listWorkflowRunsForRepo(input: Record<string, unknown>): Promise<{
        data: {
          total_count: number;
          workflow_runs: import('./ce-scope-premerge-recheck').CeWorkflowRun[];
        };
      }>;
    };
    checks: {
      listForRef(input: Record<string, unknown>): Promise<{
        data: {
          total_count: number;
          check_runs: import('./ce-scope-premerge-recheck').CeCheckRun[];
        };
      }>;
    };
  };
  return {
    getPullRequest: async (owner, repo, number) =>
      (await client.pulls.get({ owner, repo, pull_number: number })).data,
    getBranchTip: async (owner, repo, branch) =>
      (await client.repos.getBranch({ owner, repo, branch })).data.commit.sha,
    compare: buildCeScopeCompareAdapter(client),
    listWorkflowRuns: async (
      owner,
      repo,
      head
    ): Promise<readonly import('./ce-scope-premerge-recheck').CeWorkflowRun[]> => {
      const all: import('./ce-scope-premerge-recheck').CeWorkflowRun[] = [];
      for (let page = 1; ; page++) {
        const data = // head_sha = PR HEAD is correct for pull_request_target runs: verified on the
          // live API (see __tests__/fixtures/pull-request-target-run.live-2026-09-28.json).
          (
            await client.actions.listWorkflowRunsForRepo({
              owner,
              repo,
              head_sha: head,
              per_page: 100,
              page,
            })
          ).data;
        all.push(...data.workflow_runs);
        if (all.length >= data.total_count || data.workflow_runs.length < 100) return all;
      }
    },
    listCheckRuns: async (
      owner,
      repo,
      head
    ): Promise<readonly import('./ce-scope-premerge-recheck').CeCheckRun[]> => {
      const all: import('./ce-scope-premerge-recheck').CeCheckRun[] = [];
      for (let page = 1; ; page++) {
        const data = (
          await client.checks.listForRef({
            owner,
            repo,
            ref: head,
            check_name: CE_GATE_NAME,
            filter: 'all',
            per_page: 100,
            page,
          })
        ).data;
        all.push(...data.check_runs);
        if (all.length >= data.total_count || data.check_runs.length < 100) return all;
      }
    },
    getApproval: getScopeApprovalDecision,
    getMetadata: getScopeApprovalMetadata,
  };
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

function parseLegacyRepoConfig(raw: string): MergeExecutionRepoConfig {
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

function configuredPolicy(override?: MergeExecutionRepoConfig): MergeRepoPolicy {
  if (process.env[MERGE_MANAGER_REPO_POLICY_ENV] !== undefined) return resolveMergeRepoPolicy();
  if (override !== undefined) return resolveMergeRepoPolicy({ legacyRepoConfig: override });
  const raw = process.env[LEGACY_REPO_CONFIG_ENV];
  if (raw === undefined) return resolveMergeRepoPolicy();
  warnLegacyMergePolicy(LEGACY_REPO_CONFIG_ENV);
  return resolveMergeRepoPolicy({ legacyRepoConfig: parseLegacyRepoConfig(raw) });
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

type SkipVerdict = (reason: string, prUrl?: string) => Promise<void>;

interface MergeTarget {
  pr: PullRequestEvidence;
  basePolicy?: RepoBasePolicy;
}

interface RunlessPullRef {
  owner: string;
  repo: string;
  prNumber: number;
}

/** `wo_id` shape the PR-first sweep mints when a PR carries no WO id. */
const WO_ID_PULL_REF_PREFIX = 'gh:';
const PULL_REF_PATTERN = /^([^\s/#]+)\/([^\s/#]+)#(\d+)$/;

function parsePullRef(value: string, prefix: string): RunlessPullRef | null {
  if (!value.startsWith(prefix)) return null;
  const match = PULL_REF_PATTERN.exec(value.slice(prefix.length));
  const owner = match?.[1];
  const repo = match?.[2];
  const prNumber = Number.parseInt(match?.[3] ?? '', 10);
  if (!owner || !repo || !Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  return { owner, repo, prNumber };
}

/**
 * A verdict no Cauldron run produced (bdc-harness #846). The verdict store keys
 * rows by run id, so the PR-first sweep mints a synthetic `pr-discovery:` run id
 * (buildDiscoveredCandidateRecord) that no run row will ever match. An empty
 * run id is treated the same way. The typeof guards cover a NULL that reached
 * the row despite the column constraint; the column type says string.
 */
function isRunlessVerdict(verdict: OverseerVerdictRow): boolean {
  const runId = typeof verdict.run_id === 'string' ? verdict.run_id.trim() : '';
  return runId === '' || runId.startsWith(PR_DISCOVERY_RUN_ID_PREFIX);
}

function runlessPullRef(verdict: OverseerVerdictRow): RunlessPullRef | null {
  const runId = typeof verdict.run_id === 'string' ? verdict.run_id : '';
  const woId = typeof verdict.wo_id === 'string' ? verdict.wo_id : '';
  return (
    parsePullRef(runId, PR_DISCOVERY_RUN_ID_PREFIX) ?? parsePullRef(woId, WO_ID_PULL_REF_PREFIX)
  );
}

/**
 * Resolve a run-less verdict's merge target from GitHub itself. The PR is
 * addressed by NUMBER (the only unique key GitHub offers; the real adapter maps
 * this to `pulls.get`), so state/head/base read here are the live PR, not a
 * branch-name guess. Backlog replay is bounded here: only an OPEN PR whose
 * current head still equals the judged head reaches the shared tail, and the
 * hourly slot ceiling in that tail is unchanged. The owner/repo allowlist is
 * checked BEFORE the fetch so a non-allowlisted backlog row costs no API call.
 */
async function resolveRunlessTarget(
  options: MergeExecutionBridgeOptions,
  verdict: OverseerVerdictRow,
  repoPolicy: MergeRepoPolicy,
  skip: SkipVerdict
): Promise<MergeTarget | null> {
  const ref = runlessPullRef(verdict);
  if (!ref) {
    await skip('pr_context_unresolvable');
    return null;
  }
  const ownerRepo = `${ref.owner}/${ref.repo}`.toLowerCase();
  if (!hasRepoPolicyEntry(ownerRepo, repoPolicy)) {
    await skip('repo_not_allowed');
    return null;
  }
  let pr: PullRequestEvidence;
  try {
    pr = await options.github.findPullRequest({
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.prNumber,
      includeChangedFiles: true,
    });
  } catch (error) {
    log.warn(
      {
        err: error as Error,
        verdictId: verdict.id,
        runId: verdict.run_id,
        woId: verdict.wo_id,
        owner: ref.owner,
        repo: ref.repo,
        prNumber: ref.prNumber,
      },
      'merge-coordinator.pr_context_fetch_failed'
    );
    await skip('pr_context_unresolvable');
    return null;
  }
  if (!pr.exists || pr.pr?.number !== ref.prNumber) {
    await skip('pr_context_unresolvable', pr.htmlUrl);
    return null;
  }
  log.info(
    {
      verdictId: verdict.id,
      runId: verdict.run_id,
      woId: verdict.wo_id,
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.prNumber,
      state: pr.state,
      baseBranch: pr.baseBranch,
      headSha: pr.headSha,
      verdictHeadSha: verdict.head_sha,
      prUrl: pr.htmlUrl,
    },
    'merge-coordinator.pr_context_resolved_from_github'
  );
  if (pr.state !== 'open') {
    await skip('pr_not_open', pr.htmlUrl);
    return null;
  }
  if (pr.headSha !== verdict.head_sha) {
    await skip('head_moved', pr.htmlUrl);
    return null;
  }
  const basePolicy = getRepoBasePolicy(ownerRepo, pr.baseBranch ?? '', repoPolicy);
  if (!basePolicy?.unattended) {
    await skip('base_not_allowlisted', pr.htmlUrl);
    return null;
  }
  return { pr, basePolicy };
}

/**
 * Resolve the PR and allowlist entry a verdict points at. Run-backed verdicts
 * keep the run-row path unchanged; `run_context_unresolvable` stays reserved
 * for "a run id is referenced but the row (or its repo identity) is gone".
 * Everything after this -- slot reservation, claim/release, the expectedHeadSha
 * precondition, the rate ceiling, recordPostMutationOutcome -- is shared.
 */
async function resolveMergeTarget(
  options: MergeExecutionBridgeOptions,
  verdict: OverseerVerdictRow,
  repoPolicy: MergeRepoPolicy,
  skip: SkipVerdict
): Promise<MergeTarget | null> {
  if (isRunlessVerdict(verdict)) return resolveRunlessTarget(options, verdict, repoPolicy, skip);
  const run = await options.store.getRunById(verdict.run_id);
  if (!run?.owner || !run.repo) {
    await skip('run_context_unresolvable');
    return null;
  }
  const ownerRepo = `${run.owner}/${run.repo}`.toLowerCase();
  if (!hasRepoPolicyEntry(ownerRepo, repoPolicy)) {
    await skip('repo_not_allowed');
    return null;
  }
  const pr = await options.github.findPullRequest({
    owner: run.owner,
    repo: run.repo,
    headBranch: run.headBranch,
    woId: run.woId,
    includeChangedFiles: true,
  });
  return {
    pr,
    basePolicy: getRepoBasePolicy(ownerRepo, pr.baseBranch ?? '', repoPolicy),
  };
}

/**
 * The receipt body is a documented ASCII/no-at-sign artifact (see the test
 * `receipt body is ASCII and contains no at-sign`): it must never let a
 * dynamic field trigger a GitHub @mention or inject non-ASCII bytes. Branch
 * names and repo identities are attacker-influenced (a PR author picks their
 * own branch name), so every dynamic field is sanitized before interpolation:
 * '@' is replaced (GitHub mentions trigger on a bare '@handle', including
 * inside inline code spans -- backticks alone are not a safe boundary), and
 * any byte outside printable ASCII (0x20-0x7E) is stripped.
 */
function sanitizeReceiptField(value: string): string {
  return value
    .replace(/@/g, '(at)')
    .split('')
    .filter(ch => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code <= 0x7e;
    })
    .join('');
}

function receiptKey(verdict: OverseerVerdictRow): string {
  const keyField = (value: string): string =>
    sanitizeReceiptField(value).replace(/[^A-Za-z0-9._:-]/g, '_');
  return `${RECEIPT_KEY_PREFIX} verdict=${keyField(verdict.id)} head=${keyField(
    verdict.head_sha
  )} -->`;
}

async function postMergeReceiptComment(
  options: MergeExecutionBridgeOptions,
  verdict: OverseerVerdictRow,
  pr: PullRequestEvidence,
  input: { mergeSha?: string; baseBranch?: string; policyLabel?: string }
): Promise<void> {
  if (!options.github.commentOnPullRequest) {
    log.warn(
      { verdictId: verdict.id, prUrl: pr.htmlUrl },
      'merge-coordinator.receipt_comment_unavailable'
    );
    return;
  }
  if (!pr.pr) return;
  try {
    const expectedReceiptKey = receiptKey(verdict);
    const commentAuthorLogin = options.github.commentAuthorLogin?.trim().toLowerCase();
    if (options.github.listPullRequestComments && commentAuthorLogin) {
      const existing = await options.github.listPullRequestComments(pr.pr);
      if (
        existing.some(
          comment =>
            comment.authorLogin.trim().toLowerCase() === commentAuthorLogin &&
            comment.body.split(/\r?\n/).some(line => line.trim() === expectedReceiptKey)
        )
      ) {
        return;
      }
    }
    const mergeShort = sanitizeReceiptField((input.mergeSha ?? 'unknown').slice(0, 8));
    const baseBranch = sanitizeReceiptField(
      input.baseBranch && input.baseBranch.length > 0 ? input.baseBranch : 'unknown'
    );
    const policyLabel = sanitizeReceiptField(
      input.policyLabel && input.policyLabel.length > 0 ? input.policyLabel : 'unknown'
    );
    const body = [
      RECEIPT_MARKER,
      expectedReceiptKey,
      `Merged by the merge manager (unattended): Overseer verdict ${verdict.id.slice(0, 8)} APPROVED at head ${verdict.head_sha.slice(0, 8)}, checks green, base ${baseBranch}, policy ${policyLabel}. Merge commit ${mergeShort}.`,
    ].join('\n');
    await options.github.commentOnPullRequest({ ...pr.pr, body });
  } catch (error) {
    log.warn(
      { err: error as Error, verdictId: verdict.id, prUrl: pr.htmlUrl },
      'merge-coordinator.receipt_comment_failed'
    );
  }
}

async function mergeClaimedVerdict(
  options: MergeExecutionBridgeOptions,
  verdict: OverseerVerdictRow,
  repoPolicy: MergeRepoPolicy
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
    return undefined;
  }
  if (policy.emergency_stop) {
    await skip('emergency_stop');
    return undefined;
  }
  if (policy.legacy_dry_run) {
    await skip('legacy_dry_run');
    return undefined;
  }
  if (!policy.capability_flags.merge) {
    await skip('merge_actions_disabled');
    return undefined;
  }

  const target = await resolveMergeTarget(options, verdict, repoPolicy, skip);
  if (!target) return undefined;
  const { pr, basePolicy } = target;
  if (!pr.exists || !pr.pr) {
    await skip(pr.lookupFailed ? 'pr_lookup_failed' : 'open_pr_not_found', pr.htmlUrl);
    return undefined;
  }
  if (pr.headSha !== verdict.head_sha) {
    await skip('verdict_stale_head', pr.htmlUrl);
    return undefined;
  }
  if (pr.state !== 'open') {
    await skip('pr_not_open', pr.htmlUrl);
    return undefined;
  }
  if (pr.checks.total === 0 || pr.checks.failed > 0 || pr.checks.pending > 0) {
    await skip('required_checks_not_success', pr.htmlUrl);
    return undefined;
  }
  // Conflicts are a distinct operator-visible skip: a generic not-clean
  // reason hid DIRTY PRs inside the same bucket as blocked/unstable.
  if (pr.mergeableState === 'dirty') {
    await skip('not_mergeable_dirty', pr.htmlUrl);
    return undefined;
  }
  if (pr.mergeable !== true || pr.mergeableState !== 'clean') {
    await skip('mergeable_state_not_clean', pr.htmlUrl);
    return undefined;
  }
  if (!pr.changedFilePaths) {
    await skip('changed_files_unresolved', pr.htmlUrl);
    return undefined;
  }
  if (isDocumentationOnly(pr.changedFilePaths) && (basePolicy?.docsOnly ?? 'skip') === 'skip') {
    await skip('spec_only', pr.htmlUrl);
    return undefined;
  }
  if (!basePolicy?.unattended) {
    await skip('integration_base_mismatch', pr.htmlUrl);
    return undefined;
  }

  // Defer the merge while a Cauldron run for the SAME WO is still executing, so
  // the run is never failed by its own PR being merged underneath it
  // (bdc-harness #1046). The gate is purely on the wo_id SHAPE, not on whether
  // the verdict is run-backed: a PR-discovery verdict (run-less, run id
  // pr-discovery:...) can still carry a real WO id, and merging it mid-repair is
  // exactly the failure #1046 prevents -- so it must be deferred too. Run-less
  // pull-ref verdicts carry a gh:owner/repo#N wo_id that does not start with
  // WO-, so they still never call the helper. A deferral releases the claim and
  // returns undefined -- NOT 'stop' -- so later verdicts in the same pass still
  // process (only the rate ceiling stops the loop). The check fails safe: an
  // error defers rather than merges.
  if (
    options.store.hasActiveRunForWo &&
    typeof verdict.wo_id === 'string' &&
    verdict.wo_id.startsWith('WO-')
  ) {
    let activeRun: boolean;
    try {
      activeRun = await options.store.hasActiveRunForWo(verdict.wo_id);
    } catch (error) {
      await options.store.releaseVerdictClaim(verdict.id, 'active_run_check_failed');
      log.warn(
        {
          err: error as Error,
          verdictId: verdict.id,
          runId: verdict.run_id,
          woId: verdict.wo_id,
          prUrl: pr.htmlUrl,
        },
        'merge-coordinator.active_run_check_failed'
      );
      return undefined;
    }
    if (activeRun) {
      await options.store.releaseVerdictClaim(verdict.id, 'active_run_deferred');
      log.info(
        {
          verdictId: verdict.id,
          runId: verdict.run_id,
          woId: verdict.wo_id,
          prUrl: pr.htmlUrl,
        },
        'merge-coordinator.active_run_deferred'
      );
      return undefined;
    }
  }

  const isCeReleasePr =
    `${pr.pr.owner}/${pr.pr.repo}`.toLowerCase() === 'thinmansoftware/lspro-react' &&
    pr.baseBranch === 'release/ce';

  if (isCeReleasePr) {
    const recheck = await ceScopePremergeRecheck({
      owner: pr.pr.owner,
      repo: pr.pr.repo,
      prNumber: pr.pr.number,
      deps: options.ceScopeRecheckDeps ?? productionCeScopeRecheckDeps(),
    });
    if (!recheck.ok) {
      await skip(recheck.reason, pr.htmlUrl);
      return undefined;
    }
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
  // Fail-closed re-verify of the CE approval/gate immediately before merge.
  // The earlier recheck runs before merge-slot reservation and the async
  // approvePullRequest call; an operator could revoke approval in that window.
  // Re-running the recheck here closes that revocation race so a revoked
  // approval cannot slip through between the first recheck and the merge.
  if (isCeReleasePr) {
    const premergeRecheck = await ceScopePremergeRecheck({
      owner: pr.pr.owner,
      repo: pr.pr.repo,
      prNumber: pr.pr.number,
      deps: options.ceScopeRecheckDeps ?? productionCeScopeRecheckDeps(),
    });
    if (!premergeRecheck.ok) {
      await options.store.releaseMergeSlot(verdict.id);
      await skip(premergeRecheck.reason, pr.htmlUrl);
      return undefined;
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
    return undefined;
  }
  if (!merged.merged) {
    if (merged.message === 'github_merge_transport_ambiguous') {
      await recordPostMutationOutcome(options, verdict, {
        reason: 'github_merge_transport_ambiguous',
        mergeSha: merged.mergeSha ?? merged.sha,
        prUrl: pr.htmlUrl,
      });
      return undefined;
    }
    await options.store.releaseMergeSlot(verdict.id);
    await skip(merged.message ?? 'merge_failed', pr.htmlUrl);
    return undefined;
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
  const ownerRepo = pr.pr !== undefined ? `${pr.pr.owner}/${pr.pr.repo}` : 'unknown';
  await postMergeReceiptComment(options, verdict, pr, {
    mergeSha: merged.mergeSha ?? merged.sha,
    baseBranch: pr.baseBranch,
    policyLabel: `${ownerRepo}:${pr.baseBranch ?? 'unknown'}`,
  });
  return undefined;
}

export async function runMergeExecutionBridgeOnce(
  options: MergeExecutionBridgeOptions
): Promise<void> {
  const repoPolicy = configuredPolicy(options.repoConfig);
  const verdicts = await options.store.listUnactionedVerdicts();
  for (const verdict of verdicts) {
    if (verdict.proposed_action !== FLAG_MERGE_READY) continue;
    if (!(await options.store.claimVerdict(verdict.id))) continue;
    try {
      if ((await mergeClaimedVerdict(options, verdict, repoPolicy)) === 'stop') break;
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
