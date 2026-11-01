/**
 * Steady sweep for open pull requests whose current head never produced an
 * ingest receipt. The request is a signed pull_request synchronize event
 * handed to the existing ingest path. The timer matches the review worker
 * clock: no-op under NODE_ENV=test, one immediate tick, then every five
 * minutes, unref'd, and non-overlapping.
 */
import { createHmac } from 'node:crypto';
import { createLogger } from '@archon/paths';
import { createRealOctokitClient } from './adapters/github-real-deps';
import { resolveMergeRepoPolicy } from './merge-repo-policy';
import { ingestPullRequestEvent, type IngestRequest, type IngestResult } from './pr-review-ingest';
import { createRealIngestDeps, type ReviewRouteConfig } from './pr-review-wiring';
import { hasIngestReceiptForHead, hasOverseerReviewForHead } from './review-ingest-receipts';

const log = createLogger('overseer/review-gap-sweeper');

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const HEAD_MIN_AGE_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;
const MAX_LIST_PAGES = 10;
const PAGE_SIZE = 100;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export interface GapLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
}

export interface ReviewGapPull {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  headRef: string;
  baseRef: string;
  authorLogin: string;
  draft: boolean;
  state: string;
}

export interface ReviewGapSweepDeps {
  webhookSecret: string;
  reviewerIdentity: string;
  listRepos: () => readonly string[];
  listRecentPulls: (input: {
    owner: string;
    repo: string;
    updatedAfterMs: number;
  }) => Promise<readonly ReviewGapPull[]>;
  getHeadPushedAt: (input: {
    owner: string;
    repo: string;
    sha: string;
    prNumber: number;
  }) => Promise<string | null>;
  hasIngestReceiptForHead?: (
    owner: string,
    repo: string,
    prNumber: number,
    headSha: string
  ) => Promise<boolean>;
  hasOverseerReviewForHead?: (
    owner: string,
    repo: string,
    prNumber: number,
    headSha: string,
    reviewerIdentity: string
  ) => Promise<boolean>;
  ingest: (request: IngestRequest) => Promise<unknown>;
  log?: GapLogger;
}

interface ListedPull {
  number?: number;
  draft?: boolean;
  state?: string;
  updated_at?: string;
  head?: { sha?: string; ref?: string };
  base?: { ref?: string };
  user?: { login?: string | null } | null;
}

interface SweepGitHub {
  pulls: {
    list(input: {
      owner: string;
      repo: string;
      state: 'open';
      sort: 'updated';
      direction: 'desc';
      per_page: number;
      page: number;
    }): Promise<{ data: ListedPull[] }>;
  };
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
}

const HEAD_PUSHED_AT_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            oid
            pushedDate
          }
        }
      }
    }
  }
}`;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Push time of `headSha` from a pull-request GraphQL payload.
 * `committedDate` is ignored: a commit authored earlier and pushed recently
 * is only as old as the push. Returns null when the payload is not this head
 * or GitHub did not report `pushedDate` -- the sweeper then leaves the head
 * alone rather than falling back to the committer timestamp.
 */
export function headPushedAtFromGraphql(payload: unknown, headSha: string): string | null {
  const pullRequest = asRecord(asRecord(asRecord(payload)?.repository)?.pullRequest);
  if (pullRequest?.headRefOid !== headSha) return null;
  const nodes = asRecord(pullRequest.commits)?.nodes;
  if (!Array.isArray(nodes)) return null;
  const commit = asRecord(asRecord(nodes[0])?.commit);
  if (commit?.oid !== headSha) return null;
  const pushed = commit.pushedDate;
  return typeof pushed === 'string' && pushed.trim() !== '' ? pushed : null;
}

function safeErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : 'unknown_error';
  if (/bearer\s|private key|begin [a-z0-9 ]*private/i.test(text)) return 'redacted_error';
  return text;
}

function splitOwnerRepo(key: string): { owner: string; repo: string } | null {
  const slash = key.indexOf('/');
  if (slash <= 0 || slash !== key.lastIndexOf('/') || slash === key.length - 1) return null;
  return { owner: key.slice(0, slash), repo: key.slice(slash + 1) };
}

function buildIngestRequest(secret: string, pull: ReviewGapPull): IngestRequest {
  const rawBody = JSON.stringify({
    action: 'synchronize',
    number: pull.prNumber,
    pull_request: {
      number: pull.prNumber,
      draft: false,
      head: { sha: pull.headSha, ref: pull.headRef },
      base: { ref: pull.baseRef },
      user: { login: pull.authorLogin },
    },
    repository: {
      name: pull.repo,
      owner: { login: pull.owner },
    },
  });
  return {
    rawBody,
    signature: `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
    eventType: 'pull_request',
    deliveryId: `review-gap:${pull.owner}/${pull.repo}#${pull.prNumber}@${pull.headSha}`,
  };
}

