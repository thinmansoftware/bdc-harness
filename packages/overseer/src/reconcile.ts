const log: ReconcileLogger = {
  warn(fields, message) {
    console.warn('[overseer/reconcile]', message, fields);
  },
  info(fields, message) {
    console.info('[overseer/reconcile]', message, fields);
  },
};

export const RECONCILE_ACTION = 'reconcile_close';
export const RECONCILE_SKIP_ACTION = 'reconcile_skip_noted';
export const WO_STEM_PATTERN = /\bWO-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{2}\b/g;
export const RECONCILE_SKIP_PATTERN = /^Reconcile-Skip: (WO-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{2})$/gm;
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
  prRef: string;
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
  hasSkipBeenNoted?: (input: { prRef: string; woId: string }) => Promise<boolean>;
  insertAction?: (record: ReconcileActionRecord) => Promise<unknown>;
  /**
   * Changed-file paths for a merged PR. Used to refuse closing a tracker on a
   * SPEC-ONLY merge (see isSpecOnlyChangeSet). Optional: when absent, reconcile
   * falls back to prior behavior rather than blocking, so a deps object that
   * predates this guard still works.
   */
  listPullRequestFiles?: (pr: ReconcileMergedPullRequest) => Promise<string[]>;
  now?: () => Date;
  log?: ReconcileLogger;
}

interface OctokitLike {
  search: {
    issuesAndPullRequests(input: Record<string, unknown>): Promise<{
      data: {
        items: {
          number: number;
          title: string;
          body?: string | null;
          state: string;
          pull_request?: unknown;
          repository_url?: string;
        }[];
      };
    }>;
  };
  pulls: {
    listFiles(input: Record<string, unknown>): Promise<{
      data: { filename: string }[];
    }>;
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
    if (isAuthError(error)) {
      logger.warn({ err: error as Error, authError: true }, 'overseer.reconcile.auth_error_skip');
      return { scanned: 0, closed: 0, skipped: true };
    }
    logger.warn({ err: error as Error }, 'overseer.reconcile.transport_error_skip');
    return { scanned: 0, closed: 0, skipped: true };
  }

  let closed = 0;
  const seen = new Set<string>();
  for (const pr of pullRequests) {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!pr.merged || pr.state !== 'closed') continue;
    const stems = extractWoStems(`${pr.title}\n${pr.body ?? ''}`);
    const skipStems = extractReconcileSkipStems(pr.body ?? '');
    if (stems.length === 0) continue;

