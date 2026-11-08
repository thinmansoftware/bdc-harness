/**
 * Overseer review worker clock: claims run_review work, prepares an exact-head
 * sealed checkout, runs the judge and submits the verdict.
 *
 * REVIEW CHECKOUT CACHE (WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01).
 * Cached checkouts live at `<checkout root>/<owner>/<repo>/<40-hex headSha>`
 * (root = OVERSEER_REVIEW_CHECKOUT_ROOT, else `<OVERSEER_REVIEW_SPOOL>/checkouts`,
 * spool default /var/lib/overseer-review). An eviction pass runs before each
 * checkout is prepared and once per tick after the queue drain:
 *
 * - OVERSEER_REVIEW_CHECKOUT_CACHE_MAX_BYTES (default 3221225472 = 3GB): total
 *   cache cap. Over it, least-recently-used checkouts (directory mtime, touched
 *   on creation and on every reuse) are evicted first, but the newest 2 per
 *   owner/repo are always kept. If the cap still cannot be met the pass logs
 *   `overseer_review_checkout_cache_over_cap` with the total and stops.
 * - Merged or closed PR -> evicted; superseded head (the PR's live head is a
 *   different, also-cached checkout) -> evicted. The PR is read from GitHub at
 *   most once per OVERSEER_REVIEW_CHECKOUT_STATE_SWEEP_MS (default 900000 =
 *   15 minutes); a lookup failure KEEPS the directory and logs
 *   `overseer_review_checkout_state_unknown`.
 * - Never evicted: a checkout bound to an in-flight run_review (claimed, lease
 *   not expired) or to the review being prepared. Never walked or touched:
 *   anything that is not a 40-hex directory under `<root>/<owner>/<repo>/`
 *   (job scratch `<spool>/<id>.scratch`, in-progress `*.tmp-*`, symlinks).
 * - Single writer: one review worker owns a spool through the database lease
 *   `review_spool_leases` (key `review-spool:<checkout root>`), acquired for
 *   the whole tick (busy -> `overseer_review_worker_spool_busy`), renewed every
 *   minute (TTL 10 minutes), released in `finally`. Eviction re-checks holder
 *   and fencing token against the database before every directory delete and
 *   stops the pass (`overseer_review_checkout_eviction_stopped`) on a mismatch.
 * - Each eviction logs `overseer_review_checkout_evicted` with owner, repo,
 *   headSha, reason (merged, closed, superseded, cap) and bytesFreed; a pass
 *   that evicted anything logs `overseer_review_checkout_eviction_pass` with
 *   freedBytes and totalBytes.
 *
 * SMALLER CHECKOUTS. New checkouts fetch head and base with `--depth 1` and
 * `--filter=blob:none`, then prefetch the base..head diff blobs so
 * `git diff <base> <head>` works offline. OVERSEER_REVIEW_SPARSE_EXCLUDES
 * (comma-separated `owner/repo:path` entries, default
 * `thinmansoftware/bdc-xo:generations/`, empty string = none) enables a
 * non-cone sparse-checkout that leaves those paths out of the worktree.
 */
import {
  claimMessage,
  deferMessage,
  heartbeatWorker,
  listMessages,
  listMessagesBySeqCursor,
  postResult,
  registerWorker,
  releaseMessage,
  renewMessageLease,
  supersedeQueuedMessageByClaim,
  type ClaimedDispatchMessage,
  type DispatchMessage,
  type SeqCursorMessage,
  type DispatchTaskOutcome,
} from '@archon/core/db/dispatch';
import {
  acquireReviewSpoolLease,
  checkReviewSpoolLease,
  releaseReviewSpoolLease,
  renewReviewSpoolLease,
} from '@archon/core/db/review-spool-leases';
import {
  createDurableSweepCursor,
  createRealStaleVerdictSweepDeps,
  resolveStaleSweepMax,
  runStaleVerdictSweep,
} from './stale-verdict-sweep-wiring';
import { createLogger } from '@archon/paths';
import {
  applyLadderRestoredRequest,
  recoverParkedJudgeHeads,
} from '@archon/overseer/judge-ladder-health';
import { defaultReviewLadder } from '@archon/overseer/pr-review-evaluator';
import type { IngestDeps } from '@archon/overseer/pr-review-ingest';
import {
  createRealIngestDeps,
  createRealSubmitDeps,
  parseReviewWorkBody,
  REVIEW_RECIPIENT,
  type ReviewRouteConfig,
} from '@archon/overseer/pr-review-wiring';
import {
  runAndSubmitReview,
  type ReviewWorkItem,
  type SubmitDisposition,
  type SubmitOutcome,
  type SubmitDeps,
} from '@archon/overseer/pr-review-submit';
import { createRealOctokitClient } from '@archon/overseer/adapters/github-real-deps';
import {
  chmod,
  lstat,
  mkdir,
  opendir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const log = createLogger('dispatch/review-worker-clock');
const REVIEW_WORKER_ID = 'overseer-review-worker';
const REVIEW_TASK_TYPE = 'run_review';
// How long a checks-pending review item is held back before it becomes
// re-claimable, so the worker does not re-poll the checks API every tick.
const CHECKS_PENDING_BACKOFF_MS = Math.max(
  1_000,
  Number(process.env.OVERSEER_REVIEW_CHECKS_PENDING_BACKOFF_MS) || 60_000
);
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export const REVIEW_CHECK_PLAN_PATH = '.github/overseer-review-check-plan.json';

export type TrustedCheckPlan =
  | { status: 'absent'; commands: readonly (readonly string[])[] }
  | { status: 'present'; commands: readonly (readonly string[])[] }
  | { status: 'unsafe'; commands: readonly (readonly string[])[] };

export function parseTrustedCheckPlan(raw: string): TrustedCheckPlan {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.length === 0) return { status: 'unsafe', commands: [] };
    if (
      !value.every(
        command =>
          Array.isArray(command) &&
          command.length > 0 &&
          !['sh', 'bash', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'pwsh'].includes(command[0]) &&
          command.every(
            argument =>
              typeof argument === 'string' &&
              argument.length > 0 &&
              !argument.includes('\0') &&
              argument.length <= 4096
          )
      )
    ) {
      return { status: 'unsafe', commands: [] };
    }
    return { status: 'present', commands: value as string[][] };
  } catch {
    return { status: 'unsafe', commands: [] };
  }
}

