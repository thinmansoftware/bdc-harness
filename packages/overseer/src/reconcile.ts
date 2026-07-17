import { createLogger } from '@archon/paths';
import { getDatabase } from '@archon/core/db/connection';
import { insertOverseerAction } from '@archon/core/db/overseer';
import { Octokit } from '@octokit/rest';

const log = createLogger('overseer/reconcile');

const DEFAULT_ORG = 'bluedevilcollectibles';
const TRACKER_OWNER = 'bluedevilcollectibles';
const TRACKER_REPO = 'bdc-xo';
const DONE_LABEL = 'wo:done';
const RECONCILE_ACTION = 'reconcile_close';
const DEFAULT_LOOKBACK_DAYS = 7;
const WO_STEM_RE = /\bWO-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{2}\b/g;

export interface ReconcileMergedPullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  mergeCommitSha: string;
  mergedAt: string;
}

export interface ReconcileTrackerIssue {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | string;
  htmlUrl?: string;
}

export interface ReconcileDeps {
  searchMergedPullRequests(since: string): Promise<ReconcileMergedPullRequest[]>;
  getTrackerIssue(stem: string): Promise<ReconcileTrackerIssue | null>;
  postEvidenceComment(issueNumber: number, body: string): Promise<void>;
  addDoneLabel(issueNumber: number): Promise<void>;
  closeTrackerIssue(issueNumber: number): Promise<void>;
  getLastReconcileClosedAt(): Promise<string | null>;
  resolveRunId(stem: string): Promise<string | null>;
  recordReconcileClose(input: {
    runId: string;
    stem: string;
    repo: string;
    prUrl: string;
    mergeSha: string;
  }): Promise<void>;
}

export interface ReconcileDutyOptions {
  now?: Date;
}

export class ReconcileRateLimitError extends Error {
  constructor(message = 'github_search_rate_limited') {
    super(message);
    this.name = 'ReconcileRateLimitError';
  }
}

export function extractWoStems(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.match(WO_STEM_RE) ?? [])];
}

export async function runReconcileDuty(
  deps: ReconcileDeps = createDefaultReconcileDeps(),
  options: ReconcileDutyOptions = {}
): Promise<void> {
  const since = await reconcileSearchLowerBound(deps, options.now ?? new Date());
  let pullRequests: ReconcileMergedPullRequest[];
  try {
    pullRequests = await deps.searchMergedPullRequests(since);
  } catch (error) {
    if (isRateLimitError(error)) {
      log.warn({ since }, 'reconcile.rate_limited_cycle_skipped');
      return;
    }
    throw error;
  }

  for (const pr of pullRequests) {
    const stems = [...new Set([...extractWoStems(pr.title), ...extractWoStems(pr.body)])];
    if (stems.length === 0) continue;

    for (const stem of stems) {
      const tracker = await deps.getTrackerIssue(stem);
      if (!tracker) {
        log.info({ stem, prUrl: pr.htmlUrl }, 'reconcile.tracker_not_found');
        continue;
      }
      if (tracker.state.toUpperCase() === 'CLOSED') {
        log.info({ stem, issueNumber: tracker.number }, 'reconcile.tracker_already_closed');
        continue;
      }

      const repo = `${pr.owner}/${pr.repo}`;
      await deps.postEvidenceComment(
        tracker.number,
        buildEvidenceComment({
          stem,
          repo,
          prUrl: pr.htmlUrl,
          mergeSha: pr.mergeCommitSha,
        })
      );
      await deps.addDoneLabel(tracker.number);
      await deps.closeTrackerIssue(tracker.number);

      const runId = await deps.resolveRunId(stem);
      if (runId) {
        await deps.recordReconcileClose({
          runId,
          stem,
          repo,
          prUrl: pr.htmlUrl,
          mergeSha: pr.mergeCommitSha,
        });
      } else {
        // Some manual or salvaged PRs have no harness run row, so the FK-backed
        // overseer_actions insert cannot be made. GitHub issue state remains the
        // idempotency source for these safe tracker-only reconciliations.
        log.warn({ stem, repo, prUrl: pr.htmlUrl }, 'reconcile.action_unrecorded_no_run_match');
      }
    }
  }
}

function buildEvidenceComment(input: {
  stem: string;
  repo: string;
  prUrl: string;
  mergeSha: string;
}): string {
  return [
    `Reconciled ${input.stem}: merged PR found.`,
    '',
    `PR: ${input.prUrl}`,
    `Repository: ${input.repo}`,
    `Merge SHA: ${input.mergeSha}`,
  ].join('\n');
}

