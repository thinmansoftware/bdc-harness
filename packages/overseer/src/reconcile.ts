const log: ReconcileLogger = {
  warn(fields, message) {
    console.warn('[overseer/reconcile]', message, fields);
  },
  info(fields, message) {
    console.info('[overseer/reconcile]', message, fields);
  },
};

export const RECONCILE_ACTION = 'reconcile_close';
export const WO_STEM_PATTERN = /\bWO-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{2}\b/g;
const DEFAULT_ORG = 'bluedevilcollectibles';
const DEFAULT_TRACKER_REPO = 'bdc-xo';
const DEFAULT_LOOKBACK_DAYS = 14;
const DONE_LABEL = 'wo:done';

export interface ReconcileMergedPullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body?: string | null;
  htmlUrl: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha?: string | null;
  mergedAt?: string | null;
}

export interface ReconcileTrackerIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
}

export interface ReconcileActionRecord {
  runId: string;
  woId: string;
  class: string;
  action: string;
  result: string;
}

export interface ReconcileLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  info?(fields: Record<string, unknown>, message: string): void;
}

export interface ReconcileDeps {
  readCursor?: () => Promise<string | null>;
  searchMergedPullRequests: (input: {
    org: string;
    since: string;
  }) => Promise<ReconcileMergedPullRequest[]>;
  findTrackerIssueByStem: (stem: string) => Promise<ReconcileTrackerIssue | null>;
  addTrackerEvidenceComment: (input: {
    issue: ReconcileTrackerIssue;
    body: string;
  }) => Promise<void>;
  addTrackerLabel: (input: { issue: ReconcileTrackerIssue; label: string }) => Promise<void>;
  closeTrackerIssue: (input: { issue: ReconcileTrackerIssue }) => Promise<void>;
  insertAction?: (record: ReconcileActionRecord) => Promise<unknown>;
  now?: () => Date;
  log?: ReconcileLogger;
}

interface OctokitLike {
  search: {
    issuesAndPullRequests(input: Record<string, unknown>): Promise<{
      data: {
        items: Array<{
          number: number;
          title: string;
          body?: string | null;
          state: string;
          pull_request?: unknown;
          repository_url?: string;
        }>;
      };
    }>;
  };
  pulls: {
    get(input: Record<string, unknown>): Promise<{
      data: {
        title?: string;
        body?: string | null;
        html_url: string;
        state: 'open' | 'closed';
        merged?: boolean;
        merge_commit_sha?: string | null;
        merged_at?: string | null;
      };
    }>;
  };
  issues: {
    createComment(input: Record<string, unknown>): Promise<unknown>;
    addLabels(input: Record<string, unknown>): Promise<unknown>;
    update(input: Record<string, unknown>): Promise<unknown>;
  };
}

export interface RunReconcileInput {
  org?: string;
  trackerRepo?: string;
  lookbackDays?: number;
  deps?: ReconcileDeps;
}

export interface ReconcileResult {
  scanned: number;
  closed: number;
  skipped: boolean;
}

export async function runReconcileOnce(input: RunReconcileInput = {}): Promise<ReconcileResult> {
  const deps = input.deps ?? createDefaultReconcileDeps();
  const logger = deps.log ?? log;
  const org = input.org ?? DEFAULT_ORG;
  const since = await resolveSearchSince(input, deps);

  let pullRequests: ReconcileMergedPullRequest[];
  try {
    pullRequests = await deps.searchMergedPullRequests({ org, since });
  } catch (error) {
    if (isRateLimitError(error)) {
      logger.warn({ err: error as Error, rateLimit: true }, 'overseer.reconcile.rate_limit_skip');
      return { scanned: 0, closed: 0, skipped: true };
    }
    throw error;
  }

  let closed = 0;
  const seen = new Set<string>();
  for (const pr of pullRequests) {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!pr.merged || pr.state !== 'closed') continue;
    const stems = extractWoStems(`${pr.title}\n${pr.body ?? ''}`);
    if (stems.length === 0) continue;

    for (const stem of stems) {
      const tracker = await deps.findTrackerIssueByStem(stem);
      if (!tracker) continue;
      if (tracker.state !== 'open') continue;

      await deps.addTrackerEvidenceComment({
        issue: tracker,
        body: buildEvidenceComment({ pr, stem }),
      });
      await deps.addTrackerLabel({ issue: tracker, label: DONE_LABEL });
      await deps.closeTrackerIssue({ issue: tracker });
      await (deps.insertAction ?? insertDefaultOverseerAction)({
        runId: `reconcile:${pr.owner}/${pr.repo}#${pr.number}`,
        woId: stem,
        class: 'tracker_reconcile',
        action: RECONCILE_ACTION,
        result: `${pr.htmlUrl}:${pr.mergeCommitSha ?? 'merge_sha_unknown'}`,
      });
      closed += 1;
    }
  }

  return { scanned: seen.size, closed, skipped: false };
}

export function extractWoStems(input: string): string[] {
  const matches = input.match(WO_STEM_PATTERN) ?? [];
  return [...new Set(matches)];
}

export function buildEvidenceComment(input: {
  pr: ReconcileMergedPullRequest;
  stem: string;
}): string {
  return [
    `Overseer reconcile closed tracker for ${input.stem}.`,
    '',
    `Merged PR: ${input.pr.htmlUrl}`,
    `Repository: ${input.pr.owner}/${input.pr.repo}`,
    `Merge SHA: ${input.pr.mergeCommitSha ?? 'unknown'}`,
  ].join('\n');
}

