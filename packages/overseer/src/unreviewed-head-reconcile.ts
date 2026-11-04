/**
 * Unreviewed-head reconcile (WO-HARNESS-OVERSEER-UNREVIEWED-HEAD-RECONCILE-01).
 *
 * THE GAP THIS CLOSES: review work is created only by the pull_request webhook
 * (`pr-review-ingest.ts`). A push delivered while archon-app-1 is being rebuilt
 * is lost, and nothing ever looks again. On 2026-11-04 bdc-harness PR 1462's
 * head 8b307224 was pushed one second after a rebuild recreated the container;
 * the event store held overseer-reviewer rows only for the old head, and no
 * review was requested at the new head for 2.5 hours, until a hand nudge.
 *
 * WHAT A PASS DOES. For every watched repo (OVERSEER_MERGE_DISCOVERY_REPOS, the
 * same list merge discovery uses) it lists the open PRs and, for each one:
 *  - skips DRAFTS ONLY, exactly like the intake. FALLBACK and salvage PRs are
 *    NOT skipped (acting XO ruling, fence 280);
 *  - leaves alone a head that already has ANY overseer-reviewer row, in any
 *    status (queued, claimed, done, failed, cancelled);
 *  - otherwise enqueues run_review through the SAME `enqueueReviewWork` the push
 *    path uses (`createRealIngestDeps`), with idempotency key
 *    `pr-review:<owner>/<repo>#<n>@<head>` and repeat_reason
 *    `reconcile:unreviewed_head:<head>`. The UNIQUE idempotency key means a
 *    head the push path already queued can never be double-queued.
 *
 * The intake's other refusals are honored too, so the reconcile never queues a
 * review the push path itself would have refused: a PR authored by the
 * reviewer identity (custody), a PR whose live mergeable_state is `dirty`, and
 * any enqueue while the judge-ladder breaker reports every rung exhausted (the
 * next pass after the breaker clears picks the head up). These are counted
 * separately from `skipped`, which counts drafts only.
 *
 * SCHEDULE. Once at startup, then every OVERSEER_UNREVIEWED_HEAD_RECONCILE_MINUTES
 * (default 15). Started from packages/server/src/index.ts next to the review
 * worker clock, and only when the review route is configured.
 *
 * ENV FLAGS:
 *  - OVERSEER_UNREVIEWED_HEAD_RECONCILE_MINUTES: pass interval in minutes
 *    (positive integer; default 15; invalid values fall back to 15).
 *  - OVERSEER_UNREVIEWED_HEAD_RECONCILE_DRY_RUN=1 (also `true`/`yes`): run full
 *    passes but enqueue nothing; log one line per PR that WOULD be enqueued, as
 *    `reconcile_would_enqueue <owner>/<repo>#<n>@<head>`.
 *
 * LOGS. One `reconcile_enqueued <owner>/<repo>#<n>@<head>` line per enqueue and
 * one summary per pass:
 * `reconcile_unreviewed_head_pass scanned=N skipped=N already_requested=N
 * enqueued=N ...` (the same counts are also on the structured log object).
 */
import { createLogger } from '@archon/paths';
import { createRealOctokitClient, fetchAllOpenPullRequests } from './adapters/github-real-deps';
import type { RealGitHubOctokitLike } from './adapters/github-real-deps.ts';
import { resolveDiscoveryRepos } from './merge-candidate-discovery';
import type { DiscoveryRepoTarget } from './merge-candidate-discovery.ts';
import { reviewCorrelationId, reviewIdempotencyKey } from './pr-review-ingest';
import type { IngestDeps } from './pr-review-ingest.ts';
import { createRealIngestDeps } from './pr-review-wiring';
import type { ReviewRouteConfig } from './pr-review-wiring.ts';

const defaultLog = createLogger('overseer/unreviewed-head-reconcile');

export const UNREVIEWED_HEAD_RECONCILE_MINUTES_ENV = 'OVERSEER_UNREVIEWED_HEAD_RECONCILE_MINUTES';
export const UNREVIEWED_HEAD_RECONCILE_DRY_RUN_ENV = 'OVERSEER_UNREVIEWED_HEAD_RECONCILE_DRY_RUN';
export const DEFAULT_UNREVIEWED_HEAD_RECONCILE_MINUTES = 15;

/** Machine-readable prefix of every repeat_reason this pass writes. */
export const UNREVIEWED_HEAD_REASON_PREFIX = 'reconcile:unreviewed_head:';