async function listOpenPullsUpdatedSince(
  client: SweepGitHub,
  input: { owner: string; repo: string; updatedAfterMs: number }
): Promise<ReviewGapPull[]> {
  const found: ReviewGapPull[] = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const batch = await client.pulls.list({
      owner: input.owner,
      repo: input.repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: PAGE_SIZE,
      page,
    });
    const data = batch.data ?? [];
    let reachedOlder = false;
    for (const pull of data) {
      const updated = Date.parse(pull.updated_at ?? '');
      if (!Number.isFinite(updated) || updated < input.updatedAfterMs) {
        reachedOlder = true;
        break;
      }
      if (pull.draft === true) continue;
      if ((pull.state ?? 'open').toLowerCase() !== 'open') continue;
      const headSha = pull.head?.sha ?? '';
      if (!headSha || typeof pull.number !== 'number') continue;
      found.push({
        owner: input.owner,
        repo: input.repo,
        prNumber: pull.number,
        headSha,
        headRef: pull.head?.ref ?? '',
        baseRef: pull.base?.ref ?? '',
        authorLogin: pull.user?.login ?? '',
        draft: false,
        state: 'open',
      });
    }
    if (reachedOlder || data.length < PAGE_SIZE) break;
  }
  return found;
}

export async function readHeadPushedAt(
  client: {
    graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
  },
  input: { owner: string; repo: string; sha: string; prNumber: number }
): Promise<string | null> {
  const payload = await client.graphql(HEAD_PUSHED_AT_QUERY, {
    owner: input.owner,
    name: input.repo,
    number: input.prNumber,
  });
  return headPushedAtFromGraphql(payload, input.sha);
}

function createProductionDeps(config: ReviewRouteConfig): ReviewGapSweepDeps {
  let client: SweepGitHub | undefined;
  const github = (): SweepGitHub => {
    client ??= createRealOctokitClient('overseer') as unknown as SweepGitHub;
    return client;
  };
  let ingestDeps: ReturnType<typeof createRealIngestDeps> | undefined;
  return {
    webhookSecret: config.webhookSecret,
    reviewerIdentity: config.reviewerIdentity,
    listRepos: (): readonly string[] => Object.keys(resolveMergeRepoPolicy()),
    listRecentPulls: (input): Promise<ReviewGapPull[]> =>
      listOpenPullsUpdatedSince(github(), input),
    getHeadPushedAt: (input): Promise<string | null> => readHeadPushedAt(github(), input),
    ingest: (request: IngestRequest): Promise<IngestResult> => {
      ingestDeps ??= createRealIngestDeps(config);
      return ingestPullRequestEvent(request, ingestDeps);
    },
  };
}

