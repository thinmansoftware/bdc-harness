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
 * WINDOW AND CAP (acting XO ruling, fence 281). The first dry run on the host
 * reported would_enqueue=91, mostly long-dead PRs, and reviews run one at a
 * time. So a non-draft PR is considered only if it was updated inside the
 * window, and real enqueues per pass are capped. The ruling allows head commit
 * date OR updated_at; the open-PR listing (`fetchAllOpenPullRequests`) does not
 * carry the head commit date, so updated_at alone is used and no per-PR API
 * call is added. A push moves updated_at, so a lost-webhook head is inside the
 * window for WINDOW_HOURS after the push. A PR with no readable updated_at
 * counts as outside it. All listed PRs are processed most recently updated
 * first, across repos; once the cap is reached, every further unreviewed head
 * is counted as `capped` and left for the next pass (no mergeability read is
 * spent on it). In dry-run the cap applies to would_enqueue the same way.
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
 *  - OVERSEER_UNREVIEWED_HEAD_RECONCILE_WINDOW_HOURS: eligibility window in
 *    hours on the PR's updated_at (positive integer; default 48; an invalid
 *    value falls back to 48 with a warn log).
 *  - OVERSEER_UNREVIEWED_HEAD_RECONCILE_MAX_PER_PASS: most enqueues (or
 *    would_enqueues in dry-run) per pass (positive integer; default 10; an
 *    invalid value falls back to 10 with a warn log).
 *
 * LOGS. One `reconcile_enqueued <owner>/<repo>#<n>@<head>` line per enqueue and
 * one summary per pass:
 * `reconcile_unreviewed_head_pass scanned=N skipped=N outside_window=N capped=N
 * already_requested=N enqueued=N ...` (the same counts are also on the
 * structured log object). `skipped` counts drafts only.
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
export const UNREVIEWED_HEAD_RECONCILE_WINDOW_HOURS_ENV =
  'OVERSEER_UNREVIEWED_HEAD_RECONCILE_WINDOW_HOURS';
export const UNREVIEWED_HEAD_RECONCILE_MAX_PER_PASS_ENV =
  'OVERSEER_UNREVIEWED_HEAD_RECONCILE_MAX_PER_PASS';
export const DEFAULT_UNREVIEWED_HEAD_RECONCILE_MINUTES = 15;
export const DEFAULT_UNREVIEWED_HEAD_RECONCILE_WINDOW_HOURS = 48;
export const DEFAULT_UNREVIEWED_HEAD_RECONCILE_MAX_PER_PASS = 10;

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

/**
 * Parse a positive-integer env value the same way as the minutes env; an
 * invalid value falls back to the default with a warn log.
 */
function resolvePositiveIntEnv(
  envName: string,
  raw: string | undefined,
  fallback: number,
  logger: Pick<ReconcileLogger, 'warn'>
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value > 0) return value;
  logger.warn({ env: envName, value: raw, fallback }, 'reconcile_unreviewed_head_invalid_env');
  return fallback;
}

export function resolveUnreviewedHeadReconcileWindowHours(
  raw: string | undefined = process.env[UNREVIEWED_HEAD_RECONCILE_WINDOW_HOURS_ENV],
  logger: Pick<ReconcileLogger, 'warn'> = defaultLog
): number {
  return resolvePositiveIntEnv(
    UNREVIEWED_HEAD_RECONCILE_WINDOW_HOURS_ENV,
    raw,
    DEFAULT_UNREVIEWED_HEAD_RECONCILE_WINDOW_HOURS,
    logger
  );
}

export function resolveUnreviewedHeadReconcileMaxPerPass(
  raw: string | undefined = process.env[UNREVIEWED_HEAD_RECONCILE_MAX_PER_PASS_ENV],
  logger: Pick<ReconcileLogger, 'warn'> = defaultLog
): number {
  return resolvePositiveIntEnv(
    UNREVIEWED_HEAD_RECONCILE_MAX_PER_PASS_ENV,
    raw,
    DEFAULT_UNREVIEWED_HEAD_RECONCILE_MAX_PER_PASS,
    logger
  );
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
  /** GitHub `updated_at` (ISO 8601). Missing or unparsable = outside the window. */
  updatedAt?: string;
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
  /** Eligibility window in hours; default from the env. */
  windowHours?: number;
  /** Most enqueues (would_enqueues in dry-run) per pass; default from the env. */
  maxPerPass?: number;
  /** Clock seam for tests (epoch ms). */
  now?: () => number;
}