export function buildUnreviewedHeadReason(headSha: string): string {
  return `${UNREVIEWED_HEAD_REASON_PREFIX}${headSha}`;
}

export function resolveUnreviewedHeadReconcileMinutes(
  raw: string | undefined = process.env[UNREVIEWED_HEAD_RECONCILE_MINUTES_ENV]
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_UNREVIEWED_HEAD_RECONCILE_MINUTES;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_UNREVIEWED_HEAD_RECONCILE_MINUTES;
}

export function resolveUnreviewedHeadReconcileDryRun(
  raw: string | undefined = process.env[UNREVIEWED_HEAD_RECONCILE_DRY_RUN_ENV]
): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** One open PR as the reconcile consumes it. */
export interface ReconcileOpenPullRequest {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  baseSha?: string;
  author: string;
}

export interface ReconcileLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface UnreviewedHeadReconcileDeps {
  /** Reviewer identity; a PR it authored is a custody conflict, as in the intake. */
  reviewerIdentity: string;
  listOpenPullRequests(input: {
    owner: string;
    repo: string;
  }): Promise<readonly ReconcileOpenPullRequest[]>;
  /** The push path's prior-work lookup (overseer-reviewer rows for the PR). */
  listPriorReviewWork: IngestDeps['listPriorReviewWork'];
  /** The push path's enqueue. MUST be the same function the intake calls. */
  enqueueReviewWork: IngestDeps['enqueueReviewWork'];
  fetchPullRequestMergeability?: IngestDeps['fetchPullRequestMergeability'];
  judgeLadderBreaker?: IngestDeps['judgeLadderBreaker'];
}

export interface UnreviewedHeadReconcileOptions {
  repos?: readonly DiscoveryRepoTarget[];
  dryRun?: boolean;
  logger?: ReconcileLogger;
}

export interface UnreviewedHeadReconcileSummary {
  dryRun: boolean;
  repos: number;
  failedRepos: string[];
  scanned: number;
  /** Drafts. The ONLY class skip, matching the intake. */
  skipped: number;
  already_requested: number;
  enqueued: number;
  would_enqueue: number;
  /** Already queued under the same idempotency key (a concurrent push won). */
  replayed: number;
  custody_conflict: number;
  dirty: number;
  breaker_deferred: number;
  failed: number;
}

