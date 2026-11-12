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
import {
  OWNER_REWORKING_LABEL,
  PR_DISCOVERY_RUN_ID_PREFIX,
  RUN_BLOCKED_LABEL,
} from './merge-candidate-discovery';
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
import { specDeclaresMergeHold } from './merge-hold';
import type { MergedSibling } from './sibling-wo-id';
import { isSpecOnlyChangeSet } from './reconcile';
import type {
  GitHubClientDeps,
  OverseerWorkflowEvent,
  PullRequestEvidence,
  ReviewConflictAtHead,
} from './types.ts';
import {
  originatingEvidenceFailure,
  evidenceAdjudicated,
  postEvidenceHold,
  runlessOriginatingEvidenceHold,
  ORIGINATING_RUN_FAILED_EVIDENCE_HOLD_REASON,
  ORIGINATING_RUN_IN_PROGRESS_HOLD_REASON,
  ORIGINATING_RUN_UNREADABLE_HOLD_REASON,
} from './merge-manager';
import type { OriginatingRun, OriginatingRunLookupInput } from './originating-run-lookup';
import { resolveRequiredContexts } from './adapters/required-contexts';
import { createRealOctokitClient } from './adapters/github-real-deps';
import { blockingRequiredContexts } from './required-context-gate';
import { classifyMergeSkip, isRateLimitSkip } from './merge-skip-classification';
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
const DEFAULT_MERGE_RETRY_BASE_MINUTES = 10;
const DEFAULT_MERGE_RETRY_MAX_DELAY_MINUTES = 240;
const DEFAULT_MERGE_RETRY_MAX_ATTEMPTS = 8;
const FLAG_MERGE_READY = 'flag_merge_ready';
const RECEIPT_MARKER = '<!-- merge-manager-receipt -->';
const RECEIPT_KEY_PREFIX = '<!-- merge-manager-receipt-key';
const POLICY_SKIP_MARKER = '<!-- merge-policy-skip:v1 -->';
const POLICY_SKIP_KEY_PREFIX = '<!-- merge-policy-skip-key';
export type MergeExecutionRepoConfig = Readonly<Record<string, { readonly baseBranch: string }>>;