async function considerPull(
  deps: ReviewGapSweepDeps,
  pull: ReviewGapPull,
  now: number,
  logger: GapLogger
): Promise<boolean> {
  if (pull.draft || pull.state.toLowerCase() !== 'open' || pull.headSha === '') return false;
  let pushedMs = Number.NaN;
  try {
    pushedMs = Date.parse(
      (await deps.getHeadPushedAt({
        owner: pull.owner,
        repo: pull.repo,
        sha: pull.headSha,
        prNumber: pull.prNumber,
      })) ?? ''
    );
  } catch (error) {
    logger.warn(
      {
        owner: pull.owner,
        repo: pull.repo,
        prNumber: pull.prNumber,
        err: safeErrorText(error),
      },
      'review_gap_sweep_commit_lookup_failed'
    );
    return false;
  }
  // Age is when this head was pushed, not the git committer timestamp.
  if (!Number.isFinite(pushedMs) || now - pushedMs <= HEAD_MIN_AGE_MS) return false;

  const hasReceipt = deps.hasIngestReceiptForHead ?? hasIngestReceiptForHead;
  const hasReview =
    deps.hasOverseerReviewForHead ??
    ((owner, repo, prNumber, headSha, reviewerIdentity): Promise<boolean> =>
      hasOverseerReviewForHead(owner, repo, prNumber, headSha, reviewerIdentity));
  try {
    if (await hasReceipt(pull.owner, pull.repo, pull.prNumber, pull.headSha)) return false;
  } catch (error) {
    logger.warn(
      {
        owner: pull.owner,
        repo: pull.repo,
        prNumber: pull.prNumber,
        err: safeErrorText(error),
      },
      'review_gap_sweep_receipt_lookup_failed'
    );
    return false;
  }
  try {
    if (
      await hasReview(pull.owner, pull.repo, pull.prNumber, pull.headSha, deps.reviewerIdentity)
    ) {
      return false;
    }
  } catch (error) {
    logger.warn(
      {
        owner: pull.owner,
        repo: pull.repo,
        prNumber: pull.prNumber,
        err: safeErrorText(error),
      },
      'review_gap_sweep_review_lookup_failed'
    );
    return false;
  }

  await deps.ingest(buildIngestRequest(deps.webhookSecret, pull));
  logger.info(
    {
      owner: pull.owner,
      repository: pull.repo,
      prNumber: pull.prNumber,
      headSha: pull.headSha,
    },
    'review_gap_swept'
  );
  return true;
}

/**
 * One sweep tick. Repositories come only from the merge allowlist. A GitHub
 * failure in one repository does not abort the others. Never throws.
 */
export async function runReviewGapSweep(deps: ReviewGapSweepDeps, now: number): Promise<void> {
  const logger = deps.log ?? log;
  try {
    const repos = deps.listRepos();
    if (repos.length === 0) {
      logger.info({ reason: 'no_repos' }, 'review_gap_sweep_skipped');
      return;
    }
    let requested = 0;
    for (const key of repos) {
      if (requested >= MAX_REQUESTS) return;
      const target = splitOwnerRepo(key);
      if (!target) {
        logger.warn({ repo: key }, 'review_gap_sweep_repo_invalid');
        continue;
      }
      let pulls: readonly ReviewGapPull[];
      try {
        pulls = await deps.listRecentPulls({
          owner: target.owner,
          repo: target.repo,
          updatedAfterMs: now - TWO_HOURS_MS,
        });
      } catch (error) {
        logger.warn(
          { owner: target.owner, repo: target.repo, err: safeErrorText(error) },
          'review_gap_sweep_repo_failed'
        );
        continue;
      }
      for (const pull of pulls) {
        if (requested >= MAX_REQUESTS) return;
        try {
          const swept = await considerPull(deps, pull, now, logger);
          if (swept) requested += 1;
        } catch (error) {
          // The ingest call was made. Count it so one failing head cannot
          // turn the rest of the tick into an unbounded retry.
          requested += 1;
          logger.warn(
            {
              owner: pull.owner,
              repo: pull.repo,
              prNumber: pull.prNumber,
              err: safeErrorText(error),
            },
            'review_gap_sweep_request_failed'
          );
        }
      }
    }
  } catch (error) {
    logger.error({ err: safeErrorText(error) }, 'review_gap_sweep_failed');
  }
}

export function startReviewGapSweeper(config: ReviewRouteConfig | null | undefined): void {
  if (!config || timer || process.env.NODE_ENV === 'test') return;
  const deps = createProductionDeps(config);
  const tick = (): void => {
    if (inFlight) return;
    inFlight = true;
    void runReviewGapSweep(deps, Date.now())
      .catch((error: unknown) => {
        log.error({ err: safeErrorText(error) }, 'review_gap_sweep_failed');
      })
      .finally(() => {
        inFlight = false;
      });
  };
  tick();
  timer = setInterval(tick, FIVE_MINUTES_MS);
  timer.unref?.();
}

export function stopReviewGapSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