function subject(pr: { owner: string; repo: string; prNumber: number; headSha: string }): string {
  return `${pr.owner}/${pr.repo}#${pr.prNumber}@${pr.headSha}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one reconcile pass. Never throws: a repo whose listing fails and a PR
 * whose lookup or enqueue fails are logged and counted, and the pass goes on.
 */
export async function runUnreviewedHeadReconcilePass(
  deps: UnreviewedHeadReconcileDeps,
  options: UnreviewedHeadReconcileOptions = {}
): Promise<UnreviewedHeadReconcileSummary> {
  const logger = options.logger ?? defaultLog;
  const repos = options.repos ?? resolveDiscoveryRepos();
  const dryRun = options.dryRun ?? resolveUnreviewedHeadReconcileDryRun();
  const summary: UnreviewedHeadReconcileSummary = {
    dryRun,
    repos: repos.length,
    failedRepos: [],
    scanned: 0,
    skipped: 0,
    already_requested: 0,
    enqueued: 0,
    would_enqueue: 0,
    replayed: 0,
    custody_conflict: 0,
    dirty: 0,
    breaker_deferred: 0,
    failed: 0,
  };

  if (repos.length === 0) {
    logger.warn(
      { env: 'OVERSEER_MERGE_DISCOVERY_REPOS' },
      'reconcile_unreviewed_head_no_repos_configured'
    );
  }

  for (const target of repos) {
    let listed: readonly ReconcileOpenPullRequest[];
    try {
      listed = await deps.listOpenPullRequests({ owner: target.owner, repo: target.repo });
    } catch (error) {
      summary.failedRepos.push(`${target.owner}/${target.repo}`);
      logger.warn(
        { owner: target.owner, repo: target.repo, err: errorMessage(error) },
        'reconcile_unreviewed_head_listing_failed'
      );
      continue;
    }

    for (const pr of listed) {
      summary.scanned += 1;
      // DRAFTS ONLY -- the intake's single class skip. No title or branch rule.
      if (pr.draft) {
        summary.skipped += 1;
        continue;
      }
      if (!pr.headSha) {
        summary.failed += 1;
        logger.warn(
          { owner: pr.owner, repo: pr.repo, prNumber: pr.prNumber },
          'reconcile_unreviewed_head_missing_head_sha'
        );
        continue;
      }
      try {
        // Any overseer-reviewer row at this exact head, in any status, means a
        // review was requested here. Leave it alone.
        const prior = await deps.listPriorReviewWork({
          owner: pr.owner,
          repo: pr.repo,
          prNumber: pr.prNumber,
        });
        if (prior.some(work => work.headSha === pr.headSha)) {
          summary.already_requested += 1;
          continue;
        }

        // Intake parity: the push path never reviews the reviewer's own PR.
        if (pr.author?.toLowerCase() === deps.reviewerIdentity.toLowerCase()) {
          summary.custody_conflict += 1;
          continue;
        }

        // Intake parity: while every judge rung is exhausted the push path parks
        // heads rather than queueing reviews that can only fail code-blind.
        if (deps.judgeLadderBreaker?.check()) {
          summary.breaker_deferred += 1;
          continue;
        }

        // Intake parity: a head in content conflict with its base is not queued.
        let baseSha = pr.baseSha;
        if (deps.fetchPullRequestMergeability) {
          let mergeableState: string | undefined;
          try {
            const live = await deps.fetchPullRequestMergeability({
              owner: pr.owner,
              repo: pr.repo,
              prNumber: pr.prNumber,
            });
            mergeableState = live.mergeableState;
            if (live.baseSha) baseSha = live.baseSha;
          } catch {
            // Same as the intake: a lookup failure is not evidence of a conflict.
          }
          if (mergeableState === 'dirty') {
            summary.dirty += 1;
            continue;
          }
        }

        if (dryRun) {
          summary.would_enqueue += 1;
          logger.info(
            { owner: pr.owner, repo: pr.repo, prNumber: pr.prNumber, headSha: pr.headSha },
            `reconcile_would_enqueue ${subject(pr)}`
          );
          continue;
        }

        const enqueued = await deps.enqueueReviewWork({
          correlationId: reviewCorrelationId(pr),
          idempotencyKey: reviewIdempotencyKey(pr),
          owner: pr.owner,
          repo: pr.repo,
          prNumber: pr.prNumber,
          headSha: pr.headSha,
          baseRef: pr.baseRef,
          ...(baseSha ? { baseSha } : {}),
          author: pr.author,
          repeatReason: buildUnreviewedHeadReason(pr.headSha),
          headCiGreen: false,
        });
        if (enqueued.alreadyExisted) {
          summary.replayed += 1;
          continue;
        }
        summary.enqueued += 1;
        logger.info(
          {
            owner: pr.owner,
            repo: pr.repo,
            prNumber: pr.prNumber,
            headSha: pr.headSha,
            messageId: enqueued.messageId,
            repeatReason: buildUnreviewedHeadReason(pr.headSha),
          },
          `reconcile_enqueued ${subject(pr)}`
        );
      } catch (error) {
        summary.failed += 1;
        logger.warn(
          {
            owner: pr.owner,
            repo: pr.repo,
            prNumber: pr.prNumber,
            headSha: pr.headSha,
            err: errorMessage(error),
          },
          'reconcile_unreviewed_head_pr_failed'
        );
      }
    }
  }

  logger.info(
    { ...summary },
    `reconcile_unreviewed_head_pass scanned=${summary.scanned} skipped=${summary.skipped} ` +
      `already_requested=${summary.already_requested} enqueued=${summary.enqueued} ` +
      `would_enqueue=${summary.would_enqueue} custody_conflict=${summary.custody_conflict} ` +
      `dirty=${summary.dirty} breaker_deferred=${summary.breaker_deferred} ` +
      `replayed=${summary.replayed} failed=${summary.failed} dry_run=${summary.dryRun}`
  );
  return summary;
}

/** Map GitHub's open-PR listing onto the reconcile's shape. */
export function createRealReconcileListOpenPullRequests(
  octokit: () => RealGitHubOctokitLike
): UnreviewedHeadReconcileDeps['listOpenPullRequests'] {
  return async ({ owner, repo }) => {
    const { pulls, complete } = await fetchAllOpenPullRequests(octokit(), { owner, repo });
    if (!complete) {
      defaultLog.warn(
        { owner, repo, pullsRead: pulls.length },
        'reconcile_unreviewed_head_listing_truncated'
      );
    }
    return pulls.map(pr => {
      // The live API carries user and base.sha; the narrow octokit type omits them.
      const wide = pr as typeof pr & {
        user?: { login?: string | null } | null;
        base?: { ref?: string; sha?: string };
      };
      return {
        owner,
        repo,
        prNumber: pr.number,
        title: pr.title,
        draft: pr.draft === true,
        headSha: pr.head.sha,
        headRef: pr.head.ref ?? '',
        baseRef: wide.base?.ref ?? '',
        ...(wide.base?.sha ? { baseSha: wide.base.sha } : {}),
        author: wide.user?.login ?? '',
      };
    });
  };
}

export interface RealReconcileDepsOverrides {
  ingestDeps?: IngestDeps;
  listOpenPullRequests?: UnreviewedHeadReconcileDeps['listOpenPullRequests'];
}

/**
 * Production binding. The prior-work lookup, the enqueue, the mergeability read
 * and the judge-ladder breaker all come from `createRealIngestDeps` -- the very
 * object the push-path webhook route uses -- so the reconcile cannot drift from
 * the intake's queue semantics.
 */
export function createRealUnreviewedHeadReconcileDeps(
  config: ReviewRouteConfig,
  overrides: RealReconcileDepsOverrides = {}
): UnreviewedHeadReconcileDeps {
  const ingest = overrides.ingestDeps ?? createRealIngestDeps(config);
  return {
    reviewerIdentity: config.reviewerIdentity,
    listOpenPullRequests:
      overrides.listOpenPullRequests ??
      // Built per call: createRealOctokitClient throws without credentials, and
      // that must fail one pass (logged per repo), not server startup.
      createRealReconcileListOpenPullRequests(() => createRealOctokitClient()),
    listPriorReviewWork: input => ingest.listPriorReviewWork(input),
    enqueueReviewWork: input => ingest.enqueueReviewWork(input),
    // A missing mergeability seam reads as "unknown", exactly as in the intake.
    fetchPullRequestMergeability: async input =>
      ingest.fetchPullRequestMergeability ? ingest.fetchPullRequestMergeability(input) : {},
    ...(ingest.judgeLadderBreaker ? { judgeLadderBreaker: ingest.judgeLadderBreaker } : {}),
  };
}

let clockTimer: ReturnType<typeof setInterval> | null = null;
let passInFlight = false;

async function guardedPass(
  deps: UnreviewedHeadReconcileDeps,
  options: UnreviewedHeadReconcileOptions
): Promise<UnreviewedHeadReconcileSummary | null> {
  if (passInFlight) return null;
  passInFlight = true;
  try {
    return await runUnreviewedHeadReconcilePass(deps, options);
  } catch (error) {
    (options.logger ?? defaultLog).warn(
      { err: errorMessage(error) },
      'reconcile_unreviewed_head_pass_failed'
    );
    return null;
  } finally {
    passInFlight = false;
  }
}

/**
 * Start the reconcile clock: one pass now (startup), then one every interval.
 * Idempotent: a second start while running is a no-op. Returns the startup
 * pass promise so callers and tests can await it.
 */
export function startUnreviewedHeadReconcileClock(
  config: ReviewRouteConfig,
  input: {
    deps?: UnreviewedHeadReconcileDeps;
    intervalMinutes?: number;
    options?: UnreviewedHeadReconcileOptions;
  } = {}
): Promise<UnreviewedHeadReconcileSummary | null> {
  if (clockTimer) return Promise.resolve(null);
  const deps = input.deps ?? createRealUnreviewedHeadReconcileDeps(config);
  const options = input.options ?? {};
  const minutes = input.intervalMinutes ?? resolveUnreviewedHeadReconcileMinutes();
  (options.logger ?? defaultLog).info(
    {
      intervalMinutes: minutes,
      dryRun: options.dryRun ?? resolveUnreviewedHeadReconcileDryRun(),
    },
    'reconcile_unreviewed_head_clock_started'
  );
  clockTimer = setInterval(() => {
    void guardedPass(deps, options);
  }, minutes * 60_000);
  // Never hold the process open for this clock alone.
  (clockTimer as { unref?: () => void }).unref?.();
  return guardedPass(deps, options);
}

export function stopUnreviewedHeadReconcileClock(): void {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}