    for (const stem of stems) {
      let tracker: ReconcileTrackerIssue | null;
      try {
        tracker = await deps.findTrackerIssueByStem(stem);
      } catch (error) {
        if (isRateLimitError(error)) {
          logger.warn(
            { err: error as Error, rateLimit: true, stem },
            'overseer.reconcile.rate_limit_skip'
          );
          return { scanned: seen.size, closed, skipped: true };
        }
        if (isAuthError(error)) {
          logger.warn(
            { err: error as Error, authError: true, stem },
            'overseer.reconcile.auth_error_skip'
          );
          return { scanned: seen.size, closed, skipped: true };
        }
        throw error;
      }
      if (!tracker) continue;
      if (tracker.state !== 'open') continue;

      const prRef = `${pr.owner}/${pr.repo}#${pr.number}`;
      if (skipStems.has(stem)) {
        const alreadyNoted = await (deps.hasSkipBeenNoted ?? hasDefaultSkipBeenNoted)({
          prRef,
          woId: stem,
        });
        if (alreadyNoted) continue;

        await deps.addTrackerEvidenceComment({
          issue: tracker,
          body: buildEvidenceComment({ pr, stem, intentionallyLeftOpen: true }),
        });
        await (deps.insertAction ?? insertDefaultOverseerAction)({
          prRef,
          woId: stem,
          class: 'tracker_reconcile',
          action: RECONCILE_SKIP_ACTION,
          result: `${pr.htmlUrl}:${pr.mergeCommitSha ?? 'merge_sha_unknown'}`,
        });
        continue;
      }

      // SPEC-ONLY GUARD. author-wo.sh lands the WO spec document via its own PR,
      // which mentions the WO stem -- so without this, a WO is closed as done by
      // the very PR that CREATED it. See isSpecOnlyChangeSet for the anchor.
      const listFiles = deps.listPullRequestFiles;
      if (listFiles) {
        let changedPaths: string[] | null = null;
        try {
          changedPaths = await listFiles(pr);
        } catch (error) {
          // Fail OPEN on a file-listing error: leave the tracker alone rather
          // than closing on unverified evidence. A tracker left open is visible
          // and fixable; one falsely closed is invisible.
          logger.warn(
            { err: error as Error, prRef, stem },
            'overseer.reconcile.file_list_failed_leaving_tracker_open'
          );
          continue;
        }
        if (isSpecOnlyChangeSet(changedPaths)) {
          // warn, not info: `info` is optional on ReconcileLogger while `warn` is
          // guaranteed, and a spec-only merge that LOOKS like completion is worth
          // surfacing rather than burying at info level.
          logger.warn(
            { prRef, stem, changedPaths },
            'overseer.reconcile.spec_only_merge_tracker_left_open'
          );
          // Silent by design. Reconcile re-scans a lookback window, so commenting
          // here would re-post on every pass for the life of the window. The log
          // line above is the record; the tracker simply stays open, which is the
          // correct and visible outcome.
          continue;
        }
      }

      await deps.addTrackerEvidenceComment({
        issue: tracker,
        body: buildEvidenceComment({ pr, stem }),
      });
      await deps.addTrackerLabel({ issue: tracker, label: DONE_LABEL });
      await deps.closeTrackerIssue({ issue: tracker });
      await (deps.insertAction ?? insertDefaultOverseerAction)({
        prRef,
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

/**
 * True when a merged PR contains ONLY the WO spec document (and adjacent
 * governance paperwork) -- no implementation.
 *
 * Why this exists: `author-wo.sh` lands `docs/work-orders/<WO-ID>.md` on bdc-xo
 * main via its own PR. That PR mentions the WO stem, so reconcile matched it and
 * closed the tracker as `wo:done` -- while zero code had been written.
 *
 * Anchor (2026-07-25): four WOs authored in one session were all closed within
 * minutes by their own spec PRs. For WO-XO-CRM-MINIMUM-COMPLETE-JOURNEY-01 the
 * target repository `bdc-crm` did not exist at all -- `gh repo view` returned
 * "Could not resolve to a Repository" -- so the WO could not possibly have been
 * done. Prior anchors: bdc-xo #1128, #1149.
 *
 * Deliberately conservative: it only returns true when EVERY changed path is
 * paperwork. One source file anywhere in the PR means this is a real build and
 * reconcile proceeds as before. False negatives (a real build we fail to
 * recognise as spec-only) are harmless; false positives would re-open the hole.
 */
export function isSpecOnlyChangeSet(paths: readonly string[]): boolean {
  if (paths.length === 0) return false; // no information -- do not assume spec-only
  return paths.every(
    path =>
      path.startsWith('docs/work-orders/') ||
      path.startsWith('docs/board/motions/') ||
      path.startsWith('docs/superpowers/specs/')
  );
}

export function extractWoStems(input: string): string[] {
  const matches = input.match(WO_STEM_PATTERN) ?? [];
  return [...new Set(matches)];
}

export function extractReconcileSkipStems(input: string): Set<string> {
  const stems = new Set<string>();
  for (const match of input.matchAll(RECONCILE_SKIP_PATTERN)) {
    const stem = match[1];
    if (stem) stems.add(stem);
  }
  return stems;
}

export function buildEvidenceComment(input: {
  pr: ReconcileMergedPullRequest;
  stem: string;
  intentionallyLeftOpen?: boolean;
}): string {
  const lines = [
    `Overseer reconcile closed tracker for ${input.stem}.`,
    '',
    `Merged PR: ${input.pr.htmlUrl}`,
    `Repository: ${input.pr.owner}/${input.pr.repo}`,
    `Merge SHA: ${input.pr.mergeCommitSha ?? 'unknown'}`,
  ];
  if (input.intentionallyLeftOpen) {
    lines[0] = `Overseer reconcile noted merged PR evidence for ${input.stem}.`;
    lines.push(
      '',
      `Tracker intentionally left open because this PR includes Reconcile-Skip: ${input.stem}.`
    );
  }
  return lines.join('\n');
}

export async function readReconcileCursorFromActions(): Promise<string | null> {
  const { getDatabase } = await import('@archon/core/db/connection');
  const db = getDatabase();
  const result = await db.query<{ cursor: string | null }>(
    'SELECT MAX(created_at) AS cursor FROM overseer_reconcile_actions WHERE action = $1',
    [RECONCILE_ACTION]
  );
  return result.rows[0]?.cursor ?? null;
}

async function insertDefaultOverseerAction(record: ReconcileActionRecord): Promise<unknown> {
  const { insertReconcileAction } = await import('@archon/core/db/overseer');
  return insertReconcileAction(record);
}

async function hasDefaultSkipBeenNoted(input: { prRef: string; woId: string }): Promise<boolean> {
  const { hasReconcileActionForPr } = await import('@archon/core/db/overseer');
  return hasReconcileActionForPr({
    prRef: input.prRef,
    woId: input.woId,
    action: RECONCILE_SKIP_ACTION,
  });
}

export function createDefaultReconcileDeps(): ReconcileDeps {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    return {
      readCursor: async () => null,
      searchMergedPullRequests: async (): Promise<ReconcileMergedPullRequest[]> => {
        log.warn({ rateLimit: false }, 'overseer.reconcile.github_token_missing');
        return [];
      },
      findTrackerIssueByStem: async () => null,
      addTrackerEvidenceComment: async () => undefined,
      addTrackerLabel: async () => undefined,
      closeTrackerIssue: async () => undefined,
      hasSkipBeenNoted: async () => false,
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
    listPullRequestFiles: async (pr): Promise<string[]> => {
      const client = await getOctokit();
      // per_page 100: a spec-only PR is 1-2 files, so the first page is always
      // enough to prove NOT-spec-only. A large PR truncated at 100 still contains
      // a source file, so isSpecOnlyChangeSet correctly returns false.
      const res = await client.pulls.listFiles({
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.number,
        per_page: 100,
      });
      return res.data.map(f => f.filename);
    },
    addTrackerEvidenceComment: async (input): Promise<void> => {
      const client = await getOctokit();
      await client.issues.createComment({
        owner: input.issue.owner,
        repo: input.issue.repo,
        issue_number: input.issue.number,
        body: input.body,
      });
    },
    addTrackerLabel: async (input): Promise<void> => {
      const client = await getOctokit();
      await client.issues.addLabels({
        owner: input.issue.owner,
        repo: input.issue.repo,
        issue_number: input.issue.number,
        labels: [input.label],
      });
    },
    closeTrackerIssue: async (input): Promise<void> => {
      const client = await getOctokit();
      await client.issues.update({
        owner: input.issue.owner,
        repo: input.issue.repo,
        issue_number: input.issue.number,
        state: 'closed',
        state_reason: 'completed',
      });
    },
    hasSkipBeenNoted: hasDefaultSkipBeenNoted,
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

function isAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: number };
  if (candidate.status === 401) return true;
  if (candidate.status === 403 && !isRateLimitError(error)) return true;
  return false;
}