export async function readTrustedCheckPlan(checkoutPath: string): Promise<TrustedCheckPlan> {
  if (!checkoutPath) return { status: 'unsafe', commands: [] };
  const planPath = join(checkoutPath, REVIEW_CHECK_PLAN_PATH);
  try {
    // Containment by lstat, never by comparing realpath strings: Windows can
    // return a short (8.3) name for one path and the long name for the other.
    // The checkout root is server-created; if neither `.github` nor the plan
    // is a symlink, the plan cannot resolve outside the checkout.
    const planDir = await lstat(dirname(planPath));
    if (planDir.isSymbolicLink() || !planDir.isDirectory())
      return { status: 'unsafe', commands: [] };
    const info = await lstat(planPath);
    if (!info.isFile()) return { status: 'unsafe', commands: [] };
    return parseTrustedCheckPlan(await readFile(planPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { status: 'absent', commands: [] };
    return { status: 'unsafe', commands: [] };
  }
}

interface ReviewWorkerLogger {
  warn(data: Record<string, unknown>, message: string): void;
}

export interface ReviewWorkerDeps {
  registerWorker: typeof registerWorker;
  heartbeatWorker: typeof heartbeatWorker;
  listMessages: typeof listMessages;
  claimMessage: typeof claimMessage;
  postResult: typeof postResult;
  releaseMessage: typeof releaseMessage;
  /**
   * Fenced claimed->queued deferral with a future clock. Named per
   * WO-HARNESS-OVERSEER-REVIEW-CHECK-DEFERRAL-01 Section 7; delegates to
   * `releaseMessage`, which already carries the required fencing guards.
   */
  deferMessage: typeof deferMessage;
  renewMessageLease?: typeof renewMessageLease;
  runAndSubmitReview: typeof runAndSubmitReview;
  createSubmitDeps: (reviewerIdentity: string) => ReturnType<typeof createRealSubmitDeps>;
  prepareCheckout?: (input: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    baseRef: string;
    baseSha: string;
  }) => Promise<string>;
  /**
   * Trusted base capture for queued work that omits baseSha (check-completion
   * and ladder-recovery re-reviews). The parent asks GitHub with its own
   * installation credential; the answer becomes this review's captured base.
   * Absent or failing = the checkout cannot be prepared (review_incomplete).
   */
  resolveReviewBase?: (input: {
    owner: string;
    repo: string;
    prNumber: number;
  }) => Promise<{ baseRef: string; baseSha: string }>;
  /** Optional logger seam for deterministic observability tests. */
  logger?: ReviewWorkerLogger;
  /**
   * Keyset reader over QUEUED run_review rows (listMessagesBySeqCursor) and the
   * fenced retire-by-claim write, used to supersede redundant queued reviews of
   * the head just claimed (WO-HARNESS-OVERSEER-RECHECK-DEDUPE-PER-HEAD-01).
   * Optional so a test double can omit them; when either is absent nothing is
   * superseded and every queued review runs as before.
   */
  listQueuedReviews?: (filters: {
    recipient: string;
    task_type: string;
    status: 'queued';
    afterSeq?: number;
    limit: number;
  }) => Promise<SeqCursorMessage[]>;
  supersedeQueuedReview?: typeof supersedeQueuedMessageByClaim;
  /**
   * Backstop for lost check-completion deliveries (#782 part 3). Optional so a
   * test double can omit it; when absent the sweep simply does not run and the
   * primary review path is untouched.
   */
  staleVerdictSweep?: (config: ReviewRouteConfig) => Promise<unknown>;
  /**
   * Re-enqueue heads parked by the judge-ladder breaker once the ladder is
   * open again (#847). Optional for the same reason as the sweep; when absent
   * parked heads wait for an operator `ladder_restored` row.
   */
  judgeLadderRecovery?: (config: ReviewRouteConfig) => Promise<unknown>;
  /**
   * Review checkout cache eviction (WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01).
   * Called before each checkout is prepared (protecting that head) and once per
   * tick after the drain. Optional so test doubles can omit it; a failure is
   * logged and never blocks a review.
   */
  evictCheckouts?: (input: {
    protect: readonly ReviewCheckoutKey[];
    lease: ReviewSpoolLeaseHandle;
  }) => Promise<unknown>;
  /**
   * Single-writer spool lease store (database table `review_spool_leases`).
   * Required: a tick that cannot take the lease does no review work.
   */
  spoolLease: ReviewSpoolLeaseStore;
  /** Spool lease key override (tests). Defaults to `review-spool:<checkout root>`. */
  spoolKey?: string;
}

interface ResultMapping {
  status: 'done' | 'failed';
  task_outcome: DispatchTaskOutcome;
}

function mapSubmitOutcome(
  disposition: Exclude<SubmitDisposition, 'checks_pending' | 'transport_error' | 'rate_limited'>
): ResultMapping {
  switch (disposition) {
    // `stale_head` and `superseded_head` both mean the head this item is BOUND
    // to is no longer the live head. The item's payload carries that dead SHA
    // and nothing rewrites it, so releasing it back to the queue would make
    // every later tick re-evaluate the same stale SHA and return the same
    // disposition forever (#777 review finding). Ingest already covers the new
    // head: a push cancels every in-flight item bound to a different SHA and
    // enqueues a fresh item bound to the exact new head, so this item retiring
    // leaves no head unreviewed. TERMINAL, and `succeeded` rather than
    // `blocked` because supersession is the system working, not a failure.
    case 'approved':
    case 'changes_requested':
    case 'stale_head':
    case 'superseded_head':
      return { status: 'done', task_outcome: 'succeeded' };
    // `blocked_required_contexts_unavailable` (#775): the required
    // status-check contexts could not be read after the attempt bound.
    // TERMINAL and blocked -- never released for another tick (unbounded
    // release is what parked these rows at fencing_token 240) and never
    // succeeded, because no review judgment was ever formed.
    case 'custody_conflict':
    case 'merge_custody_conflict':
    case 'blocked_required_contexts_unavailable':
    case 'review_incomplete':
      return { status: 'failed', task_outcome: 'blocked' };
    case 'reviewer_failed':
    case 'submission_failed':
      return { status: 'failed', task_outcome: 'failed' };
    default: {
      const exhaustive: never = disposition;
      throw new Error(`unknown_review_submit_disposition:${String(exhaustive)}`);
    }
  }
}

export function createRealReviewWorkerDeps(
  approvalRecheckDeps: Pick<SubmitDeps, 'findRunForPullRequest' | 'recheckMergeOnApproval'> = {}
): ReviewWorkerDeps {
  // Built once, lazily: createRealIngestDeps logs its configuration at
  // construction and the recovery pass runs every tick.
  let ingestDeps: IngestDeps | undefined;
  return {
    registerWorker,
    heartbeatWorker,
    listMessages,
    claimMessage,
    postResult,
    releaseMessage,
    deferMessage,
    renewMessageLease,
    listQueuedReviews: listMessagesBySeqCursor,
    supersedeQueuedReview: supersedeQueuedMessageByClaim,
    runAndSubmitReview,
    createSubmitDeps: identity => ({ ...createRealSubmitDeps(identity), ...approvalRecheckDeps }),
    prepareCheckout: prepareReviewCheckout,
    resolveReviewBase: resolveLiveReviewBase,
    staleVerdictSweep: config =>
      runStaleVerdictSweep(
        createRealStaleVerdictSweepDeps(config),
        resolveStaleSweepMax(),
        // DURABLE, not process-local: archon-app-1 is rebuilt regularly, and a
        // cursor that rewinds on restart can never walk a store larger than one
        // process lifetime covers (#786 review @45aa739e).
        createDurableSweepCursor()
      ),
    judgeLadderRecovery: (config): Promise<{ recovered: string[]; stillParked: number }> => {
      ingestDeps ??= createRealIngestDeps(config);
      return recoverParkedJudgeHeads(ingestDeps, defaultReviewLadder());
    },
    evictCheckouts: createReviewCheckoutEvictor({
      listClaimedReviews: listMessagesBySeqCursor,
      lookupPrState: createGitHubReviewCheckoutPrLookup(),
    }),
    spoolLease: {
      acquire: acquireReviewSpoolLease,
      renew: renewReviewSpoolLease,
      release: releaseReviewSpoolLease,
      check: checkReviewSpoolLease,
    },
  };
}

async function runCheckoutEviction(
  deps: ReviewWorkerDeps,
  lease: ReviewSpoolLeaseHandle,
  protect: readonly ReviewCheckoutKey[]
): Promise<void> {
  if (!deps.evictCheckouts) return;
  try {
    await deps.evictCheckouts({ protect, lease });
  } catch (error) {
    log.error({ err: error }, 'overseer_review_checkout_eviction_failed');
  }
}

export async function tickReviewWorkerClock(
  config: ReviewRouteConfig,
  deps: ReviewWorkerDeps
): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  // SINGLE WRITER (WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01). One review
  // worker owns the spool for a whole tick through a fenced database lease:
  // claiming, preparing and evicting checkouts all happen under it, so a second
  // worker on the same spool waits for its next tick instead of racing an
  // eviction against a claim.
  const spoolKey = deps.spoolKey ?? resolveReviewSpoolKey();
  let lease: ReviewSpoolLeaseHandle | null;
  try {
    lease = await acquireReviewSpoolLeaseHandle(deps.spoolLease, spoolKey);
  } catch (error) {
    log.error({ err: error, spoolKey }, 'overseer_review_worker_spool_lease_failed');
    inFlight = false;
    return;
  }
  if (!lease) {
    log.info({ spoolKey }, 'overseer_review_worker_spool_busy');
    inFlight = false;
    return;
  }
  try {
    await deps.registerWorker({
      worker_id: REVIEW_WORKER_ID,
      host: process.env.HOSTNAME ?? 'in-process',
      capabilities: { task_types: [REVIEW_TASK_TYPE], principal: REVIEW_RECIPIENT },
      max_concurrency: 1,
    });
    await deps.heartbeatWorker({ worker_id: REVIEW_WORKER_ID, status: 'available' });

    // listMessages has no task_type filter. Restrict the recipient in SQL and
    // then filter its generic dispatch queue locally before claiming.
    const messages = (
      await deps.listMessages({ recipient: REVIEW_RECIPIENT, status: 'queued' })
    ).filter(message => message.task_type === REVIEW_TASK_TYPE);

    for (const message of messages) {
      // Never claim more work once the spool lease is no longer ours.
      if (!(await lease.held())) {
        log.warn({ spoolKey }, 'overseer_review_worker_spool_lease_lost');
        break;
      }
      try {
        const claimed = await deps.claimMessage({ id: message.id, worker_id: REVIEW_WORKER_ID });
        if (!claimed) continue;
        const body = parseReviewWorkBody(claimed.body);
        if (!body) {
          // Permanent input failure: retire through the existing fenced result
          // path. Never construct a reviewer or apply an override for bad work.
          const rejected = await deps.postResult({
            id: claimed.id,
            worker_id: REVIEW_WORKER_ID,
            fencing_token: claimed.fencing_token,
            status: 'failed',
            task_outcome: 'blocked',
            result_body: JSON.stringify({ reason: 'invalid_review_work_body' }),
          });
          log.warn(
            { messageId: claimed.id, terminalized: rejected !== null },
            rejected === null
              ? 'overseer_review_invalid_body_fence_conflict'
              : 'overseer_review_invalid_body_blocked'
          );
          continue;
        }
        // SUPERSEDE AT CLAIM (WO-HARNESS-OVERSEER-RECHECK-DEDUPE-PER-HEAD-01):
        // this review reads the head's checks NOW, so queued reviews of the same
        // head inserted before this claim (seq <= the claim's boundary) are
        // redundant and never run. Rows inserted after the claim (a check that
        // completes while this review runs) survive. Fails open: the claimed
        // review always runs.
        await supersedeQueuedDuplicateReviews(deps, claimed, body);
        // OPERATOR OVERRIDE (#847): a hand-enqueued run_review whose
        // repeat_reason starts with `operator_request:ladder_restored` clears
        // the judge-ladder breaker before the judge runs; the recovery pass at
        // the end of this tick then re-enqueues every parked head.
        if (applyLadderRestoredRequest(claimed.repeat_reason)) {
          log.info({ messageId: claimed.id }, 'overseer_review_judge_ladder_restored_by_operator');
        }
        // S1/S6: a checkout that cannot be prepared or verified becomes a
        // review_incomplete COMMENT, never a silently stuck claim and never an
        // approval. The reason travels in the server-built execution context.
        let checkoutPath = '';
        let checkoutFailure: string | undefined;
        let checkoutStep: string | undefined;
        // Make room before materializing a new checkout; the head about to be
        // prepared is protected even if it is already cached and over cap.
        await runCheckoutEviction(deps, lease, [
          { owner: body.owner, repo: body.repo, headSha: body.headSha },
        ]);
        try {
          checkoutPath = deps.prepareCheckout
            ? await deps.prepareCheckout(await captureReviewBase(body, deps))
            : resolveTrustedCheckoutPath(body.owner, body.repo, body.headSha);
          if (!checkoutPath) checkoutFailure = 'review_checkout_root_unconfigured';
        } catch (error) {
          checkoutPath = '';
          checkoutFailure = classifyCheckoutFailure(error);
          checkoutStep = checkoutDiagnostic(error).step;
          (deps.logger ?? log).warn(
            {
              messageId: claimed.id,
              reason: checkoutFailure,
              repository: `${body.owner}/${body.repo}`,
              prNumber: body.prNumber,
              headSha: body.headSha,
              baseSha:
                error instanceof Error && error.cause && typeof error.cause === 'object'
                  ? ((error.cause as CheckoutDiagnostic).baseSha ?? body.baseSha)
                  : body.baseSha,
              ...checkoutDiagnostic(error),
            },
            'overseer_review_checkout_preparation_failed'
          );
        }
        const checkPlan: TrustedCheckPlan = checkoutFailure
          ? { status: 'unsafe', commands: [] }
          : await readTrustedCheckPlan(checkoutPath);
        const work: ReviewWorkItem = {
          correlationId: claimed.correlation_id,
          messageId: claimed.id,
          owner: body.owner,
          repo: body.repo,
          prNumber: body.prNumber,
          headSha: body.headSha,
          author: body.author,
          executionContext: Object.freeze({
            requestId: claimed.id,
            workerId: REVIEW_WORKER_ID,
            fencingToken: claimed.fencing_token,
            owner: body.owner,
            repo: body.repo,
            prNumber: body.prNumber,
            headSha: body.headSha,
            checkoutPath,
            reviewerIdentity: config.reviewerIdentity,
            rung: 'pr-review',
            checkPlanStatus: checkPlan.status,
            checkPlan: Object.freeze(checkPlan.commands),
            ...(checkoutFailure ? { checkoutFailure } : {}),
          }),
        };
        const renew = deps.renewMessageLease;
        const leaseTimer = renew
          ? setInterval(() => {
              void renew({
                id: claimed.id,
                worker_id: REVIEW_WORKER_ID,
                fencing_token: claimed.fencing_token,
              });
            }, 30_000)
          : undefined;
        let outcome: SubmitOutcome;
        try {
          outcome = await deps.runAndSubmitReview(
            work,
            deps.createSubmitDeps(config.reviewerIdentity)
          );
        } finally {
          if (leaseTimer) clearInterval(leaseTimer);
        }
        // CHECKS PENDING is the ONLY non-terminal disposition: the bound head is
        // still live and CI on it has simply not concluded, so releasing the
        // claim with a backoff retries the SAME head productively.
        //
        // `superseded_head` is deliberately NOT released here. Its bound head is
        // dead, the payload still names that dead SHA, and a release would spin
        // the item forever -- see mapSubmitOutcome for the full reasoning.
        if (outcome.disposition === 'checks_pending') {
          // WO-HARNESS-OVERSEER-REVIEW-CHECK-DEFERRAL-01 Section 7 names this
          // transition `deferMessage`; it is the same fenced claimed->queued
          // transition, called by its WO name.
          const deferUntil = new Date(Date.now() + CHECKS_PENDING_BACKOFF_MS).toISOString();
          const pendingChecks = outcome.pendingChecks ?? [];
          (deps.logger ?? log).warn(
            {
              messageId: claimed.id,
              owner: work.owner,
              repo: work.repo,
              prNumber: work.prNumber,
              headSha: work.headSha,
              defer_until: deferUntil,
              pending_checks: pendingChecks,
              ...(outcome.pendingChecks === undefined ? { reason: 'no_checks_reported' } : {}),
            },
            'overseer_review_checks_pending_deferred'
          );
          await deps.deferMessage({
            id: claimed.id,
            worker_id: REVIEW_WORKER_ID,
            fencing_token: claimed.fencing_token,
            defer_until: deferUntil,
          });
          continue;
        }
        // RATE LIMITED (#782 part 2) is non-terminal for the same reason, but
        // its backoff comes from GitHub's own reset clock rather than a fixed
        // interval: retrying before the budget refills would just burn another
        // request and re-defer (#774's spin). A response with no usable clock
        // falls back to the checks-pending interval so the wait is always
        // finite.
        if (outcome.disposition === 'rate_limited') {
          const deferUntil =
            outcome.retryAfter ??
            new Date(
              Date.now() + (outcome.retryAfterMs ?? CHECKS_PENDING_BACKOFF_MS)
            ).toISOString();
          log.warn(
            { messageId: claimed.id, reason: outcome.reason, deferUntil },
            'overseer_review_rate_limited_deferred'
          );
          await deps.deferMessage({
            id: claimed.id,
            worker_id: REVIEW_WORKER_ID,
            fencing_token: claimed.fencing_token,
            defer_until: deferUntil,
          });
          continue;
        }
        // TRANSPORT ERROR (#789) is non-terminal for the same reason: the judge
        // process was never reached, so nothing about the code was evaluated.
        // Terminating here would post CHANGES_REQUESTED for a review that never
        // ran -- the bug this fixes. The backoff comes from the evaluator so a
        // persistent spawn failure cannot spin the worker every tick.
        if (outcome.disposition === 'transport_error') {
          log.warn(
            { messageId: claimed.id, reason: outcome.reason },
            'overseer_review_transport_error_deferred'
          );
          await deps.releaseMessage({
            id: claimed.id,
            worker_id: REVIEW_WORKER_ID,
            fencing_token: claimed.fencing_token,
            not_before: new Date(
              Date.now() + (outcome.retryAfterMs ?? CHECKS_PENDING_BACKOFF_MS)
            ).toISOString(),
          });
          continue;
        }
        const result = mapSubmitOutcome(outcome.disposition);
        await deps.postResult({
          id: claimed.id,
          worker_id: REVIEW_WORKER_ID,
          fencing_token: claimed.fencing_token,
          ...result,
          result_body: JSON.stringify({
            ...outcome,
            ...(checkoutFailure && checkoutStep && outcome.disposition === 'review_incomplete'
              ? { checkout_step: checkoutStep }
              : {}),
          }),
        });
      } catch (error) {
        log.error({ err: error, messageId: message.id }, 'overseer_review_work_item_failed');
      }
    }

    // STALE-VERDICT SWEEP (#782 part 3). Runs AFTER the queue is drained so a
    // sweep-enqueued re-review is picked up on the NEXT tick rather than
    // extending this one, and so a sweep failure can never delay the primary
    // review path. It is internally bounded and never throws.
    if (deps.staleVerdictSweep) {
      try {
        await deps.staleVerdictSweep(config);
      } catch (error) {
        log.error({ err: error }, 'overseer_stale_verdict_sweep_failed');
      }
    }

    // JUDGE LADDER RECOVERY (#847). Also after the drain: a head re-enqueued
    // here is claimed on the NEXT tick, and a failure here never delays the
    // primary review path. The pass is a no-op while any rung's outage record
    // is still in force.
    if (deps.judgeLadderRecovery) {
      try {
        await deps.judgeLadderRecovery(config);
      } catch (error) {
        log.error({ err: error }, 'overseer_judge_ladder_recovery_failed');
      }
    }

    // CHECKOUT CACHE EVICTION. After the drain, so nothing this tick is still
    // using a checkout; in-flight claims elsewhere are protected by the pass.
    await runCheckoutEviction(deps, lease, []);
  } catch (error) {
    log.error({ err: error }, 'overseer_review_worker_tick_failed');
  } finally {
    await lease.release();
    inFlight = false;
  }
}