export interface MergeExecutionBridgeStore {
  listUnactionedVerdicts(): Promise<OverseerVerdictRow[]>;
  claimVerdict(verdictId: string): Promise<boolean>;
  releaseVerdictClaim(verdictId: string, reason: string): Promise<boolean>;
  deferVerdictClaim?(verdictId: string, reason: string, notBefore: string): Promise<boolean>;
  getRunById(runId: string): Promise<OverseerWatchRun | null>;
  // Optional so older/test stores that predate the active-run guard keep prior
  // behavior (bdc-harness #1046): when absent, no run-in-flight deferral runs.
  hasActiveRunForWo?(woId: string): Promise<boolean>;
  reserveMergeSlot(verdictId: string, since: string, limit: number): Promise<boolean>;
  getEarliestMergeSlotReservation(since: string): Promise<string | null>;
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
  readRunEvents?: (runId: string) => Promise<OverseerWorkflowEvent[]>;
  /**
   * Trace a run-less verdict's PR to the run that opened it (bdc-harness 5308).
   * Absent keeps the run-less path unchanged; a rejection holds as unreadable.
   */
  findOriginatingRun?: (input: OriginatingRunLookupInput) => Promise<OriginatingRun | null>;
  store: MergeExecutionBridgeStore;
  github: GitHubClientDeps;
  /** Optional logger seam for the skip line (tests); defaults to the module logger. */
  logger?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  readPolicy?: () => OverseerActionPolicy;
  now?: () => Date;
  maxMergesPerHour?: number;
  retryBaseMinutes?: number;
  retryMaxDelayMinutes?: number;
  retryMaxAttempts?: number;
  repoConfig?: MergeExecutionRepoConfig;
  ceScopeRecheckDeps?: CeScopeRecheckDeps;
  /** Receipt-backed exact-head review qualification. */
  hasQualifiedReview?(input: {
    owner: string;
    repo: string;
    number: number;
    headSha: string;
  }): Promise<boolean>;
  /**
   * Exact-head review conflict: a review of the same head requested changes, or
   * one is still running. Checked last before the merge; absent fails closed.
   */
  reviewConflictAtHead?(input: {
    owner: string;
    repo: string;
    number: number;
    headSha: string;
  }): Promise<ReviewConflictAtHead | null>;
  // Absent in tests that predate the spec hold. When omitted, no spec is read.
  readWoSpec?(woId: string): Promise<string>;
  /**
   * Another pull request of the same work order, in the same repository, already merged after this
   * one was created (WO-HARNESS-SIBLING-WO-PR-HOLD-AFTER-MERGE-01). Absent keeps the bridge unchanged.
   * A rejection never blocks a merge: it is logged and the pull request follows the normal path.
   */
  findMergedSibling?(input: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<MergedSibling | null>;
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
  const raw = process.env.OVERSEER_MAX_MERGES_PER_HOUR ?? '';
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_MERGES_PER_HOUR;
}

function configuredNonNegativeInteger(
  override: number | undefined,
  envName: string,
  fallback: number
): number {
  const raw = process.env[envName] ?? '';
  const value = override ?? (/^\d+$/.test(raw) ? Number(raw) : Number.NaN);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
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

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const status = (error as { status: unknown }).status;
  return typeof status === 'number' ? status : undefined;
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

type SkipVerdict = (
  reason: string,
  prUrl?: string,
  rateLimited?: boolean,
  details?: Record<string, unknown>
) => Promise<void>;

interface MergeTarget {
  pr: PullRequestEvidence;
  basePolicy?: RepoBasePolicy;
  run?: OverseerWatchRun;
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
    await skip('repo_not_allowed', undefined, false, {
      ...repoNotInPolicyDetails(ref.owner, ref.repo),
      prNumber: ref.prNumber,
    });
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
    await skip(
      'pr_context_fetch_failed',
      undefined,
      isRateLimitSkip(error instanceof Error ? error.message : '')
    );
    return null;
  }
  if (pr.lookupFailed) {
    await skip('pr_context_fetch_failed', pr.htmlUrl);
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
    await postPolicySkipComment(options, verdict, pr, 'base_not_allowlisted');
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
    await skip('repo_not_allowed', undefined, false, repoNotInPolicyDetails(run.owner, run.repo));
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
    run,
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

/**
 * WO-HARNESS-MERGE-POLICY-SKIP-VISIBLE-01: a pull request the bridge skips by
 * POLICY (terminal: spec_only, integration_base_mismatch, base_not_allowlisted)
 * used to sit unmerged with no sign on it of why -- bdc-harness #1371 waited
 * 11 days APPROVED and green while the Duty Officer nudged the merge manager
 * about a skip that was deliberate. The skip stays a skip; this posts ONE
 * comment saying why the manager will not merge it and that a person does.
 * Idempotent on a key line (verdict id + reason), same pattern as the merge
 * receipt. Never throws: a comment failure is logged and the skip outcome
 * already recorded is unchanged. repo_not_allowed has no pull request in hand
 * and posts nothing.
 */
export type PolicySkipReason = 'spec_only' | 'integration_base_mismatch' | 'base_not_allowlisted';

function policySkipSentence(reason: PolicySkipReason, baseBranch: string): string {
  const tail =
    'a person merges it when ready (exact-head approval and green required checks still apply).';
  switch (reason) {
    case 'spec_only':
      return `The merge manager does not merge documentation-only pull requests into ${baseBranch} by policy, so it skipped this one on purpose; ${tail}`;
    case 'integration_base_mismatch':
      return `${baseBranch} is not a base the merge manager merges unattended, so it skipped this pull request on purpose; ${tail}`;
    case 'base_not_allowlisted':
      return `${baseBranch} is not on the merge manager's allowlist for this repository, so it skipped this pull request on purpose; ${tail}`;
  }
}

function policySkipKey(verdict: OverseerVerdictRow, reason: PolicySkipReason): string {
  const keyField = (value: string): string =>
    sanitizeReceiptField(value).replace(/[^A-Za-z0-9._:-]/g, '_');
  return `${POLICY_SKIP_KEY_PREFIX}:${keyField(verdict.id)}:${keyField(reason)} -->`;
}

export async function postPolicySkipComment(
  options: MergeExecutionBridgeOptions,
  verdict: OverseerVerdictRow,
  pr: PullRequestEvidence,
  reason: PolicySkipReason
): Promise<void> {
  if (!options.github.commentOnPullRequest) {
    log.warn(
      { verdictId: verdict.id, prUrl: pr.htmlUrl, reason },
      'merge-coordinator.policy_skip_comment_unavailable'
    );
    return;
  }
  if (!pr.pr) return;
  try {
    const expectedKey = policySkipKey(verdict, reason);
    const commentAuthorLogin = options.github.commentAuthorLogin?.trim().toLowerCase();
    if (options.github.listPullRequestComments && commentAuthorLogin) {
      const existing = await options.github.listPullRequestComments(pr.pr);
      if (
        existing.some(
          comment =>
            comment.authorLogin.trim().toLowerCase() === commentAuthorLogin &&
            comment.body.split(/\r?\n/).some(line => line.trim() === expectedKey)
        )
      ) {
        return;
      }
    }
    const baseBranch = sanitizeReceiptField(
      pr.baseBranch && pr.baseBranch.length > 0 ? pr.baseBranch : 'its base'
    );
    const body = [POLICY_SKIP_MARKER, expectedKey, policySkipSentence(reason, baseBranch)].join(
      '\n'
    );
    await options.github.commentOnPullRequest({ ...pr.pr, body });
  } catch (error) {
    log.warn(
      { err: error as Error, verdictId: verdict.id, prUrl: pr.htmlUrl, reason },
      'merge-coordinator.policy_skip_comment_failed'
    );
  }
}

const CEILING_QUEUE_MARKER = '<!-- overseer:merge-ceiling-queued -->';

/**
 * Label a pull request carries while it waits for a merge slot (the hourly ceiling). It is a signal
 * only: nothing in the merge path reads it as a hold. Added once at the first deferral, removed when
 * the bridge merges the PR (a PR merged by hand keeps it, which is cosmetic).
 */
export const MERGE_QUEUED_LABEL = 'merge-queued';

function reportedChecksAreBlocking(checks: PullRequestEvidence['checks']): boolean {
  return checks.total === 0 || checks.failed > 0 || checks.pending > 0;
}

/**
 * Approval memo (bdc-xo#5358): the bridge posts at most one approving review per exact head SHA per
 * ten minutes. In-process and bounded; a restart or a new head posts again, which is correct.
 */
const APPROVAL_MEMO_TTL_MS = 10 * 60 * 1000;
const APPROVAL_MEMO_MAX = 512;
// One memo per GitHub client object: the service reuses its client across passes, a test builds its own.
const approvalMemos = new WeakMap<object, Map<string, number>>();

function approvalMemoFor(github: object): Map<string, number> {
  let memo = approvalMemos.get(github);
  if (!memo) {
    memo = new Map<string, number>();
    approvalMemos.set(github, memo);
  }
  return memo;
}

function approvalRecentlyPosted(github: object, key: string, nowMs: number): boolean {
  const at = approvalMemoFor(github).get(key);
  return at !== undefined && nowMs - at < APPROVAL_MEMO_TTL_MS;
}

function noteApprovalPosted(github: object, key: string, nowMs: number): void {
  const memo = approvalMemoFor(github);
  if (memo.size >= APPROVAL_MEMO_MAX) {
    for (const [k, at] of memo) {
      if (nowMs - at >= APPROVAL_MEMO_TTL_MS) memo.delete(k);
    }
    while (memo.size >= APPROVAL_MEMO_MAX) {
      const oldest = memo.keys().next().value;
      if (oldest === undefined) break;
      memo.delete(oldest);
    }
  }
  memo.set(key, nowMs);
}

/** A green PR waiting for the ceiling must not look stuck: label it once (never an extra call per pass). */
async function markMergeQueued(
  options: MergeExecutionBridgeOptions,
  verdict: OverseerVerdictRow,
  pr: PullRequestEvidence
): Promise<void> {
  if (!pr.pr || !options.github.addPullRequestLabels) return;
  if (pr.labels?.includes(MERGE_QUEUED_LABEL)) return;
  try {
    await options.github.addPullRequestLabels({ ...pr.pr, labels: [MERGE_QUEUED_LABEL] });
  } catch (error) {
    log.warn(
      { err: error as Error, verdictId: verdict.id, prUrl: pr.htmlUrl },
      'merge-coordinator.queued_label_failed'
    );
  }
}

async function postCeilingQueueNotice(
  options: MergeExecutionBridgeOptions,
  verdict: OverseerVerdictRow,
  pr: PullRequestEvidence,
  since: string,
  queuePosition: number,
  ceiling: number
): Promise<boolean> {
  try {
    if (!pr.pr || !options.github.listPullRequestComments || !options.github.commentOnPullRequest) {
      throw new Error('queue_notice_comment_api_unavailable');
    }
    const reservedAt = await options.store.getEarliestMergeSlotReservation(since);
    const reservedMs = reservedAt === null ? Number.NaN : Date.parse(reservedAt);
    if (!Number.isFinite(reservedMs) || reservedMs <= Date.parse(since)) {
      throw new Error('queue_notice_reservation_unavailable');
    }
    const nextSlot = new Date(reservedMs + 60 * 60 * 1000).toISOString();
    const headLine = `Head: \`${verdict.head_sha}\``;
    const comments = await options.github.listPullRequestComments(pr.pr);
    if (
      comments.some(
        comment =>
          comment.body.includes(CEILING_QUEUE_MARKER) &&
          comment.body.split(/\r?\n/).some(line => line.trim() === headLine)
      )
    )
      return true;
    await options.github.commentOnPullRequest({
      ...pr.pr,
      body: [
        CEILING_QUEUE_MARKER,
        headLine,
        `Queued for merge: position ${queuePosition}, hourly ceiling ${ceiling}. Earliest next merge slot: ${nextSlot}.`,
      ].join('\n'),
    });
    return true;
  } catch (error) {
    log.warn(
      { err: error as Error, verdictId: verdict.id, prUrl: pr.htmlUrl },
      'merge-coordinator.ceiling_queue_notice_failed'
    );
    return false;
  }
}

/**
 * WO-HARNESS-MERGE-POLICY-PROVISIONER-AND-REPO-SKIP-LINE-01 (bdc-xo#5581): a skip because the repository
 * has no policy entry used to be an info line with only the run id (no repository or number field, no
 * hint) and posts no comment, so nobody saw why a pull request was not merged. The skip line for
 * `repo_not_allowed` is now a WARN carrying the repository, the pull request number when known, the
 * variable to read and one hint, once per verdict id per process (replays of the same verdict stay info).
 */
const REPO_NOT_ALLOWED_WARN_MAX = 2000;
const warnedRepoNotAllowed = new Set<string>();

function repoNotInPolicyDetails(owner: string, repo: string): Record<string, unknown> {
  return {
    owner,
    repo,
    env: 'MERGE_MANAGER_REPO_POLICY',
    hint: 'add_repo_to_merge_policy',
  };
}

async function mergeClaimedVerdict(
  options: MergeExecutionBridgeOptions,
  verdict: OverseerVerdictRow,
  repoPolicy: MergeRepoPolicy,
  queuePosition: number
): Promise<'stop' | undefined> {
  let rateLimitDeferred = false;
  const skip = async (
    reason: string,
    prUrl?: string,
    rateLimited = false,
    details?: Record<string, unknown>
  ): Promise<void> => {
    if (
      reason === ORIGINATING_RUN_FAILED_EVIDENCE_HOLD_REASON ||
      reason === ORIGINATING_RUN_IN_PROGRESS_HOLD_REASON ||
      reason === ORIGINATING_RUN_UNREADABLE_HOLD_REASON
    ) {
      // Evidence holds must remain eligible for repair/adjudication on the next tick.
      // recordOutcome finalizes a verdict; transient retries consume a bounded budget.
      await options.store.releaseVerdictClaim(verdict.id, reason);
      log.info(
        { verdictId: verdict.id, runId: verdict.run_id, woId: verdict.wo_id, reason, prUrl },
        'merge-coordinator.originating_evidence_held'
      );
      return;
    }
    if (classifyMergeSkip(reason) === 'transient' && options.store.deferVerdictClaim) {
      const retryMaxAttempts = configuredNonNegativeInteger(
        options.retryMaxAttempts,
        'OVERSEER_MERGE_RETRY_MAX_ATTEMPTS',
        DEFAULT_MERGE_RETRY_MAX_ATTEMPTS
      );
      const attempts = verdict.merge_attempts ?? 0;
      if (attempts + 1 < retryMaxAttempts) {
        const baseMinutes = configuredNonNegativeInteger(
          options.retryBaseMinutes,
          'OVERSEER_MERGE_RETRY_BASE_MINUTES',
          DEFAULT_MERGE_RETRY_BASE_MINUTES
        );
        const maxDelayMinutes = configuredNonNegativeInteger(
          options.retryMaxDelayMinutes,
          'OVERSEER_MERGE_RETRY_MAX_DELAY_MINUTES',
          DEFAULT_MERGE_RETRY_MAX_DELAY_MINUTES
        );
        const delayMinutes = Math.min(baseMinutes * 2 ** attempts, maxDelayMinutes);
        const now = (options.now ?? ((): Date => new Date()))();
        const notBefore = new Date(now.getTime() + delayMinutes * 60 * 1000).toISOString();
        const deferred = await options.store.deferVerdictClaim(verdict.id, reason, notBefore);
        if (deferred) {
          rateLimitDeferred = rateLimited || isRateLimitSkip(reason);
          log.info(
            {
              verdictId: verdict.id,
              runId: verdict.run_id,
              woId: verdict.wo_id,
              ...(details ?? {}),
              reason,
              prUrl,
              notBefore,
              mergeAttempts: attempts + 1,
            },
            'merge-coordinator.merge_deferred'
          );
        }
        return;
      }
      reason = `transient_exhausted:${reason}`;
    }
    await options.store.recordOutcome({
      verdictId: verdict.id,
      mutationSent: false,
      reason,
      prUrl,
    });
    const skipFields = {
      verdictId: verdict.id,
      runId: verdict.run_id,
      woId: verdict.wo_id,
      ...(details ?? {}),
      reason,
      prUrl,
    };
    if (
      (reason === 'repo_not_allowed' || reason === 'sibling_pr_already_merged') &&
      !warnedRepoNotAllowed.has(verdict.id)
    ) {
      if (warnedRepoNotAllowed.size >= REPO_NOT_ALLOWED_WARN_MAX) warnedRepoNotAllowed.clear();
      warnedRepoNotAllowed.add(verdict.id);
      (options.logger ?? log).warn(skipFields, 'merge-coordinator.merge_skipped');
    } else {
      (options.logger ?? log).info(skipFields, 'merge-coordinator.merge_skipped');
    }
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
  if (!target) return rateLimitDeferred ? 'stop' : undefined;
  const { pr, basePolicy } = target;
  if (!pr.exists || !pr.pr) {
    await skip(pr.lookupFailed ? 'pr_lookup_failed' : 'open_pr_not_found', pr.htmlUrl);
    return undefined;
  }
  if (pr.headSha !== verdict.head_sha) {
    await skip('verdict_stale_head', pr.htmlUrl);
    return undefined;
  }
  if (
    !options.hasQualifiedReview ||
    !(await options.hasQualifiedReview({
      owner: pr.pr.owner,
      repo: pr.pr.repo,
      number: pr.pr.number,
      headSha: verdict.head_sha,
    }))
  ) {
    await skip('review_execution_unqualified', pr.htmlUrl);
    return undefined;
  }
  if (pr.state !== 'open') {
    await skip('pr_not_open', pr.htmlUrl);
    return undefined;
  }
  // Known required contexts are the only checks that can block. Unknown and
  // exhausted lookups keep the aggregate summary, and an authoritative empty
  // set does too, without the fallback log.
  const lookups = options.github.requiredContextsLookups;
  let requiredContextsPassed = false;
  const resolution = await resolveRequiredContexts(
    {
      ...(lookups ?? {}),
      owner: pr.pr.owner,
      repo: pr.pr.repo,
      baseRef: pr.baseBranch,
      headSha: verdict.head_sha,
    },
    lookups ? process.env : {}
  );
  if (resolution.state === 'known' && resolution.contexts.length > 0) {
    const blockingContexts = blockingRequiredContexts(
      resolution.contexts,
      pr.checkRuns ?? [],
      pr.commitStatuses ?? []
    );
    if (blockingContexts.length > 0) {
      await skip('required_checks_not_success', pr.htmlUrl, false, { blockingContexts });
      return undefined;
    }
    requiredContextsPassed = true;
  } else {
    if (resolution.state !== 'known') {
      log.info(
        {
          verdictId: verdict.id,
          runId: verdict.run_id,
          woId: verdict.wo_id,
          prUrl: pr.htmlUrl,
          state: resolution.state,
          reason: resolution.reason,
        },
        'merge-coordinator.required_contexts_fallback'
      );
    }
    if (reportedChecksAreBlocking(pr.checks)) {
      await skip('required_checks_not_success', pr.htmlUrl);
      return undefined;
    }
  }
  // Conflicts are a distinct operator-visible skip: a generic not-clean
  // reason hid DIRTY PRs inside the same bucket as blocked/unstable.
  if (pr.mergeableState === 'dirty') {
    await skip('not_mergeable_dirty', pr.htmlUrl);
    return undefined;
  }
  // GitHub reports `unstable` when only non-required checks failed or are
  // pending. Once every known required context passed, that state is
  // mergeable; without a known required set, keep requiring `clean`.
  const mergeableStateAccepted =
    pr.mergeableState === 'clean' || (requiredContextsPassed && pr.mergeableState === 'unstable');
  if (pr.mergeable !== true || !mergeableStateAccepted) {
    await skip('mergeable_state_not_clean', pr.htmlUrl);
    return undefined;
  }
  if (!pr.changedFilePaths) {
    await skip('changed_files_unresolved', pr.htmlUrl);
    return undefined;
  }
  if (isDocumentationOnly(pr.changedFilePaths) && (basePolicy?.docsOnly ?? 'skip') === 'skip') {
    await skip('spec_only', pr.htmlUrl);
    await postPolicySkipComment(options, verdict, pr, 'spec_only');
    return undefined;
  }
  if (!basePolicy?.unattended) {
    await skip('integration_base_mismatch', pr.htmlUrl);
    await postPolicySkipComment(options, verdict, pr, 'integration_base_mismatch');
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

  // Holds release the claim and return. They are not skip() or deferVerdictClaim:
  // an extended hold must not set actioned_at, increment attempts, or exhaust
  // the transient retry cap. The next tick re-evaluates after the claim is free.
  if (pr.labels?.includes('merge-hold')) {
    await options.store.releaseVerdictClaim(verdict.id, 'merge_hold_label');
    log.info(
      {
        verdictId: verdict.id,
        runId: verdict.run_id,
        woId: verdict.wo_id,
        prUrl: pr.htmlUrl,
      },
      'merge-coordinator.merge_hold_label'
    );
    return undefined;
  }

  // A PR opened from a non-PROCEED run is labelled run:blocked by the lane's patch-pr-body
  // node and is not lane-verified. This is the SHARED execution guard: the originating-run
  // path (watch.ts emits merge_ready for a green PR regardless of run status) and the
  // discovery path both reach it, so the label is enforced here as well as at discovery.
  // Like a hold it releases the claim without skip(), attempts or an outcome row; removing
  // the label (a human decision) frees the PR on the next tick.
  if (pr.labels?.includes(RUN_BLOCKED_LABEL)) {
    await options.store.releaseVerdictClaim(verdict.id, 'run_blocked_label');
    log.info(
      {
        verdictId: verdict.id,
        runId: verdict.run_id,
        woId: verdict.wo_id,
        prUrl: pr.htmlUrl,
      },
      'merge-coordinator.run_blocked_label'
    );
    return undefined;
  }

  // The owner marks a PR owner:reworking while the design is being redone. Like a hold it
  // releases the claim without skip(), attempts or an outcome row, so the next tick
  // re-evaluates after the owner clears the label. It is NOT HOLD (John's); nothing here sets
  // or clears it.
  if (pr.labels?.includes(OWNER_REWORKING_LABEL)) {
    await options.store.releaseVerdictClaim(verdict.id, 'owner_reworking_label');
    log.info(
      {
        verdictId: verdict.id,
        runId: verdict.run_id,
        woId: verdict.wo_id,
        prUrl: pr.htmlUrl,
      },
      'merge-coordinator.owner_reworking_label'
    );
    return undefined;
  }

  if (options.readWoSpec && typeof verdict.wo_id === 'string' && verdict.wo_id.startsWith('WO-')) {
    try {
      const specText = await options.readWoSpec(verdict.wo_id);
      if (specDeclaresMergeHold(specText)) {
        await options.store.releaseVerdictClaim(verdict.id, 'merge_hold');
        log.info(
          {
            verdictId: verdict.id,
            runId: verdict.run_id,
            woId: verdict.wo_id,
            prUrl: pr.htmlUrl,
          },
          'merge-coordinator.merge_hold'
        );
        return undefined;
      }
    } catch (error) {
      // 404 means the spec file is absent, which is not a hold.
      if (errorStatus(error) !== 404) {
        await options.store.releaseVerdictClaim(verdict.id, 'merge_hold_unverified');
        log.warn(
          {
            err: error as Error,
            verdictId: verdict.id,
            runId: verdict.run_id,
            woId: verdict.wo_id,
            prUrl: pr.htmlUrl,
          },
          'merge-coordinator.merge_hold_unverified'
        );
        return undefined;
      }
    }
  }

  // A second implementation of an already-merged work order must never land on top of the first
  // (provisioner PR 103 after PR 102, 2026-11-12). The reconcile pass closes such siblings; this is
  // the safety net for the window before it runs. Fails open: a failed lookup blocks nothing.
  if (options.findMergedSibling) {
    let sibling: MergedSibling | null = null;
    try {
      sibling = await options.findMergedSibling({
        owner: pr.pr.owner,
        repo: pr.pr.repo,
        number: pr.pr.number,
      });
    } catch (error) {
      (options.logger ?? log).warn(
        { err: error as Error, verdictId: verdict.id, prUrl: pr.htmlUrl },
        'merge-coordinator.sibling_lookup_failed'
      );
    }
    if (sibling) {
      await skip('sibling_pr_already_merged', pr.htmlUrl, false, {
        owner: pr.pr.owner,
        repo: pr.pr.repo,
        prNumber: pr.pr.number,
        mergedPrNumber: sibling.number,
        mergedPrUrl: sibling.url,
        siblingWoId: sibling.woId,
      });
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

  // Evidence holds run FIRST: before the merge slot is reserved and before any approval is posted
  // (bdc-xo#5358). A held pull request used to reserve a slot, post a fresh empty APPROVED review and
  // only then find the hold, once per pass (27 approvals in 15 minutes on one held PR). Now a held
  // verdict takes no slot and posts no approval; the next pass re-evaluates it for free of writes.
  if (isRunlessVerdict(verdict) && options.findOriginatingRun) {
    const traced = await runlessOriginatingEvidenceHold(
      {
        owner: pr.pr.owner,
        repo: pr.pr.repo,
        number: pr.pr.number,
        headRef: pr.pr.headRef,
      },
      options.findOriginatingRun,
      options.readRunEvents
    );
    if (
      traced &&
      !(
        traced.failure.reason === ORIGINATING_RUN_FAILED_EVIDENCE_HOLD_REASON &&
        (await evidenceAdjudicated(options.github, { ...pr.pr, headSha: verdict.head_sha }))
      )
    ) {
      await postEvidenceHold(
        options.github,
        traced.runId,
        { ...pr.pr, headSha: verdict.head_sha },
        traced.failure,
        'execute',
        true
      );
      await skip(traced.failure.reason, pr.htmlUrl);
      return undefined;
    }
  }
  if (!isRunlessVerdict(verdict)) {
    const failure = await originatingEvidenceFailure(
      { runId: verdict.run_id, status: target.run?.status ?? '' },
      target.run?.id === verdict.run_id ? options.readRunEvents : undefined
    );
    if (
      failure &&
      !(
        failure.reason === ORIGINATING_RUN_FAILED_EVIDENCE_HOLD_REASON &&
        (await evidenceAdjudicated(options.github, { ...pr.pr, headSha: verdict.head_sha }))
      )
    ) {
      await postEvidenceHold(
        options.github,
        verdict.run_id,
        { ...pr.pr, headSha: verdict.head_sha },
        failure,
        'execute',
        true
      );
      await skip(failure.reason, pr.htmlUrl);
      return undefined;
    }
  }
  const now = (options.now ?? ((): Date => new Date()))();
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const ceiling = configuredLimit(options.maxMergesPerHour);
  if (!(await options.store.reserveMergeSlot(verdict.id, since, ceiling))) {
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
    const notified = await postCeilingQueueNotice(
      options,
      verdict,
      pr,
      since,
      queuePosition,
      ceiling
    );
    await markMergeQueued(options, verdict, pr);
    return notified ? 'stop' : undefined;
  }

  if (options.github.approvePullRequest) {
    // At most one approval per exact head per APPROVAL_MEMO_TTL_MS: a pass that returns before the merge
    // (review in flight, changes requested, merge failure) must not post another approval on the next pass.
    const approvalKey = `${pr.pr.owner}/${pr.pr.repo}#${String(pr.pr.number)}@${verdict.head_sha}`;
    if (!approvalRecentlyPosted(options.github, approvalKey, now.getTime())) {
      try {
        await options.github.approvePullRequest({
          ...pr.pr,
          expectedHeadSha: verdict.head_sha,
        });
        noteApprovalPosted(options.github, approvalKey, now.getTime());
      } catch (error) {
        log.warn(
          { err: error as Error, verdictId: verdict.id },
          'merge-coordinator.approval_failed_nonfatal'
        );
      }
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
  // One approval is not enough when the same head has other reviews: every
  // check event queues its own recheck, and on 2026-11-03 #1453 merged on the
  // first APPROVED while three reviews of that head were still running; all
  // three then requested changes. Checked last, right before the merge.
  let conflict: ReviewConflictAtHead | 'check_unavailable' | null = 'check_unavailable';
  if (options.reviewConflictAtHead) {
    try {
      conflict = await options.reviewConflictAtHead({
        owner: pr.pr.owner,
        repo: pr.pr.repo,
        number: pr.pr.number,
        headSha: verdict.head_sha,
      });
    } catch {
      conflict = 'lookup_failed';
    }
  }
  if (conflict) {
    log.warn(
      { verdictId: verdict.id, woId: verdict.wo_id, prUrl: pr.htmlUrl, conflict },
      'merge-coordinator.merge_refused_conflicting_reviews'
    );
    await options.store.releaseMergeSlot(verdict.id);
    await skip(`review_conflict_at_head:${conflict}`, pr.htmlUrl);
    return undefined;
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
    return rateLimitDeferred ? 'stop' : undefined;
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
    return rateLimitDeferred ? 'stop' : undefined;
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
  if (pr.pr && pr.labels?.includes(MERGE_QUEUED_LABEL) && options.github.removePullRequestLabel) {
    try {
      await options.github.removePullRequestLabel({ ...pr.pr, label: MERGE_QUEUED_LABEL });
    } catch (error) {
      log.warn(
        { err: error as Error, verdictId: verdict.id, prUrl: pr.htmlUrl },
        'merge-coordinator.queued_label_remove_failed'
      );
    }
  }
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
  let queuePosition = 0;
  for (const verdict of verdicts) {
    if (verdict.proposed_action !== FLAG_MERGE_READY) continue;
    queuePosition += 1;
    if (!(await options.store.claimVerdict(verdict.id))) continue;
    try {
      if ((await mergeClaimedVerdict(options, verdict, repoPolicy, queuePosition)) === 'stop')
        break;
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

/**
 * The repo/base merge policy that merge execution itself applies: the current
 * MERGE_MANAGER_REPO_POLICY, else the deprecated OVERSEER_MERGE_REPO_CONFIG
 * (fail-closed parse), else the legacy/default resolution. Exported so
 * read-only verifiers (`archon project verify`) judge branches against the
 * exact effective policy instead of a second, drifting resolution.
 */
export function resolveExecutionMergeRepoPolicy(): MergeRepoPolicy {
  return configuredPolicy();
}
