/**
 * Automatic rework of a Cauldron pull request after Overseer CHANGES_REQUESTED.
 *
 * Production bases, human-built PRs, and check-caused verdicts are never
 * touched. A skip on those paths has no comment and no escalation.
 */
import { createLogger } from '@archon/paths';
import {
  createAuthenticatedMessage,
  listMessages,
  type DispatchMessage,
} from '@archon/core/db/dispatch';
import {
  findOriginatingRunForPullRequest,
  type OriginatingPullRequestRun,
} from '@archon/core/db/workflow-events';
import { createRealOctokitClient } from './adapters/github-real-deps';
import { getRepoBasePolicy } from './merge-repo-policy';
import { verdictAuthorizesRecheck } from './pr-review-check-ingest';
import { resolveMaxRereviewAttempts } from './pr-review-ingest';
import type { ReviewWorkItem, SubmitOutcome } from './pr-review-submit';

const log = createLogger('overseer/pr-rework');

export const REWORK_RECIPIENT = 'overseer-rework';
export const REWORK_ENABLED_ENV = 'OVERSEER_REWORK_ENABLED';
export const REWORK_REPOS_ENV = 'OVERSEER_REWORK_REPOS';
export const REWORK_MAX_ATTEMPTS_ENV = 'OVERSEER_REWORK_MAX_ATTEMPTS';
export const DEFAULT_REWORK_REPOS = 'thinmansoftware/bdc-harness';
export const DEFAULT_REWORK_MAX_ATTEMPTS = 2;
const OPT_OUT_LABEL = 'no-auto-rework';
const BRANCH_PATTERN = /^(feat|fix|wip)\/[A-Za-z0-9_-]+$/;
const WO_PROJECT_PATTERN = /WO_ID=(WO-[A-Z0-9-]+) --project ([A-Za-z0-9_.-]+)/;

export type ReworkAction = 'enqueued' | 'skipped' | 'escalated';

export interface ReworkAssessment {
  action: ReworkAction;
  reason: string;
}

export interface ReworkPullRequest {
  state: string;
  draft: boolean;
  baseRef: string;
  headSha: string;
  headRef: string;
  headRepoFullName: string;
  labels: string[];
}

export interface ReworkEnqueueBody {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  branch: string;
  baseRef: string;
  woId: string;
  project: string;
  originatingRunId: string;
  reviewMessageId: string;
}