let warnedNoClaimBoundary = false;

/**
 * Mark every OTHER queued run_review for the claimed row's owner/repo/PR/head
 * that was inserted before the claim as superseded, with the reason
 * `superseded_by_claim <claimed row id>`.
 *
 * "Before the claim" is the database order, never a clock: a row qualifies only
 * when its own `seq` is set and <= `claimBoundarySeq`, the MAX(seq) read inside
 * the claim transaction (see ClaimedDispatchMessage). created_at is not used --
 * client clocks are monotonic only within one process, so a row enqueued by
 * another writer after the claim can carry an earlier created_at. A NULL-seq
 * row is never superseded. A claim with no boundary skips superseding (logged
 * once per process). Never throws: any failure is logged and the claimed
 * review proceeds. Operator-requested rows (`repeat_reason` starting
 * `operator_request:`) are never superseded, so an operator override is not
 * lost.
 */
async function supersedeQueuedDuplicateReviews(
  deps: ReviewWorkerDeps,
  claimed: ClaimedDispatchMessage,
  body: { owner: string; repo: string; prNumber: number; headSha: string }
): Promise<void> {
  if (!deps.listQueuedReviews || !deps.supersedeQueuedReview) return;
  const logger = deps.logger ?? log;
  const context = {
    messageId: claimed.id,
    owner: body.owner,
    repo: body.repo,
    prNumber: body.prNumber,
    headSha: body.headSha,
  };
  const boundary = claimed.claimBoundarySeq;
  if (typeof boundary !== 'number' || !Number.isFinite(boundary)) {
    if (!warnedNoClaimBoundary) {
      warnedNoClaimBoundary = true;
      logger.warn(context, 'overseer.pr_review.supersede_skipped_no_claim_boundary');
    }
    return;
  }
  const reason = `superseded_by_claim ${claimed.id}`;
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const superseded: string[] = [];
  try {
    let afterSeq: number | undefined;
    for (let page = 0; page < REVIEW_CHECKOUT_CLAIM_MAX_PAGES; page += 1) {
      const rows = await deps.listQueuedReviews({
        recipient: REVIEW_RECIPIENT,
        task_type: REVIEW_TASK_TYPE,
        status: 'queued',
        ...(afterSeq === undefined ? {} : { afterSeq }),
        limit: REVIEW_CHECKOUT_CLAIM_PAGE_SIZE,
      });
      for (const row of rows) {
        if (row.id === claimed.id || row.status !== 'queued') continue;
        if (row.task_type !== REVIEW_TASK_TYPE) continue;
        if (row.repeat_reason?.startsWith('operator_request:')) continue;
        if (typeof row.seq !== 'number' || !Number.isFinite(row.seq) || row.seq > boundary) {
          continue;
        }
        const other = parseReviewWorkBody(row.body);
        if (
          other?.prNumber !== body.prNumber ||
          !same(other.owner, body.owner) ||
          !same(other.repo, body.repo) ||
          !same(other.headSha, body.headSha)
        ) {
          continue;
        }
        try {
          const retired = await deps.supersedeQueuedReview({
            id: row.id,
            claimed_id: claimed.id,
            boundary_seq: boundary,
            reason,
          });
          if (retired) superseded.push(row.id);
        } catch (error) {
          logger.warn(
            {
              ...context,
              supersedeId: row.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'overseer.pr_review.supersede_failed'
          );
        }
      }
      if (rows.length < REVIEW_CHECKOUT_CLAIM_PAGE_SIZE) break;
      afterSeq = rows[rows.length - 1]?.cursor_seq;
      if (afterSeq === undefined) break;
    }
  } catch (error) {
    logger.warn(
      { ...context, error: error instanceof Error ? error.message : String(error) },
      'overseer.pr_review.supersede_failed'
    );
  }
  if (superseded.length > 0) {
    log.info({ ...context, reason, superseded }, 'overseer.pr_review.superseded_by_claim');
  }
}

function resolveReviewSpoolKey(): string {
  return `review-spool:${resolveReviewCheckoutRoot()}`;
}

/**
 * Lease time-to-live. A tick can drain several reviews of up to 30 minutes
 * each, so the lease is RENEWED every REVIEW_SPOOL_LEASE_RENEW_MS while the
 * tick runs; the TTL only bounds how long a crashed holder blocks the spool.
 */
export const REVIEW_SPOOL_LEASE_TTL_SECONDS = 600;
export const REVIEW_SPOOL_LEASE_RENEW_MS = 60_000;

/** The database lease operations (packages/core/src/db/review-spool-leases.ts). */
export interface ReviewSpoolLeaseStore {
  acquire: typeof acquireReviewSpoolLease;
  renew: typeof renewReviewSpoolLease;
  release: typeof releaseReviewSpoolLease;
  check: typeof checkReviewSpoolLease;
}

/**
 * The review spool's single-writer lease (WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01).
 *
 * Held for a whole review tick. `held()` asks the DATABASE whether this
 * holder and fencing token still hold a live lease; checkout eviction calls it
 * before every directory delete, so eviction cannot run outside a tick or
 * after another worker took the spool over.
 */
export interface ReviewSpoolLeaseHandle {
  readonly spoolKey: string;
  readonly holderId: string;
  readonly fencingToken: number;
  held(): Promise<boolean>;
  release(): Promise<void>;
}

export async function acquireReviewSpoolLeaseHandle(
  store: ReviewSpoolLeaseStore,
  spoolKey: string,
  options: { ttlSeconds?: number; renewMs?: number } = {}
): Promise<ReviewSpoolLeaseHandle | null> {
  const ttlSeconds = options.ttlSeconds ?? REVIEW_SPOOL_LEASE_TTL_SECONDS;
  const holderId = `${process.env.HOSTNAME ?? 'in-process'}:${process.pid}:${randomUUID()}`;
  const acquired = await store.acquire({
    spool_key: spoolKey,
    holder_id: holderId,
    ttl_seconds: ttlSeconds,
  });
  if (!acquired) return null;
  const identity = {
    spool_key: spoolKey,
    holder_id: holderId,
    fencing_token: acquired.fencing_token,
  };
  let lost = false;
  const renew = setInterval(() => {
    void store
      .renew(identity, ttlSeconds)
      .then(renewed => {
        if (renewed || lost) return;
        lost = true;
        log.warn(
          { spoolKey, fencingToken: identity.fencing_token },
          'overseer_review_worker_spool_lease_lost'
        );
      })
      .catch((error: unknown) => {
        log.warn(
          { spoolKey, error: error instanceof Error ? error.message : String(error) },
          'overseer_review_worker_spool_lease_renew_failed'
        );
      });
  }, options.renewMs ?? REVIEW_SPOOL_LEASE_RENEW_MS);
  renew.unref?.();
  return {
    spoolKey,
    holderId,
    fencingToken: identity.fencing_token,
    held: async (): Promise<boolean> => {
      if (lost) return false;
      try {
        return await store.check(identity);
      } catch {
        return false; // doubt is not ownership
      }
    },
    release: async (): Promise<void> => {
      clearInterval(renew);
      try {
        await store.release(identity);
      } catch (error) {
        // An unreleased lease expires on its own after the TTL.
        log.warn(
          { spoolKey, error: error instanceof Error ? error.message : String(error) },
          'overseer_review_worker_spool_lease_release_failed'
        );
      }
    },
  };
}

function resolveReviewCheckoutRoot(): string {
  const spool = process.env.OVERSEER_REVIEW_SPOOL?.trim() || '/var/lib/overseer-review';
  return process.env.OVERSEER_REVIEW_CHECKOUT_ROOT?.trim() || join(spool, 'checkouts');
}

function resolveTrustedCheckoutPath(
  owner: string,
  repo: string,
  headSha: string,
  checkoutRoot?: string
): string {
  const root = checkoutRoot ?? resolveReviewCheckoutRoot();
  if (!/^[0-9a-f]{40}$/i.test(headSha)) return '';
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${root}/${safe(owner)}/${safe(repo)}/${headSha}`;
}

export async function runCheckoutGit(
  argv: string[],
  cwd: string,
  options: { trim?: boolean; step?: string } = {}
): Promise<string> {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  // core.longpaths: a review checkout's pack files sit at
  // <root>/<owner>/<repo>/<40-hex>/.git/objects/pack/pack-<40-hex>.promisor,
  // which passes Windows' 260-character limit under a long temp root
  // (windows-latest CI: "cannot write promisor file ... Filename too long").
  // Git for Windows honours it; other platforms ignore it. Passed through
  // GIT_CONFIG_* so the child processes git starts (index-pack on a lazy
  // promisor fetch) inherit it, and the sanitized env still needs no global
  // gitconfig. bdc-xo #4569.
  const config: [string, string][] = [['core.longpaths', 'true']];
  if (token) {
    config.push([
      'http.https://github.com/.extraheader',
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    ]);
  }
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  const child = Bun.spawn(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const detail = {
      step: options.step ?? argv[1] ?? 'git',
      gitExitCode: exitCode,
      stderr: redactCheckoutStderr(stderr),
    };
    throw new Error(`review_checkout_git_failed:${detail.stderr}`, { cause: detail });
  }
  return options.trim === false ? stdout : stdout.trim();
}

const CHECKOUT_IDENTITY_FAILURE = 'review_checkout_identity_failure';
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function classifyCheckoutFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('review_checkout_git_failed')) return CHECKOUT_IDENTITY_FAILURE;
  const code = /^review_checkout_[a-z_]+/.exec(message)?.[0];
  return code ?? CHECKOUT_IDENTITY_FAILURE;
}

interface ReviewCheckoutInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
  baseSha: string;
}

async function captureReviewBase(
  body: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    baseRef: string;
    baseSha?: string;
  },
  deps: Pick<ReviewWorkerDeps, 'resolveReviewBase'>
): Promise<ReviewCheckoutInput> {
  let baseRef = body.baseRef;
  let baseSha = body.baseSha ?? '';
  if (!SHA_PATTERN.test(baseSha)) {
    if (!deps.resolveReviewBase) throw new Error('review_checkout_base_identity_missing');
    const live = await deps.resolveReviewBase({
      owner: body.owner,
      repo: body.repo,
      prNumber: body.prNumber,
    });
    baseSha = live.baseSha;
    baseRef = baseRef || live.baseRef;
  }
  return {
    owner: body.owner,
    repo: body.repo,
    prNumber: body.prNumber,
    headSha: body.headSha,
    baseRef,
    baseSha,
  };
}

async function resolveLiveReviewBase(input: {
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<{ baseRef: string; baseSha: string }> {
  const pr = await createRealOctokitClient().pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
  });
  const baseSha = pr.data.base?.sha ?? '';
  if (!SHA_PATTERN.test(baseSha)) throw new Error('review_checkout_base_identity_missing');
  return { baseRef: pr.data.base?.ref ?? '', baseSha };
}

/** Paths Git records as executable (mode 100755), relative and '/'-separated. */
async function readTrackedExecutables(checkout: string): Promise<Set<string>> {
  const listing = await runCheckoutGit(['git', 'ls-files', '--stage', '-z'], checkout, {
    trim: false,
  });
  const executables = new Set<string>();
  for (const record of listing.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    if (record.startsWith('100755 ')) executables.add(record.slice(tab + 1));
  }
  return executables;
}

/**
 * Seal without following checkout-controlled symlinks (S2). Tracked 100755
 * files become 0750, every other regular file 0640, directories 0750, so the
 * `reviewer` group can read (and execute what Git records as executable) but
 * modify nothing, and Git's core.filemode comparison still matches HEAD.
 */
export async function sealReviewCheckout(
  path: string,
  executables: ReadonlySet<string> = new Set()
): Promise<void> {
  await sealDirectory(path, '', executables);
}

async function sealDirectory(
  path: string,
  relative: string,
  executables: ReadonlySet<string>
): Promise<void> {
  const directory = await opendir(path);
  for await (const entry of directory) {
    const child = join(path, entry.name);
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const info = await lstat(child);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) await sealDirectory(child, childRelative, executables);
    else if (info.isFile()) await chmod(child, executables.has(childRelative) ? 0o750 : 0o640);
  }
  await chmod(path, 0o750);
}

/** Pristine: HEAD and tree bound to H, base B present, no mode, content or untracked drift. */
async function verifySealedCheckout(
  checkout: string,
  headSha: string,
  baseSha: string
): Promise<void> {
  const head = await runCheckoutGit(['git', 'rev-parse', 'HEAD'], checkout, {
    step: 'verify-head',
  });
  const tree = await runCheckoutGit(['git', 'rev-parse', 'HEAD^{tree}'], checkout, {
    step: 'verify-tree',
  });
  const expectedTree = await runCheckoutGit(['git', 'rev-parse', `${headSha}^{tree}`], checkout, {
    step: 'verify-tree',
  });
  if (head !== headSha || tree !== expectedTree)
    throw new Error(CHECKOUT_IDENTITY_FAILURE, {
      cause: {
        step: head !== headSha ? 'verify-head' : 'verify-tree',
        gitExitCode: null,
        stderr: '',
      },
    });
  await runCheckoutGit(['git', 'cat-file', '-e', `${baseSha}^{commit}`], checkout, {
    step: 'cat-file-base',
  });
  await runCheckoutGit(['git', '-c', 'core.filemode=true', 'diff', '--quiet', 'HEAD'], checkout, {
    step: 'verify-clean',
  });
  const status = await runCheckoutGit(
    ['git', '-c', 'core.filemode=true', 'status', '--porcelain=v1', '--untracked-files=all'],
    checkout,
    { step: 'verify-clean' }
  );
  if (status.length > 0)
    throw new Error(CHECKOUT_IDENTITY_FAILURE, {
      cause: { step: 'verify-clean', gitExitCode: null, stderr: '' },
    });
}

export interface PrepareReviewCheckoutOptions {
  /** Remote to fetch object ids from. Defaults to the GitHub repository URL. */
  remoteUrl?: string;
  /** Root for exact-head checkouts. Defaults to the broker spool checkouts dir. */
  checkoutRoot?: string;
}

/**
 * Materialize an immutable exact-head checkout with its captured base commit
 * (S1). Both commits are fetched BY OBJECT ID: the moving base branch tip is
 * never consulted, so a base branch that advanced after the review was queued
 * cannot fail a pristine head, and an object that cannot be fetched or
 * verified fails closed with review_checkout_identity_failure.
 */
export async function prepareReviewCheckout(
  input: ReviewCheckoutInput,
  options: PrepareReviewCheckoutOptions = {}
): Promise<string> {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(input.owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(input.repo) ||
    !Number.isSafeInteger(input.prNumber) ||
    input.prNumber < 1 ||
    !SHA_PATTERN.test(input.headSha)
  ) {
    throw new Error('review_checkout_identity_invalid');
  }
  if (!SHA_PATTERN.test(input.baseSha)) throw new Error('review_checkout_base_identity_missing');
  const headSha = input.headSha.toLowerCase();
  const baseSha = input.baseSha.toLowerCase();
  const checkout = resolveTrustedCheckoutPath(
    input.owner,
    input.repo,
    headSha,
    options.checkoutRoot
  );
  if (!checkout) throw new Error('review_checkout_root_unconfigured');
  try {
    // Cached checkout: re-seal from Git's own modes, then re-verify. Any
    // drift (mode, content, untracked file, missing base) discards it.
    await sealReviewCheckout(checkout, await readTrackedExecutables(checkout));
    await verifySealedCheckout(checkout, headSha, baseSha);
    await recordCheckoutUse(checkout, input.prNumber);
    return await realpath(checkout);
  } catch {
    // Missing or stale paths are replaced atomically below.
  }
  const temporary = `${checkout}.tmp-${randomUUID()}`;
  await mkdir(dirname(checkout), { recursive: true, mode: 0o2770 });
  await rm(temporary, { recursive: true, force: true });
  let preparationStep = 'mkdir';
  try {
    await mkdir(temporary, { mode: 0o700 });
    await runCheckoutGit(['git', 'init', '--quiet'], temporary);
    const remote = options.remoteUrl ?? `https://github.com/${input.owner}/${input.repo}.git`;
    // A NAMED remote: a partial (--filter) fetch records it as the promisor
    // that later checkout and diff steps lazily fetch missing blobs from. The
    // credential stays in runCheckoutGit's env and is never written to config.
    await runCheckoutGit(['git', 'remote', 'add', 'origin', remote], temporary);
    const sparseExcludes = resolveSparseExcludes(input.owner, input.repo);
    if (sparseExcludes.length > 0) {
      // Non-cone sparse-checkout, set BEFORE checkout so excluded blobs are
      // never fetched or written. Tree identity is unchanged, so
      // verifySealedCheckout still binds HEAD and its tree to headSha.
      await runCheckoutGit(
        [
          'git',
          'sparse-checkout',
          'set',
          '--no-cone',
          '/*',
          ...sparseExcludes.map(path => `!/${path}/`),
        ],
        temporary
      );
    }
    try {
      await runCheckoutGit(
        [
          'git',
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-write-fetch-head',
          '--depth',
          '1',
          '--filter=blob:none',
          'origin',
          headSha,
          baseSha,
        ],
        temporary
      );
      await runCheckoutGit(['git', 'cat-file', '-e', `${headSha}^{commit}`], temporary, {
        step: 'cat-file-head',
      });
      await runCheckoutGit(['git', 'cat-file', '-e', `${baseSha}^{commit}`], temporary, {
        step: 'cat-file-base',
      });
    } catch (error) {
      throw new Error(CHECKOUT_IDENTITY_FAILURE, { cause: checkoutDiagnostic(error) });
    }
    await runCheckoutGit(['git', 'checkout', '--quiet', '--detach', headSha], temporary);
    // Prefetch both sides of the base..head diff now, while the parent holds
    // the credential, so the reviewer's `git diff <base> <head>` never needs
    // the network.
    await runCheckoutGit(['git', 'diff', '--stat', baseSha, headSha], temporary, {
      step: 'prefetch-diff',
    });
    preparationStep = 'seal';
    await sealReviewCheckout(temporary, await readTrackedExecutables(temporary));
    await verifySealedCheckout(temporary, headSha, baseSha);
    preparationStep = 'replace-checkout';
    await rm(checkout, { recursive: true, force: true });
    await rename(temporary, checkout);
    preparationStep = 'record-use';
    await recordCheckoutUse(checkout, input.prNumber);
    preparationStep = 'realpath';
    return await realpath(checkout);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw new Error(
      error instanceof Error ? redactCheckoutStderr(error.message) : CHECKOUT_IDENTITY_FAILURE,
      {
        cause: {
          repository: `${input.owner}/${input.repo}`,
          prNumber: input.prNumber,
          headSha,
          baseSha,
          ...checkoutDiagnostic(error),
          step: checkoutDiagnostic(error).step ?? preparationStep,
          gitExitCode: checkoutDiagnostic(error).gitExitCode ?? null,
        },
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Review checkout cache (WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01). See the
// file header for the env vars and log lines.
// ---------------------------------------------------------------------------

export const DEFAULT_REVIEW_CHECKOUT_CACHE_MAX_BYTES = 3 * 1024 * 1024 * 1024;
export const DEFAULT_REVIEW_SPARSE_EXCLUDES = 'thinmansoftware/bdc-xo:generations/';
const REVIEW_CHECKOUT_KEEP_PER_REPO = 2;
const DEFAULT_REVIEW_CHECKOUT_STATE_SWEEP_MS = 15 * 60_000;
const CACHE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const CACHED_HEAD_PATTERN = /^[0-9a-f]{40}$/;
const SPARSE_PATH_PATTERN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

export function resolveReviewCheckoutCacheMaxBytes(
  raw: string | undefined = process.env.OVERSEER_REVIEW_CHECKOUT_CACHE_MAX_BYTES
): number {
  const value = Number(raw?.trim());
  return raw?.trim() && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_REVIEW_CHECKOUT_CACHE_MAX_BYTES;
}

/**
 * Repo-relative directories left out of a review checkout for owner/repo, from
 * `owner/repo:path` entries. Invalid paths (absolute, `..`, glob characters)
 * are ignored so an exclude can never widen into a broader pattern.
 */
export function resolveSparseExcludes(
  owner: string,
  repo: string,
  raw: string = process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES ?? DEFAULT_REVIEW_SPARSE_EXCLUDES
): string[] {
  const target = `${owner}/${repo}`.toLowerCase();
  const paths: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    if (trimmed.slice(0, colon).toLowerCase() !== target) continue;
    const path = trimmed.slice(colon + 1).replace(/^\/+|\/+$/g, '');
    if (!SPARSE_PATH_PATTERN.test(path)) continue;
    if (path.split('/').some(segment => segment === '.' || segment === '..')) continue;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

export interface ReviewCheckoutKey {
  owner: string;
  repo: string;
  headSha: string;
}

function checkoutKey(key: ReviewCheckoutKey): string {
  return `${key.owner}/${key.repo}/${key.headSha}`.toLowerCase();
}

export type ReviewCheckoutPrState =
  | { state: 'open'; headSha: string }
  | { state: 'merged' }
  | { state: 'closed' }
  | { state: 'unknown'; reason: string };

export type ReviewCheckoutPrLookup = (
  input: ReviewCheckoutKey & { prNumber?: number }
) => Promise<ReviewCheckoutPrState>;

export type ReviewCheckoutEvictionReason = 'merged' | 'closed' | 'superseded' | 'cap';

export interface ReviewCheckoutCacheLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

export interface CachedReviewCheckout extends ReviewCheckoutKey {
  path: string;
  bytes: number;
  lastUsedMs: number;
  prNumber?: number;
}

export interface ReviewCheckoutEvictionResult {
  evicted: (ReviewCheckoutKey & { reason: ReviewCheckoutEvictionReason; bytes: number })[];
  freedBytes: number;
  totalBytes: number;
  overCap: boolean;
  /** True when the pass stopped early because `beforeDelete` refused a delete. */
  stopped: boolean;
}

/**
 * Last use = directory mtime, set on creation and every reuse. The mtime of
 * the checkout ROOT only; nothing is written inside the sealed tree, so the
 * pristine (no untracked file) contract is unaffected.
 */
async function recordCheckoutUse(checkout: string, prNumber: number): Promise<void> {
  try {
    const now = new Date();
    await utimes(checkout, now, now);
    // Sibling marker `<headSha>.pr`, OUTSIDE the checkout: lets the eviction
    // pass read the PR by number instead of by commit association.
    await writeFile(`${checkout}.pr`, `${prNumber}\n`, { mode: 0o640 });
  } catch (error) {
    log.warn({ err: error, checkout }, 'overseer_review_checkout_use_record_failed');
  }
}

async function listDirectoryNames(path: string): Promise<string[]> {
  try {
    // Sorted: readdir order is filesystem-dependent; passes must be deterministic.
    return (await readdir(path)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Sealed checkouts are immutable, so a size is cached per path and inode. */
const checkoutSizeCache = new Map<string, { ino: number; bytes: number }>();

async function treeBytes(path: string): Promise<number> {
  let total = 0;
  const directory = await opendir(path);
  for await (const entry of directory) {
    const child = join(path, entry.name);
    const info = await lstat(child);
    if (info.isDirectory() && !info.isSymbolicLink()) total += await treeBytes(child);
    else total += info.size;
  }
  return total;
}

async function readPrMarker(path: string): Promise<number | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 32) return undefined;
    const value = Number((await readFile(path, 'utf8')).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cached checkouts are EXACTLY `<root>/<owner>/<repo>/<40 lowercase hex>`
 * real directories. Symlinks, `*.tmp-*` builds in progress, markers and
 * anything else are never returned, so they are never sized or deleted.
 */
export async function listCachedReviewCheckouts(root: string): Promise<CachedReviewCheckout[]> {
  const found: CachedReviewCheckout[] = [];
  for (const owner of await listDirectoryNames(root)) {
    if (!CACHE_NAME_PATTERN.test(owner) || owner === '.' || owner === '..') continue;
    const ownerPath = join(root, owner);
    if (!(await isRealDirectory(ownerPath))) continue;
    for (const repo of await listDirectoryNames(ownerPath)) {
      if (!CACHE_NAME_PATTERN.test(repo) || repo === '.' || repo === '..') continue;
      const repoPath = join(ownerPath, repo);
      if (!(await isRealDirectory(repoPath))) continue;
      for (const name of await listDirectoryNames(repoPath)) {
        if (!CACHED_HEAD_PATTERN.test(name)) continue;
        const path = join(repoPath, name);
        let info;
        try {
          info = await lstat(path);
        } catch {
          continue;
        }
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        let bytes: number;
        const known = checkoutSizeCache.get(path);
        if (known?.ino === info.ino) bytes = known.bytes;
        else {
          try {
            bytes = await treeBytes(path);
          } catch {
            continue;
          }
          checkoutSizeCache.set(path, { ino: info.ino, bytes });
        }
        const prNumber = await readPrMarker(`${path}.pr`);
        found.push({
          owner,
          repo,
          headSha: name,
          path,
          bytes,
          lastUsedMs: info.mtimeMs,
          ...(prNumber ? { prNumber } : {}),
        });
      }
    }
  }
  return found;
}

async function removeCachedCheckout(root: string, checkout: CachedReviewCheckout): Promise<void> {
  // Recompute the path from validated parts; never trust a stored string.
  if (
    !CACHE_NAME_PATTERN.test(checkout.owner) ||
    !CACHE_NAME_PATTERN.test(checkout.repo) ||
    !CACHED_HEAD_PATTERN.test(checkout.headSha)
  ) {
    throw new Error('review_checkout_evict_refused');
  }
  const path = join(root, checkout.owner, checkout.repo, checkout.headSha);
  if (path !== checkout.path || !(await isRealDirectory(path))) {
    throw new Error('review_checkout_evict_refused');
  }
  await rm(path, { recursive: true, force: true });
  await rm(`${path}.pr`, { force: true });
  checkoutSizeCache.delete(path);
}

export interface EvictReviewCheckoutsOptions {
  checkoutRoot: string;
  maxBytes: number;
  /** Checkouts that must never be evicted (in-flight reviews, the head being prepared). */
  inUse: readonly ReviewCheckoutKey[];
  /** Absent = cap-only pass (no merged/closed/superseded phase). */
  lookupPrState?: ReviewCheckoutPrLookup;
  logger?: ReviewCheckoutCacheLogger;
  keepPerRepo?: number;
  /**
   * Called immediately before EVERY directory delete (the review tick passes
   * its spool lease check). False or a throw stops the whole pass: nothing
   * more is deleted.
   */
  beforeDelete?: () => Promise<boolean>;
}

export async function evictReviewCheckouts(
  options: EvictReviewCheckoutsOptions
): Promise<ReviewCheckoutEvictionResult> {
  const logger = options.logger ?? log;
  const keepPerRepo = options.keepPerRepo ?? REVIEW_CHECKOUT_KEEP_PER_REPO;
  const inUse = new Set<string>(options.inUse.map(checkoutKey));
  const evicted: ReviewCheckoutEvictionResult['evicted'] = [];
  let stopped = false;
  const evict = async (
    checkout: CachedReviewCheckout,
    reason: ReviewCheckoutEvictionReason
  ): Promise<boolean> => {
    if (stopped) return false;
    const identity = { owner: checkout.owner, repo: checkout.repo, headSha: checkout.headSha };
    if (options.beforeDelete) {
      let allowed = false;
      try {
        allowed = await options.beforeDelete();
      } catch {
        allowed = false;
      }
      if (!allowed) {
        stopped = true;
        logger.warn({ ...identity, reason }, 'overseer_review_checkout_eviction_stopped');
        return false;
      }
    }
    try {
      await removeCachedCheckout(options.checkoutRoot, checkout);
    } catch (error) {
      logger.warn(
        { ...identity, reason, error: error instanceof Error ? error.message : String(error) },
        'overseer_review_checkout_evict_failed'
      );
      return false;
    }
    evicted.push({ ...identity, reason, bytes: checkout.bytes });
    logger.info(
      { ...identity, reason, bytesFreed: checkout.bytes },
      'overseer_review_checkout_evicted'
    );
    return true;
  };

  let cached = await listCachedReviewCheckouts(options.checkoutRoot);

  if (options.lookupPrState) {
    const cachedKeys = new Set(cached.map(checkoutKey));
    const survivors: CachedReviewCheckout[] = [];
    for (const checkout of cached) {
      if (stopped) {
        survivors.push(checkout);
        continue;
      }
      if (inUse.has(checkoutKey(checkout))) {
        survivors.push(checkout);
        continue;
      }
      let state: ReviewCheckoutPrState;
      try {
        state = await options.lookupPrState({
          owner: checkout.owner,
          repo: checkout.repo,
          headSha: checkout.headSha,
          ...(checkout.prNumber ? { prNumber: checkout.prNumber } : {}),
        });
      } catch (error) {
        state = {
          state: 'unknown',
          reason: error instanceof Error ? error.message.slice(0, 200) : 'lookup_failed',
        };
      }
      let reason: ReviewCheckoutEvictionReason | undefined;
      if (state.state === 'merged' || state.state === 'closed') reason = state.state;
      else if (
        state.state === 'open' &&
        state.headSha.toLowerCase() !== checkout.headSha &&
        cachedKeys.has(checkoutKey({ ...checkout, headSha: state.headSha }))
      ) {
        reason = 'superseded';
      } else if (state.state === 'unknown') {
        // Doubt keeps the directory: only the cap may remove it.
        logger.warn(
          {
            owner: checkout.owner,
            repo: checkout.repo,
            headSha: checkout.headSha,
            reason: state.reason,
          },
          'overseer_review_checkout_state_unknown'
        );
      }
      if (reason && (await evict(checkout, reason))) continue;
      survivors.push(checkout);
    }
    cached = survivors;
  }

  let totalBytes = cached.reduce((sum, checkout) => sum + checkout.bytes, 0);
  if (!stopped && totalBytes > options.maxBytes) {
    const newestFloor = new Set<string>();
    const byRepo = new Map<string, CachedReviewCheckout[]>();
    for (const checkout of cached) {
      const repoKey = `${checkout.owner}/${checkout.repo}`.toLowerCase();
      byRepo.set(repoKey, [...(byRepo.get(repoKey) ?? []), checkout]);
    }
    for (const group of byRepo.values()) {
      group
        .sort((a, b) => b.lastUsedMs - a.lastUsedMs)
        .slice(0, keepPerRepo)
        .forEach(checkout => newestFloor.add(checkoutKey(checkout)));
    }
    const candidates = cached
      .filter(c => !inUse.has(checkoutKey(c)) && !newestFloor.has(checkoutKey(c)))
      .sort((a, b) => a.lastUsedMs - b.lastUsedMs || a.headSha.localeCompare(b.headSha));
    for (const checkout of candidates) {
      if (stopped || totalBytes <= options.maxBytes) break;
      if (await evict(checkout, 'cap')) totalBytes -= checkout.bytes;
    }
  }
  const overCap = totalBytes > options.maxBytes;
  if (overCap && !stopped) {
    logger.warn(
      { totalBytes, maxBytes: options.maxBytes },
      'overseer_review_checkout_cache_over_cap'
    );
  }
  const freedBytes = evicted.reduce((sum, entry) => sum + entry.bytes, 0);
  if (evicted.length > 0) {
    logger.info(
      { evicted: evicted.length, freedBytes, totalBytes },
      'overseer_review_checkout_eviction_pass'
    );
  }
  return { evicted, freedBytes, totalBytes, overCap, stopped };
}

interface AssociatedPull {
  state?: string;
  merged_at?: string | null;
  head?: { sha?: string };
}

/** PR state from `GET /repos/{o}/{r}/commits/{sha}/pulls` (legacy dirs with no marker). */
export function derivePrStateFromAssociatedPulls(
  headSha: string,
  pulls: unknown
): ReviewCheckoutPrState {
  if (!Array.isArray(pulls)) return { state: 'unknown', reason: 'lookup_malformed' };
  if (pulls.length === 0) return { state: 'unknown', reason: 'no_associated_pr' };
  const typed = pulls as AssociatedPull[];
  const open = typed.filter(pull => pull.state === 'open');
  if (open.length > 0) {
    const exact = open.find(pull => pull.head?.sha?.toLowerCase() === headSha.toLowerCase());
    const live = (exact ?? open[0]).head?.sha ?? '';
    return SHA_PATTERN.test(live)
      ? { state: 'open', headSha: live }
      : { state: 'unknown', reason: 'lookup_malformed' };
  }
  return typed.some(pull => pull.merged_at) ? { state: 'merged' } : { state: 'closed' };
}

interface OctokitRequester {
  request?: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>;
}

export function createGitHubReviewCheckoutPrLookup(
  clientFactory: () => ReturnType<typeof createRealOctokitClient> = () => createRealOctokitClient()
): ReviewCheckoutPrLookup {
  let client: ReturnType<typeof createRealOctokitClient> | undefined;
  return async ({ owner, repo, headSha, prNumber }) => {
    client ??= clientFactory();
    if (prNumber) {
      const pr = (await client.pulls.get({ owner, repo, pull_number: prNumber })).data;
      if (pr.state === 'open') {
        return SHA_PATTERN.test(pr.head?.sha ?? '')
          ? { state: 'open', headSha: pr.head.sha }
          : { state: 'unknown', reason: 'lookup_malformed' };
      }
      if (pr.state === 'closed') return pr.merged ? { state: 'merged' } : { state: 'closed' };
      return { state: 'unknown', reason: 'lookup_malformed' };
    }
    const requester = client as unknown as OctokitRequester;
    if (typeof requester.request !== 'function') {
      return { state: 'unknown', reason: 'lookup_unavailable' };
    }
    const response = await requester.request(
      'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls',
      {
        owner,
        repo,
        commit_sha: headSha,
      }
    );
    return derivePrStateFromAssociatedPulls(headSha, response.data);
  };
}

export interface ReviewCheckoutEvictorDeps {
  /**
   * Keyset reader over claimed run_review rows (listMessagesBySeqCursor). The
   * evictor walks EVERY page: a single capped read could hide a live claim
   * behind stale ones and let its checkout be deleted mid-review.
   */
  listClaimedReviews: (filters: {
    recipient: string;
    task_type: string;
    status: 'claimed';
    afterSeq?: number;
    limit: number;
  }) => Promise<SeqCursorMessage[]>;
  lookupPrState?: ReviewCheckoutPrLookup;
  checkoutRoot?: string;
  /** Defaults to OVERSEER_REVIEW_CHECKOUT_CACHE_MAX_BYTES, read on every pass. */
  maxBytes?: number;
  now?: () => number;
  stateSweepIntervalMs?: number;
  logger?: ReviewCheckoutCacheLogger;
}

/**
 * Real eviction entry point. In-use = every claimed run_review whose lease has
 * not expired, plus the caller's protected heads. If the claims cannot be read
 * the pass is SKIPPED (never evict blind). GitHub is consulted at most once
 * per state-sweep interval; other passes are cap-only.
 */
const REVIEW_CHECKOUT_CLAIM_PAGE_SIZE = 500;
/** 100 pages x 500 = 50,000 claimed rows; beyond that the pass is skipped. */
const REVIEW_CHECKOUT_CLAIM_MAX_PAGES = 100;

export function createReviewCheckoutEvictor(
  deps: ReviewCheckoutEvictorDeps
): (input: {
  protect: readonly ReviewCheckoutKey[];
  lease: ReviewSpoolLeaseHandle;
}) => Promise<ReviewCheckoutEvictionResult | null> {
  let lastStateSweepAt = Number.NEGATIVE_INFINITY;
  return async ({ protect, lease }) => {
    const logger = deps.logger ?? log;
    // Single writer: eviction runs only inside a review tick holding the spool
    // lease. Without it, skip -- never delete on a guess.
    if (!(await lease.held())) {
      logger.warn({ spoolKey: lease.spoolKey }, 'overseer_review_checkout_eviction_skipped');
      return null;
    }
    // Walk every claimed run_review page. If the walk cannot finish (store error
    // or more pages than any real queue holds), skip the whole pass: eviction
    // with an incomplete in-use set could delete a checkout under a live review.
    const claimed: DispatchMessage[] = [];
    try {
      let afterSeq: number | undefined;
      for (let page = 0; ; page += 1) {
        if (page >= REVIEW_CHECKOUT_CLAIM_MAX_PAGES) throw new Error('claim_walk_incomplete');
        const rows = await deps.listClaimedReviews({
          recipient: REVIEW_RECIPIENT,
          task_type: REVIEW_TASK_TYPE,
          status: 'claimed',
          ...(afterSeq === undefined ? {} : { afterSeq }),
          limit: REVIEW_CHECKOUT_CLAIM_PAGE_SIZE,
        });
        claimed.push(...rows);
        if (rows.length < REVIEW_CHECKOUT_CLAIM_PAGE_SIZE) break;
        afterSeq = rows[rows.length - 1]?.cursor_seq;
        if (afterSeq === undefined) throw new Error('claim_walk_incomplete');
      }
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'overseer_review_checkout_eviction_skipped'
      );
      return null;
    }
    const now = (deps.now ?? Date.now)();
    const inUse: ReviewCheckoutKey[] = [...protect];
    for (const message of claimed) {
      if (message.task_type !== REVIEW_TASK_TYPE || message.status !== 'claimed') continue;
      if (message.lease_expires_at && Date.parse(message.lease_expires_at) <= now) continue;
      const body = parseReviewWorkBody(message.body);
      if (body) inUse.push({ owner: body.owner, repo: body.repo, headSha: body.headSha });
    }
    const interval =
      deps.stateSweepIntervalMs ??
      (Number(process.env.OVERSEER_REVIEW_CHECKOUT_STATE_SWEEP_MS) ||
        DEFAULT_REVIEW_CHECKOUT_STATE_SWEEP_MS);
    const withState = deps.lookupPrState !== undefined && now - lastStateSweepAt >= interval;
    if (withState) lastStateSweepAt = now;
    // The lease (holder AND fencing token) is re-checked against the database
    // immediately before EVERY directory delete; a mismatch stops the pass.
    return evictReviewCheckouts({
      checkoutRoot: deps.checkoutRoot ?? resolveReviewCheckoutRoot(),
      maxBytes: deps.maxBytes ?? resolveReviewCheckoutCacheMaxBytes(),
      inUse,
      ...(withState ? { lookupPrState: deps.lookupPrState } : {}),
      logger,
      beforeDelete: () => lease.held(),
    });
  };
}

export function startReviewWorkerClock(
  config: ReviewRouteConfig | null | undefined,
  deps: ReviewWorkerDeps = createRealReviewWorkerDeps()
): void {
  if (!config || timer || process.env.NODE_ENV === 'test') return;
  void tickReviewWorkerClock(config, deps);
  const interval = Math.max(
    1_000,
    Number(process.env.OVERSEER_REVIEW_WORKER_INTERVAL_MS) || 60_000
  );
  timer = setInterval(() => void tickReviewWorkerClock(config, deps), interval);
  timer.unref?.();
}

export function stopReviewWorkerClock(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Redact before truncating so a boundary never exposes part of a credential. */
export function redactCheckoutStderr(stderr: string): string {
  let clean = stderr;
  for (const token of [process.env.GITHUB_TOKEN, process.env.GH_TOKEN]) {
    if (!token) continue;
    for (const value of [
      token,
      encodeURIComponent(token),
      Buffer.from(`x-access-token:${token}`).toString('base64'),
    ]) {
      clean = clean.split(value).join('[REDACTED]');
    }
  }
  return clean
    .replace(
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s/]*@/gi,
      match => `${match.slice(0, match.indexOf('://') + 3)}[REDACTED]@`
    )
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:[REDACTED]')
    .replace(/authorization[\s=:]+[^\r\n]*/gi, 'Authorization: [REDACTED]')
    .replace(/\b(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+)/gi, '[REDACTED]')
    .replace(/([?&](?:access_token|token|auth|password)=)[^\s&#]+/gi, '$1[REDACTED]')
    .slice(0, 2000);
}

interface CheckoutDiagnostic {
  repository?: string;
  prNumber?: number;
  headSha?: string;
  baseSha?: string;
  step?: string;
  gitExitCode?: number | null;
  stderr?: string;
}

function checkoutDiagnostic(error: unknown): CheckoutDiagnostic {
  if (!(error instanceof Error) || !error.cause || typeof error.cause !== 'object') return {};
  const detail = error.cause as CheckoutDiagnostic;
  return {
    step: detail.step,
    gitExitCode: detail.gitExitCode,
    stderr: redactCheckoutStderr(detail.stderr ?? ''),
  };
}