export async function readReconcileCursorFromActions(): Promise<string | null> {
  const { getDatabase } = await import('@archon/core/db/connection');
  const db = getDatabase();
  const sql =
    db.dialect === 'sqlite'
      ? 'SELECT MAX(created_at) AS cursor FROM overseer_actions WHERE action = $1'
      : 'SELECT MAX(created_at) AS cursor FROM overseer_actions WHERE action = $1';
  const result = await db.query<{ cursor: string | null }>(sql, [RECONCILE_ACTION]);
  return result.rows[0]?.cursor ?? null;
}

async function insertDefaultOverseerAction(record: ReconcileActionRecord): Promise<unknown> {
  const { insertOverseerAction } = await import('@archon/core/db/overseer');
  return insertOverseerAction(record);
}

export function createDefaultReconcileDeps(): ReconcileDeps {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    return {
      readCursor: async () => null,
      searchMergedPullRequests: async () => {
        log.warn({ rateLimit: false }, 'overseer.reconcile.github_token_missing');
        return [];
      },
      findTrackerIssueByStem: async () => null,
      addTrackerEvidenceComment: async () => undefined,
      addTrackerLabel: async () => undefined,
      closeTrackerIssue: async () => undefined,
      insertAction: insertDefaultOverseerAction,
      log,
    };
  }

  let octokit: Promise<OctokitLike> | null = null;
  const getOctokit = async (): Promise<OctokitLike> => {
    octokit ??= import('@octokit/rest').then(
      module => new module.Octokit({ auth: token }) as unknown as OctokitLike
    );
    return octokit;
  };
  return {
    readCursor: readReconcileCursorFromActions,
    searchMergedPullRequests: async input => searchMergedPullRequests(await getOctokit(), input),
    findTrackerIssueByStem: async stem => findTrackerIssueByStem(await getOctokit(), stem),
    addTrackerEvidenceComment: async input => {
      const client = await getOctokit();
      await client.issues.createComment({
        owner: input.issue.owner,
        repo: input.issue.repo,
        issue_number: input.issue.number,
        body: input.body,
      });
    },
    addTrackerLabel: async input => {
      const client = await getOctokit();
      await client.issues.addLabels({
        owner: input.issue.owner,
        repo: input.issue.repo,
        issue_number: input.issue.number,
        labels: [input.label],
      });
    },
    closeTrackerIssue: async input => {
      const client = await getOctokit();
      await client.issues.update({
        owner: input.issue.owner,
        repo: input.issue.repo,
        issue_number: input.issue.number,
        state: 'closed',
        state_reason: 'completed',
      });
    },
    insertAction: insertDefaultOverseerAction,
    log,
  };
}

async function resolveSearchSince(input: RunReconcileInput, deps: ReconcileDeps): Promise<string> {
  const cursor = await (deps.readCursor ?? readReconcileCursorFromActions)();
  if (cursor) return cursor.slice(0, 10);

  const now = deps.now?.() ?? new Date();
  const lookbackDays = input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  return since.toISOString().slice(0, 10);
}

async function searchMergedPullRequests(
  octokit: OctokitLike,
  input: { org: string; since: string }
): Promise<ReconcileMergedPullRequest[]> {
  const queries = [
    `org:${input.org} is:pr is:merged merged:>=${input.since} WO- in:title`,
    `org:${input.org} is:pr is:merged merged:>=${input.since} WO- in:body`,
  ];
  const results = new Map<string, ReconcileMergedPullRequest>();

  for (const q of queries) {
    const search = await octokit.search.issuesAndPullRequests({
      q,
      per_page: 100,
      sort: 'updated',
      order: 'desc',
    });
    for (const item of search.data.items) {
      if (!item.pull_request) continue;
      const repo = parseRepositoryFromUrl(item.repository_url);
      if (!repo) continue;
      const pr = await octokit.pulls.get({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: item.number,
      });
      results.set(`${repo.owner}/${repo.repo}#${item.number}`, {
        owner: repo.owner,
        repo: repo.repo,
        number: item.number,
        title: pr.data.title ?? item.title,
        body: pr.data.body ?? item.body,
        htmlUrl: pr.data.html_url,
        state: pr.data.state,
        merged: Boolean(pr.data.merged),
        mergeCommitSha: pr.data.merge_commit_sha,
        mergedAt: pr.data.merged_at,
      });
    }
  }

  return [...results.values()];
}

async function findTrackerIssueByStem(
  octokit: OctokitLike,
  stem: string
): Promise<ReconcileTrackerIssue | null> {
  const search = await octokit.search.issuesAndPullRequests({
    q: `repo:${DEFAULT_ORG}/${DEFAULT_TRACKER_REPO} is:issue ${stem} in:title`,
    per_page: 10,
  });
  const exact = search.data.items.find(item => item.title === stem && !item.pull_request);
  if (!exact) return null;
  return {
    owner: DEFAULT_ORG,
    repo: DEFAULT_TRACKER_REPO,
    number: exact.number,
    title: exact.title,
    state: exact.state === 'open' ? 'open' : 'closed',
  };
}

function parseRepositoryFromUrl(url?: string): { owner: string; repo: string } | null {
  const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(url ?? '');
  if (!match) return null;
  return { owner: match[1] ?? '', repo: match[2] ?? '' };
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: number;
    message?: string;
    response?: { headers?: unknown };
  };
  if (candidate.status === 403 || candidate.status === 429) {
    const message = candidate.message ?? '';
    if (/rate.limit|rateLimit|rate limit|secondary rate/i.test(message)) return true;
  }
  return false;
}