async function reconcileSearchLowerBound(deps: ReconcileDeps, now: Date): Promise<string> {
  const lastClosedAt = await deps.getLastReconcileClosedAt();
  if (lastClosedAt) return dateOnly(lastClosedAt);

  const lookback = new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  // The cursor is derived from prior overseer_actions rows instead of a new table.
  // On first run we bound GitHub Search cost with a fixed lookback window.
  return dateOnly(lookback.toISOString());
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function createDefaultReconcileDeps(): ReconcileDeps {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error('reconcile_github_token_missing');
  }
  const octokit = new Octokit({ auth: token });
  const org = process.env.GITHUB_ORG ?? process.env.GH_ORG ?? DEFAULT_ORG;

  return {
    searchMergedPullRequests: since => searchMergedPullRequests(octokit, org, since),
    getTrackerIssue: stem => getTrackerIssue(octokit, stem),
    postEvidenceComment: async (issueNumber, body) => {
      await octokit.rest.issues.createComment({
        owner: TRACKER_OWNER,
        repo: TRACKER_REPO,
        issue_number: issueNumber,
        body,
      });
    },
    addDoneLabel: async issueNumber => {
      await octokit.rest.issues.addLabels({
        owner: TRACKER_OWNER,
        repo: TRACKER_REPO,
        issue_number: issueNumber,
        labels: [DONE_LABEL],
      });
    },
    closeTrackerIssue: async issueNumber => {
      await octokit.rest.issues.update({
        owner: TRACKER_OWNER,
        repo: TRACKER_REPO,
        issue_number: issueNumber,
        state: 'closed',
        state_reason: 'completed',
      });
    },
    getLastReconcileClosedAt: async () => {
      const result = await getDatabase().query<{ created_at: string }>(
        `SELECT MAX(created_at) AS created_at
         FROM overseer_actions
         WHERE action = $1`,
        [RECONCILE_ACTION]
      );
      return result.rows[0]?.created_at ?? null;
    },
    resolveRunId: async stem => {
      const result = await getDatabase().query<{ id: string }>(
        `SELECT id
         FROM remote_agent_workflow_runs
         WHERE metadata::text ILIKE $1 OR user_message ILIKE $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [`%${stem}%`]
      );
      return result.rows[0]?.id ?? null;
    },
    recordReconcileClose: async input => {
      await insertOverseerAction({
        runId: input.runId,
        woId: input.stem,
        class: 'tracker_reconcile',
        action: RECONCILE_ACTION,
        result: `${input.repo}:${input.prUrl}:${input.mergeSha}`,
      });
    },
  };
}

async function searchMergedPullRequests(
  octokit: Octokit,
  org: string,
  since: string
): Promise<ReconcileMergedPullRequest[]> {
  const query = `org:${org} is:pr is:merged merged:>=${since} WO in:title,body`;
  const search = await octokit.rest.search.issuesAndPullRequests({
    q: query,
    per_page: 100,
  });

  const prs: ReconcileMergedPullRequest[] = [];
  for (const item of search.data.items) {
    const ref = parsePullRequestApiUrl(item.pull_request?.url);
    if (!ref) continue;
    const pr = await octokit.rest.pulls.get(ref);
    if (!pr.data.merged || !pr.data.merge_commit_sha) continue;
    prs.push({
      owner: ref.owner,
      repo: ref.repo,
      number: ref.pull_number,
      title: pr.data.title,
      body: pr.data.body ?? null,
      htmlUrl: pr.data.html_url,
      mergeCommitSha: pr.data.merge_commit_sha,
      mergedAt: pr.data.merged_at ?? '',
    });
  }
  return prs;
}

async function getTrackerIssue(
  octokit: Octokit,
  stem: string
): Promise<ReconcileTrackerIssue | null> {
  const search = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${TRACKER_OWNER}/${TRACKER_REPO} is:issue ${stem} in:title`,
    per_page: 10,
  });
  const match = search.data.items.find(item => item.title.includes(stem));
  if (!match) return null;
  return {
    number: match.number,
    title: match.title,
    state: match.state.toUpperCase(),
    htmlUrl: match.html_url,
  };
}

function parsePullRequestApiUrl(
  url: string | null | undefined
): { owner: string; repo: string; pull_number: number } | null {
  if (!url) return null;
  const match = url.match(/\/repos\/([^/]+)\/([^/]+)\/pulls\/([0-9]+)$/);
  if (!match) return null;
  return {
    owner: match[1]!,
    repo: match[2]!,
    pull_number: Number(match[3]),
  };
}

function isRateLimitError(error: unknown): boolean {
  if (error instanceof ReconcileRateLimitError) return true;
  const candidate = error as {
    status?: number;
    message?: string;
    response?: { headers?: Record<string, string | number | undefined> };
  };
  const remaining = candidate.response?.headers?.['x-ratelimit-remaining'];
  const rateLimitRemaining = remaining === 0 || remaining === '0';
  const message = candidate.message?.toLowerCase() ?? '';
  return (
    (candidate.status === 403 && rateLimitRemaining) ||
    message.includes('rate limit') ||
    message.includes('secondary rate limit')
  );
}