export interface UnreviewedHeadReconcileSummary {
  dryRun: boolean;
  repos: number;
  failedRepos: string[];
  scanned: number;
  /** Drafts. The ONLY class skip, matching the intake. */
  skipped: number;
  windowHours: number;
  maxPerPass: number;
  /** Not updated inside the window (or no readable updated_at). */
  outside_window: number;
  /** Unreviewed heads left for the next pass because the cap was reached. */
  capped: number;
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

/** Parsed updated_at in epoch ms, or null when absent or unparsable. */
function updatedAtMs(pr: ReconcileOpenPullRequest): number | null {
  if (!pr.updatedAt) return null;
  const ms = Date.parse(pr.updatedAt);
  return Number.isFinite(ms) ? ms : null;
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
  const windowHours =
    options.windowHours ?? resolveUnreviewedHeadReconcileWindowHours(undefined, logger);
  const maxPerPass =
    options.maxPerPass ?? resolveUnreviewedHeadReconcileMaxPerPass(undefined, logger);
  const windowStartMs = (options.now ?? Date.now)() - windowHours * 3_600_000;
  const summary: UnreviewedHeadReconcileSummary = {
    dryRun,
    repos: repos.length,
    failedRepos: [],
    scanned: 0,
    skipped: 0,
    windowHours,
    maxPerPass,
    outside_window: 0,
    capped: 0,
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

  // List every watched repo first, so the cap takes the most recently updated
  // PRs across ALL repos, not the first repo's.
  const listed: ReconcileOpenPullRequest[] = [];
  for (const target of repos) {
    try {
      listed.push(...(await deps.listOpenPullRequests({ owner: target.owner, repo: target.repo })));
    } catch (error) {
      summary.failedRepos.push(`${target.owner}/${target.repo}`);
      logger.warn(
        { owner: target.owner, repo: target.repo, err: errorMessage(error) },
        'reconcile_unreviewed_head_listing_failed'
      );
    }
  }
  // Most recently updated first; a PR with no readable updated_at sorts last.
  listed.sort((a, b) => (updatedAtMs(b) ?? -Infinity) - (updatedAtMs(a) ?? -Infinity));

  for (const pr of listed) {
    summary.scanned += 1;
    // DRAFTS ONLY -- the intake's single class skip. No title or branch rule.
    if (pr.draft) {
      summary.skipped += 1;
      continue;
    }
    // Eligibility window on updated_at (fence 281). Counted apart from drafts.
    const updated = updatedAtMs(pr);
    if (updated === null || updated < windowStartMs) {
      summary.outside_window += 1;
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

      // Per-pass cap (fence 281): real enqueues, or would_enqueues in dry-run.
      // Checked before the mergeability read so a capped head costs no API call.
      if ((dryRun ? summary.would_enqueue : summary.enqueued) >= maxPerPass) {
        summary.capped += 1;
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

  logger.info(
    { ...summary },
    `reconcile_unreviewed_head_pass scanned=${summary.scanned} skipped=${summary.skipped} ` +
      `outside_window=${summary.outside_window} capped=${summary.capped} ` +
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
      // The live API carries user, base.sha and updated_at; the narrow octokit
      // type omits them.
      const wide = pr as typeof pr & {
        user?: { login?: string | null } | null;
        base?: { ref?: string; sha?: string };
        updated_at?: string | null;
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
        ...(wide.updated_at ? { updatedAt: wide.updated_at } : {}),
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
      windowHours: options.windowHours ?? resolveUnreviewedHeadReconcileWindowHours(),
      maxPerPass: options.maxPerPass ?? resolveUnreviewedHeadReconcileMaxPerPass(),
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