export interface ReworkDeps {
  env?: Record<string, string | undefined>;
  getPullRequest(input: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<ReworkPullRequest>;
  findOriginatingRun(prUrl: string): Promise<OriginatingPullRequestRun | null>;
  listMessages: typeof listMessages;
  createAuthenticatedMessage: typeof createAuthenticatedMessage;
  listComments(input: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<Array<{ body: string }>>;
  createComment(input: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<void>;
}

export function reworkSubjectKey(owner: string, repo: string, prNumber: number): string {
  return `gh:${owner}/${repo}#${prNumber}`;
}

export function reworkPullRequestUrl(owner: string, repo: string, prNumber: number): string {
  return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
}

export function reworkCommentMarker(reason: string, headSha: string): string {
  return `<!-- overseer-rework:${reason}:${headSha} -->`;
}

export function resolveReworkEnabled(env: Record<string, string | undefined>): boolean {
  return env[REWORK_ENABLED_ENV]?.trim().toLowerCase() !== 'false';
}

export function resolveReworkRepos(env: Record<string, string | undefined>): Set<string> {
  const raw = env[REWORK_REPOS_ENV] ?? DEFAULT_REWORK_REPOS;
  return new Set(
    raw
      .split(',')
      .map(entry => entry.trim().toLowerCase())
      .filter(entry => entry.length > 0)
  );
}

export function resolveReworkMaxAttempts(env: Record<string, string | undefined>): number {
  const parsed = Number(env[REWORK_MAX_ATTEMPTS_ENV]);
  const configured =
    Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_REWORK_MAX_ATTEMPTS;
  return Math.min(configured, resolveMaxRereviewAttempts(env));
}

function skipped(reason: string): ReworkAssessment {
  return { action: 'skipped', reason };
}

function eligibilityDetail(pr: ReworkPullRequest, headSha: string): string | null {
  if (pr.state !== 'open') return 'not_open';
  if (pr.draft) return 'draft';
  if (pr.labels.some(label => label.toLowerCase() === OPT_OUT_LABEL)) return 'opt_out';
  if (pr.headSha !== headSha) return 'head_moved';
  return null;
}

function sameRepoHead(pr: ReworkPullRequest, owner: string, repo: string): boolean {
  return pr.headRepoFullName.trim().toLowerCase() === `${owner}/${repo}`.toLowerCase();
}

export async function assessAndEnqueueRework(
  input: { work: ReviewWorkItem; outcome: SubmitOutcome },
  deps: ReworkDeps
): Promise<ReworkAssessment> {
  const { work, outcome } = input;
  const summary = outcome.summary?.trim() ?? '';
  if (outcome.disposition !== 'changes_requested' || summary.length === 0) {
    return skipped('not_changes_requested');
  }
  if (verdictAuthorizesRecheck({ disposition: outcome.disposition, summary: outcome.summary })) {
    return skipped('check_caused_verdict');
  }

  const env = deps.env ?? process.env;
  const ownerRepo = `${work.owner}/${work.repo}`;
  if (!resolveReworkEnabled(env) || !resolveReworkRepos(env).has(ownerRepo.toLowerCase())) {
    return skipped('repo_not_enabled');
  }

  const pr = await deps.getPullRequest({
    owner: work.owner,
    repo: work.repo,
    prNumber: work.prNumber,
  });
  if (!sameRepoHead(pr, work.owner, work.repo)) {
    return skipped('pr_not_eligible:fork');
  }
  const detail = eligibilityDetail(pr, work.headSha);
  if (detail) return skipped(`pr_not_eligible:${detail}`);

  const basePolicy = getRepoBasePolicy(ownerRepo, pr.baseRef);
  if (!basePolicy || basePolicy.unattended !== true) {
    return skipped('production_or_unlisted_base');
  }

  const originating = await deps.findOriginatingRun(
    reworkPullRequestUrl(work.owner, work.repo, work.prNumber)
  );
  if (!originating) return skipped('not_cauldron_built');

  const parsed = WO_PROJECT_PATTERN.exec(originating.userMessage);
  const woId = parsed?.[1];
  const project = parsed?.[2];
  if (!woId || !project) {
    return escalate(deps, {
      work,
      branch: pr.headRef,
      woId: woId ?? '',
      reason: 'originating_run_unparseable',
      findings: summary,
    });
  }
  if (!BRANCH_PATTERN.test(pr.headRef)) {
    return escalate(deps, {
      work,
      branch: pr.headRef,
      woId,
      reason: 'branch_pattern_unsupported',
      findings: summary,
    });
  }

  const subjectKey = reworkSubjectKey(work.owner, work.repo, work.prNumber);
  const prior = await deps.listMessages({
    recipient: REWORK_RECIPIENT,
    subject_key: subjectKey,
  });
  const attempts = prior.filter(message => message.task_type === 'run_rework').length;
  if (attempts >= resolveReworkMaxAttempts(env)) {
    return escalate(deps, {
      work,
      branch: pr.headRef,
      woId,
      reason: 'rework_cap_exhausted',
      findings: summary,
    });
  }

  const body: ReworkEnqueueBody = {
    owner: work.owner,
    repo: work.repo,
    prNumber: work.prNumber,
    headSha: work.headSha,
    branch: pr.headRef,
    baseRef: pr.baseRef,
    woId,
    project,
    originatingRunId: originating.runId,
    reviewMessageId: work.messageId,
  };
  await deps.createAuthenticatedMessage(
    { kind: 'system', sender: 'overseer' },
    {
      task_type: 'run_rework',
      recipient: REWORK_RECIPIENT,
      subject_key: subjectKey,
      correlation_id: work.correlationId,
      idempotency_key: `overseer-rework:${ownerRepo}#${work.prNumber}@${work.headSha}`,
      repeat_reason: `overseer_rework:changes_requested:${work.headSha} review ${work.messageId}`,
      priority: 'normal',
      body: JSON.stringify(body),
    }
  );
  return { action: 'enqueued', reason: 'changes_requested' };
}

export async function escalateRework(
  deps: Pick<ReworkDeps, 'listComments' | 'createComment' | 'createAuthenticatedMessage'>,
  input: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    branch: string;
    woId: string;
    reason: string;
    findings: string;
    correlationId: string;
  }
): Promise<ReworkAssessment> {
  const marker = reworkCommentMarker(input.reason, input.headSha);
  try {
    const comments = await deps.listComments({
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
    });
    if (!comments.some(comment => comment.body.includes(marker))) {
      await deps.createComment({
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        body: [
          marker,
          `Overseer rework escalated (${input.reason}) for PR #${input.prNumber} branch ${input.branch}.`,
          input.woId ? `WO: ${input.woId}` : 'WO: unknown',
          'Findings:',
          input.findings,
        ].join('\n'),
      });
    }
  } catch (error) {
    log.error(
      { err: error, prNumber: input.prNumber, reason: input.reason },
      'overseer_rework_escalation_comment_failed'
    );
  }

  const subjectKey = reworkSubjectKey(input.owner, input.repo, input.prNumber);
  await deps.createAuthenticatedMessage(
    { kind: 'system', sender: 'overseer' },
    {
      task_type: 'agent_message',
      recipient: 'operator',
      priority: 'blocker',
      subject_key: subjectKey,
      correlation_id: input.correlationId,
      idempotency_key: `overseer-rework-escalation:${input.owner}/${input.repo}#${input.prNumber}@${input.headSha}:${input.reason}`,
      repeat_reason: `overseer_rework_escalation:${input.reason}:${input.headSha}`,
      body: [
        `PR: ${input.owner}/${input.repo}#${input.prNumber}`,
        `Branch: ${input.branch}`,
        `WO: ${input.woId || 'unknown'}`,
        `Reason: ${input.reason}`,
        'Findings:',
        input.findings,
      ].join('\n'),
    }
  );
  return { action: 'escalated', reason: input.reason };
}

async function escalate(
  deps: ReworkDeps,
  input: {
    work: ReviewWorkItem;
    branch: string;
    woId: string;
    reason: string;
    findings: string;
  }
): Promise<ReworkAssessment> {
  return escalateRework(deps, {
    owner: input.work.owner,
    repo: input.work.repo,
    prNumber: input.work.prNumber,
    headSha: input.work.headSha,
    branch: input.branch,
    woId: input.woId,
    reason: input.reason,
    findings: input.findings,
    correlationId: input.work.correlationId,
  });
}

interface OctokitPull {
  state?: string;
  draft?: boolean;
  base?: { ref?: string };
  head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
  labels?: Array<{ name?: string }>;
}

export function createRealReworkDeps(): ReworkDeps {
  return {
    async getPullRequest(input): Promise<ReworkPullRequest> {
      const octokit = createRealOctokitClient();
      const response = await octokit.pulls.get({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.prNumber,
      });
      const data = response.data as OctokitPull;
      return {
        state: data.state ?? 'closed',
        draft: data.draft === true,
        baseRef: data.base?.ref ?? '',
        headSha: data.head?.sha ?? '',
        headRef: data.head?.ref ?? '',
        headRepoFullName: data.head?.repo?.full_name ?? '',
        labels: (data.labels ?? []).map(label => label.name ?? '').filter(Boolean),
      };
    },
    findOriginatingRun: findOriginatingRunForPullRequest,
    listMessages,
    createAuthenticatedMessage,
    async listComments(input): Promise<Array<{ body: string }>> {
      const octokit = createRealOctokitClient();
      const comments: Array<{ body: string }> = [];
      const issues = octokit.issues;
      if (!issues?.listComments) return comments;
      for (let page = 1; page <= 10; page += 1) {
        const response = await issues.listComments({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.prNumber,
          per_page: 100,
          page,
        });
        const pageComments = response.data as Array<{ body?: string | null }>;
        for (const comment of pageComments) comments.push({ body: comment.body ?? '' });
        if (pageComments.length < 100) break;
      }
      return comments;
    },
    async createComment(input): Promise<void> {
      const octokit = createRealOctokitClient();
      await octokit.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.prNumber,
        body: input.body,
      });
    },
  };
}

export function parseReworkBody(body: string): ReworkEnqueueBody | null {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object') return null;
    const row = value as Partial<ReworkEnqueueBody>;
    if (
      typeof row.owner !== 'string' ||
      typeof row.repo !== 'string' ||
      typeof row.prNumber !== 'number' ||
      typeof row.headSha !== 'string' ||
      typeof row.branch !== 'string' ||
      typeof row.baseRef !== 'string' ||
      typeof row.woId !== 'string' ||
      typeof row.project !== 'string' ||
      typeof row.originatingRunId !== 'string' ||
      typeof row.reviewMessageId !== 'string'
    ) {
      return null;
    }
    return row as ReworkEnqueueBody;
  } catch {
    return null;
  }
}

export type { DispatchMessage };
