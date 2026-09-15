/**
 * Pull-request event -> independent-review work ingestion
 * (WO-HARNESS-OVERSEER-REVIEW-ROUTE-01, XO authorization 2026-08-17).
 *
 * THE GAP THIS CLOSES: the Overseer App review adapter is real and
 * App-authenticated, but nothing ever calls it. GitHub pull_request events were
 * ignored, no route was registered, and no code created review work. A PR
 * therefore sat at REVIEW_REQUIRED forever with an empty reviewer slot.
 *
 * This module is the missing middle. It is deliberately PURE and INJECTABLE
 * (all IO arrives via IngestDeps) so every branch -- signature rejection,
 * duplicate delivery, exact-head binding, stale-head invalidation, custody
 * conflict, review failure, receipt creation -- is deterministically testable
 * with no network, no database, and no GitHub App key.
 *
 * DESIGN CONSTRAINTS HONORED:
 *  - Signature verification REUSES the extracted proven helper; this module
 *    never implements HMAC itself.
 *  - Durable work REUSES agent_dispatch_messages (task_type 'run_review'),
 *    whose UNIQUE idempotency_key already provides retry dedupe and whose
 *    fencing-token claims are already tested. No second queue.
 *  - Custody separation is enforced BEFORE invoking the reviewer, locally, so
 *    a self-review is never attempted; GitHub's own 422 remains the backstop.
 *  - Every terminal outcome writes a correlated receipt.
 *  - Every failure fails CLOSED with a visible blocker reason.
 *
 * SCOPE: source + tests only. Enabling the App's event subscription, deploying
 * the route, submitting a live review, and merging remain separately gated.
 */
import { checkGitHubWebhookSignature } from '@archon/adapters/forge/github/webhook-signature';
import { createLogger } from '@archon/paths';
import type { JudgeLadderBreaker } from './judge-ladder-health';

const log = createLogger('overseer/pr-review-ingest');

/** pull_request actions that warrant a fresh independent review. */
export const REVIEWABLE_PR_ACTIONS = [
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
] as const;
export type ReviewablePrAction = (typeof REVIEWABLE_PR_ACTIONS)[number];

/** Terminal dispositions. Every one is recorded as a receipt. */
export type IngestDisposition =
  | 'queued'
  | 'duplicate_delivery'
  | 'superseded_head'
  | 'ignored_event'
  | 'ignored_draft'
  | 'rejected_signature'
  | 'custody_conflict'
  | 'blocked';

export interface IngestResult {
  disposition: IngestDisposition;
  /** HTTP status the route should return. */
  status: number;
  /** Stable machine-readable reason; the visible blocker on failure. */
  reason?: string;
  correlationId?: string;
  messageId?: string;
  /** Exact head SHA the queued work is bound to. */
  headSha?: string;
  /** Prior work invalidated by a head change. */
  invalidatedMessageIds?: string[];
}

/** Minimal shape of the inbound pull_request webhook payload. */
export interface PullRequestWebhookPayload {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    draft?: boolean;
    state?: string;
    head?: { sha?: string; ref?: string };
    base?: { ref?: string; sha?: string };
    user?: { login?: string; type?: string };
  };
  repository?: { name?: string; owner?: { login?: string }; full_name?: string };
  sender?: { login?: string; type?: string };
}

/** A prior review work item for this PR, used for stale-head invalidation. */
export interface PriorReviewWork {
  messageId: string;
  headSha: string;
  status: 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';
  verdict: 'approved' | 'changes_requested' | 'other' | null;
  verdictId: string | null;
  /**
   * True only when this row was enqueued by the AUTOMATIC re-review path --
   * i.e. its repeat_reason carries AUTO_REREVIEW_REASON_PREFIX. Initial
   * reviews, legacy `review_exact_head:` rows, and reasons written by other
   * subsystems or by hand are all false and never consume the attempt budget.
   */
  isAutoRereview: boolean;
  /** CI on this row's exact head was terminal and green when it was queued. */
  headCiGreen: boolean;
}

/**
 * Default maximum CONSECUTIVE auto-triggered re-reviews; the initial review is
 * not an attempt. Override per deployment with OVERSEER_MAX_REREVIEW_ATTEMPTS.
 */
export const MAX_REREVIEW_ATTEMPTS = 3;

/** Env var overriding the automatic re-review budget (#797). */
export const MAX_REREVIEW_ATTEMPTS_ENV = 'OVERSEER_MAX_REREVIEW_ATTEMPTS';

/** Lifetime hard ceiling on automatic re-reviews, regardless of progress. */
export const MAX_TOTAL_REREVIEWS = 10;
export const MAX_TOTAL_REREVIEWS_ENV = 'OVERSEER_MAX_TOTAL_REREVIEWS';

/**
 * The effective automatic re-review budget (#797).
 *
 * The cap was hardcoded at 3, so the only way to let a PR that legitimately
 * needed a fourth round get one was to edit and redeploy the harness. A
 * non-numeric, zero, or negative value falls back to the default rather than
 * disabling the guard: an operator typo must not turn a runaway PR loose on the
 * judge budget, and `0` is far more likely to be a mistake than a deliberate
 * "never auto re-review". Fractions are floored so `3.9` cannot buy a fourth
 * attempt through a comparison technicality.
 */
export function resolveMaxRereviewAttempts(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[MAX_REREVIEW_ATTEMPTS_ENV];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return MAX_REREVIEW_ATTEMPTS;
  return Math.floor(parsed);
}

export function resolveMaxTotalRereviews(
  env: Record<string, string | undefined> = process.env
): number {
  const parsed = Number(env[MAX_TOTAL_REREVIEWS_ENV]);
  if (!Number.isFinite(parsed) || parsed < 1) return MAX_TOTAL_REREVIEWS;
  return Math.floor(parsed);
}

/**
 * Counts CONSECUTIVE automatic re-reviews since the last non-automatic review
 * that actually RAN (#797).
 *
 * The bug this fixes: the old count was `prior.filter(isAutoRereview).length`
 * over the PR's whole history, so the budget could only ever be spent, never
 * regained. A PR that converged on round five could not get its APPROVED
 * without an operator, and the hand nudge an operator DID perform bought the PR
 * exactly one review and then handed it straight back to an exhausted budget --
 * which is what left #787 and #790 dark on round four on 2026-09-08.
 *
 * `prior` is newest-first, so this walks from the newest row and stops at the
 * first non-automatic review that produced a verdict. That row is the operator
 * (or initial) look the issue calls the reset point.
 *
 * A non-automatic row is only a reset if it RAN. A hand nudge sitting `queued`,
 * or one `cancelled` by a later push, resolved nothing -- treating it as a reset
 * would let anyone refill the budget indefinitely by queueing nudges that never
 * execute, which is the runaway this cap exists to prevent. Rows with no verdict
 * are therefore skipped entirely: they neither consume the budget nor restore it.
 */
export function countConsecutiveAutoRereviews(
  prior: PriorReviewWork[],
  currentHeadSha?: string,
  currentHeadCiGreen = false
): number {
  let count = 0;
  for (let index = 0; index < prior.length; index += 1) {
    const work = prior[index];
    // A ROW WITH NO VERDICT IS NOT AN ATTEMPT, automatic or not.
    //
    // Review finding (Overseer, PR #803): the first cut counted every
    // `isAutoRereview` row before asking whether it had been judged, which
    // contradicted this function's own documented rule and was worse than a
    // doc mismatch. A row exists from the moment work is QUEUED, so a rapid
    // push sequence -- push, push, push before any review completes -- created
    // three unjudged auto rows and exhausted the whole budget before a single
    // automatic re-review had actually run. That is the exact opposite of the
    // guard's purpose: the cap exists to stop a PR that never converges from
    // burning judge budget, and an unjudged row burned none.
    //
    // The test is now symmetric. Only a row that reached a verdict counts, in
    // either direction: an auto verdict spends the budget, a non-auto verdict
    // (a hand nudge, or the initial review) restores it, and anything still in
    // flight or cancelled before judging is skipped entirely.
    if (!isJudgedVerdict(work.verdict)) continue;
    if (work.isAutoRereview) {
      // The successor must be the nearest newer JUDGED row. An unjudged,
      // cancelled, queued, or claimed row is not a green fixed-push reset.
      const successor = findJudgedSuccessor(prior, index);
      const successorHeadSha = successor?.headSha ?? currentHeadSha;
      const successorCiGreen = successor?.headCiGreen ?? currentHeadCiGreen;
      if (successorHeadSha && successorHeadSha !== work.headSha && successorCiGreen) return count;
      count += 1;
      continue;
    }
    // A non-auto review that RAN is the reset point.
    return count;
  }
  return count;
}

/** All judged automatic re-reviews in the PR's lifetime; progress never resets it. */
export function countTotalAutoRereviews(prior: PriorReviewWork[]): number {
  return prior.filter(work => work.isAutoRereview && isJudgedVerdict(work.verdict)).length;
}

/**
 * True only when a prior row's verdict means A MODEL ACTUALLY JUDGED THE CODE.
 *
 * `null` is the obvious case (queued, claimed, or cancelled before completion).
 * `'other'` is the subtle one, and it matters: `classifyVerdict` maps EVERY
 * non-approve/non-changes_requested submit disposition to `'other'`, and the
 * submit path writes a receipt for all of them -- including the DEFERRALS
 * `checks_pending` and `transport_error`, where no judge was reached and no
 * verdict was formed (#789, #790). Counting those as attempts would let a PR
 * whose CI is merely slow, or whose judge host is briefly unreachable, burn its
 * entire re-review budget without a single review having happened.
 *
 * Symmetrically, `'other'` must not RESET the budget either: a non-auto row
 * that only deferred is not the operator look the reset represents.
 */
function isJudgedVerdict(verdict: PriorReviewWork['verdict']): boolean {
  return verdict === 'approved' || verdict === 'changes_requested';
}

/**
 * Nearest newer row that actually judged the code. `prior` is newest-first,
 * so newer rows sit at lower indexes. Unjudged, cancelled, queued, and
 * claimed rows are skipped: they neither prove a head moved with green CI
 * nor authorize a consecutive-count reset.
 */
function findJudgedSuccessor(prior: PriorReviewWork[], index: number): PriorReviewWork | undefined {
  for (let newer = index - 1; newer >= 0; newer -= 1) {
    const candidate = prior[newer];
    if (
      candidate.status === 'queued' ||
      candidate.status === 'claimed' ||
      candidate.status === 'cancelled'
    ) {
      continue;
    }
    if (isJudgedVerdict(candidate.verdict)) return candidate;
  }
  return undefined;
}

/**
 * Marker embedded in the cap-exhausted PR comment so the same comment is never
 * posted twice for one head (#797).
 *
 * Idempotency has to key on the HEAD, not the PR: a PR can exhaust its budget,
 * get a hand nudge, converge, regress, and exhaust it again at a later head,
 * and each of those is a distinct thing the author needs telling about. The
 * marker is HTML-commented so it is invisible in the rendered comment while
 * remaining exact-matchable by the adapter.
 */
export function rereviewCapCommentMarker(headSha: string): string {
  return `<!-- overseer:rereview-budget-exhausted:${headSha} -->`;
}

/**
 * The comment posted on the PR when the automatic budget is exhausted (#797).
 *
 * The whole defect was invisibility: the cap blocked the push with HTTP 200, an
 * operator receipt, and a log line, so from the PR's side the reviewer simply
 * stopped answering. This says what happened and what to do about it, in the
 * one place the person pushing is actually looking.
 */
export function buildRereviewCapComment(
  headSha: string,
  maxAttempts: number,
  totalAttempts = maxAttempts,
  maxTotal = MAX_TOTAL_REREVIEWS,
  rule: 'consecutive' | 'total' = 'consecutive',
  consecutiveAttempts = maxAttempts
): string {
  const ruleText =
    rule === 'total'
      ? `The lifetime hard ceiling (${maxTotal}) was reached.`
      : `The consecutive automatic re-review cap (${maxAttempts}) was reached.`;
  return [
    rereviewCapCommentMarker(headSha),
    `Automatic re-review budget (${rule === 'total' ? maxTotal : maxAttempts}) exhausted for this pull request.`,
    '',
    `${ruleText} Consecutive attempts: ${consecutiveAttempts}; total attempts: ${totalAttempts}. No review was queued for \`${headSha}\`.`,
    '',
    'A maintainer can request one more review with a Dispatch nudge; once a hand-requested review runs, automatic re-reviews resume for later pushes.',
  ].join('\n');
}

/**
 * Explicit machine-readable marker prefixing every repeat_reason this module
 * writes for an AUTOMATIC re-review.
 *
 * `repeat_reason` is shared free text: Dispatch requires SOME reason on any
 * repeat send, and several unrelated writers already fill it -- Taskmaster
 * nudges (`tm:nudge:*`), XO escalation handoffs, hand-written operator
 * re-review requests, and the pre-2026-09 Overseer enqueue path which stamped
 * EVERY review (initial ones included) with `review_exact_head:<sha>`. So a
 * non-null reason proves nothing about who wrote it or why.
 *
 * Review finding (Overseer, PR #772): deriving `isAutoRereview` from
 * `repeat_reason !== null` therefore counts all of those as automatic
 * re-review attempts, and a PR carrying MAX_REREVIEW_ATTEMPTS legacy rows is
 * capped before a single automatic re-review has actually run. Verified
 * against the live event store 2026-09-06: 6 rows in the legacy
 * `review_exact_head:` format and 134 hand-written prose reasons, with
 * shopops#662 alone holding 16 -- every one of which would have counted.
 *
 * The cap now counts ONLY rows this module marked. Anything else -- legacy
 * format, another subsystem, a human -- is not an attempt.
 */
export const AUTO_REREVIEW_REASON_PREFIX = 'auto_rereview:head_moved:';

/**
 * True only for a repeat_reason this module wrote for an automatic re-review.
 * Deliberately narrow: unrecognized reasons are NOT attempts, so an unrelated
 * writer can never consume a PR's re-review budget.
 */
export function isAutoRereviewReason(repeatReason: string | null | undefined): boolean {
  return typeof repeatReason === 'string' && repeatReason.startsWith(AUTO_REREVIEW_REASON_PREFIX);
}

export function buildRereviewReason(
  priorVerdictId: string,
  priorHeadSha: string,
  newHeadSha: string
): string {
  return `${AUTO_REREVIEW_REASON_PREFIX}${newHeadSha} changes_requested verdict ${priorVerdictId} reviewed head ${priorHeadSha}; re-review new head ${newHeadSha}`;
}

/**
 * Prefix for a fresh exact-head review after a standing verdict that is NOT
 * `changes_requested`. Dispatch requires a repeat_reason on any later send
 * for the same PR subject; this prefix satisfies that transport rule without
 * consuming the automatic re-review budget (`isAutoRereviewReason` is false).
 */
export const SUPERSEDE_REASON_PREFIX = 'supersede:';

export function buildSupersedeReason(
  priorHeadSha: string,
  newHeadSha: string,
  verdict: PriorReviewWork['verdict']
): string {
  const standing = verdict ?? 'none';
  return `${SUPERSEDE_REASON_PREFIX}${priorHeadSha}->${newHeadSha} after ${standing}`;
}

/**
 * Selects the prior review whose verdict authorizes (or refuses) an automatic
 * re-review of `headSha`.
 *
 * Review finding (Overseer, PR #772): the previous `prior.find(work =>
 * work.headSha !== headSha)` took the FIRST row on a different head.
 * `listPriorReviewWork` returns newest-first, and a row is created the moment
 * work is queued -- long before any verdict exists. So a rapid push sequence
 * lost the verdict entirely:
 *
 *   1. head A is reviewed -> CHANGES_REQUESTED (row A carries the verdict)
 *   2. head B arrives -> row B is queued, verdict null
 *   3. head C arrives before B completes -> B is cancelled (verdict still
 *      null), and `find` selects row B because it is newer than A
 *
 * At step 3 the selected row's verdict is null, so no repeat reason was built,
 * and Dispatch rejected the enqueue with `repeat_reason_required` -- the
 * automatic re-review silently died exactly when the author was pushing
 * fastest. The verdict on A was still the live, unaddressed one.
 *
 * The fix is to skip rows that carry no verdict (queued, claimed, or cancelled
 * before completion) and select the most recent VERDICT-BEARING row on a
 * different head. That row is the standing review state of the PR.
 *
 * Rows on the CURRENT head are still excluded: a verdict on this exact head is
 * a duplicate delivery, not a supersession, and must not authorize a repeat.
 * A verdict of `approved` or `other` is deliberately still selected rather
 * than skipped, so an older changes_requested row cannot reach past it
 * into the cap-counted auto_rereview path. Ingest still stamps a
 * supersede: repeat_reason for those standing verdicts so Dispatch
 * accepts a fresh exact-head review.
 */
export function findAuthorizingPriorReview(
  prior: PriorReviewWork[],
  headSha: string
): PriorReviewWork | undefined {
  return prior.find(work => work.headSha !== headSha && work.verdict !== null);
}

export interface IngestDeps {
  /** Shared webhook secret. Empty/absent means the route must fail closed. */
  webhookSecret: string;
  /**
   * The reviewer identity that will submit the review (e.g.
   * 'thinman-overseer[bot]'). Custody separation compares the PR author
   * against this; a match is refused before any reviewer invocation.
   */
  reviewerIdentity: string;
  /** Prior review work for (owner, repo, prNumber), newest first. */
  listPriorReviewWork(input: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<PriorReviewWork[]>;
  /** Cancel superseded work. Idempotent; returns ids actually invalidated. */
  cancelReviewWork(input: { messageIds: string[]; reason: string }): Promise<string[]>;
  /**
   * Enqueue durable review work. MUST be backed by
   * agent_dispatch_messages(task_type='run_review'); its UNIQUE
   * idempotency_key is what makes duplicate delivery a no-op.
   */
  enqueueReviewWork(input: {
    correlationId: string;
    idempotencyKey: string;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    baseRef: string;
    author: string;
    repeatReason: string | null;
    headCiGreen: boolean;
  }): Promise<{ messageId: string; alreadyExisted: boolean }>;
  /** Resolve whether CI on the current exact head is terminal and green. */
  isHeadCiGreen?(input: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
  }): Promise<boolean>;
  /**
   * Post the cap-exhausted notice on the PR (#797). MUST be idempotent per
   * head: the implementation checks for an existing comment carrying
   * `rereviewCapCommentMarker(headSha)` before creating one, so a repeated
   * push at the same head does not spam the thread.
   *
   * Optional so existing dependency doubles keep compiling; when absent, the
   * cap still blocks and still writes its receipt -- it just stays silent, i.e.
   * exactly the pre-#797 behaviour rather than a crash.
   *
   * Returns whether a comment was actually created (false = one already
   * existed), which the receipt records so an operator can tell a first
   * exhaustion from a repeat.
   */
  postCapExhaustedComment?(input: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    body: string;
    marker: string;
  }): Promise<{ posted: boolean }>;
  /**
   * Judge-ladder circuit breaker (#847). When `check()` reports that every
   * configured rung is out of quota, credits, or credentials, ingest parks the
   * head instead of enqueueing: `blocked` receipt with reason
   * `judge_ladder_exhausted_until:<iso>`, no review posted, one operator
   * notice per hour. Optional so existing dependency doubles keep compiling;
   * when absent the breaker is simply not consulted (pre-#847 behaviour).
   */
  judgeLadderBreaker?: JudgeLadderBreaker;
  /** Persist a correlated audit receipt. Never throws the ingest path open. */
  recordReceipt(input: {
    correlationId: string;
    deliveryId: string;
    owner: string;
    repo: string;
    prNumber: number | null;
    headSha: string | null;
    disposition: IngestDisposition;
    reason?: string;
    messageId?: string;
  }): Promise<void>;
}

export interface IngestRequest {
  /** RAW request body. Never a re-serialized object. */
  rawBody: string;
  signature: string | undefined | null;
  /** x-github-event */
  eventType: string | undefined | null;
  /** x-github-delivery -- the dedupe key for retried deliveries. */
  deliveryId: string | undefined | null;
}

/**
 * Correlation id binding work to one exact head. Deterministic (no clock, no
 * randomness) so a retried delivery of the same head computes the same value.
 */
export function reviewCorrelationId(input: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}): string {
  return `pr-review:${input.owner}/${input.repo}#${input.prNumber}@${input.headSha}`;
}

/**
 * Idempotency key for the durable queue row. Includes the delivery id so a
 * GitHub retry of the SAME delivery collapses onto the same row, while a
 * genuinely new event for the same head still dedupes via correlation.
 */
export function reviewIdempotencyKey(input: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}): string {
  return reviewCorrelationId(input);
}

function isReviewableAction(action: string | undefined): action is ReviewablePrAction {
  return (REVIEWABLE_PR_ACTIONS as readonly string[]).includes(action ?? '');
}

/**
 * Verify, ingest, dedupe, invalidate stale work, enforce custody, and queue
 * durable independent-review work bound to an exact head.
 *
 * Fails closed at every branch: a missing secret, a bad signature, an
 * unparseable body, a missing head SHA, a custody conflict, or an enqueue
 * error all produce a receipt and a non-queued disposition. The reviewer is
 * never invoked from here -- this function only creates the durable work item
 * a governed reviewer later claims.
 */
export async function ingestPullRequestEvent(
  request: IngestRequest,
  deps: IngestDeps
): Promise<IngestResult> {
  const deliveryId = request.deliveryId?.trim() ?? '';

  // Fail closed on an unconfigured secret rather than accepting unverified input.
  if (!deps.webhookSecret) {
    const result: IngestResult = {
      disposition: 'blocked',
      status: 500,
      reason: 'webhook_secret_not_configured',
    };
    await safeReceipt(deps, {
      correlationId: '',
      deliveryId,
      owner: '',
      repo: '',
      prNumber: null,
      headSha: null,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }

  const signature = checkGitHubWebhookSignature(
    request.rawBody,
    request.signature,
    deps.webhookSecret
  );
  if (!signature.valid) {
    const result: IngestResult = {
      disposition: 'rejected_signature',
      status: 401,
      reason: `signature_${signature.reason ?? 'invalid'}`,
    };
    await safeReceipt(deps, {
      correlationId: '',
      deliveryId,
      owner: '',
      repo: '',
      prNumber: null,
      headSha: null,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }

  // Only parse AFTER the signature passes -- unverified input is never parsed.
  let payload: PullRequestWebhookPayload;
  try {
    payload = JSON.parse(request.rawBody) as PullRequestWebhookPayload;
  } catch {
    const result: IngestResult = {
      disposition: 'blocked',
      status: 400,
      reason: 'payload_unparseable',
    };
    await safeReceipt(deps, {
      correlationId: '',
      deliveryId,
      owner: '',
      repo: '',
      prNumber: null,
      headSha: null,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }

  if (request.eventType !== 'pull_request') {
    return finishIgnored(deps, deliveryId, 'ignored_event', 'event_type_not_pull_request');
  }
  if (!isReviewableAction(payload.action)) {
    return finishIgnored(deps, deliveryId, 'ignored_event', 'action_not_reviewable');
  }

  const owner = payload.repository?.owner?.login ?? '';
  const repo = payload.repository?.name ?? '';
  const prNumber = payload.pull_request?.number ?? payload.number ?? 0;
  const headSha = payload.pull_request?.head?.sha ?? '';
  const baseRef = payload.pull_request?.base?.ref ?? '';
  const author = payload.pull_request?.user?.login ?? '';

  if (!owner || !repo || !prNumber || !headSha) {
    const result: IngestResult = {
      disposition: 'blocked',
      status: 400,
      reason: 'incomplete_pull_request_context',
    };
    await safeReceipt(deps, {
      correlationId: '',
      deliveryId,
      owner,
      repo,
      prNumber: prNumber || null,
      headSha: headSha || null,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }

  // A draft PR is not ready for independent review.
  if (payload.pull_request?.draft === true && payload.action !== 'ready_for_review') {
    return finishIgnored(deps, deliveryId, 'ignored_draft', 'pull_request_is_draft', {
      owner,
      repo,
      prNumber,
      headSha,
    });
  }

  const correlationId = reviewCorrelationId({ owner, repo, prNumber, headSha });

  // CUSTODY SEPARATION: never review our own work. Checked BEFORE any reviewer
  // invocation or enqueue, so a self-review is not merely rejected remotely --
  // it is never attempted.
  if (author?.toLowerCase() === deps.reviewerIdentity.toLowerCase()) {
    const result: IngestResult = {
      disposition: 'custody_conflict',
      status: 200,
      reason: 'reviewer_is_pull_request_author',
      correlationId,
      headSha,
    };
    await safeReceipt(deps, {
      correlationId,
      deliveryId,
      owner,
      repo,
      prNumber,
      headSha,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }

  // STALE-HEAD INVALIDATION: a head change invalidates every prior in-flight
  // review for this PR bound to a different head. Prior work on the SAME head
  // is a duplicate, not a supersession.
  let invalidatedMessageIds: string[] = [];
  let prior: PriorReviewWork[] = [];
  try {
    prior = await deps.listPriorReviewWork({ owner, repo, prNumber });
    const staleIds = prior
      .filter(work => work.headSha !== headSha)
      .filter(work => work.status === 'queued' || work.status === 'claimed')
      .map(work => work.messageId);
    if (staleIds.length > 0) {
      invalidatedMessageIds = await deps.cancelReviewWork({
        messageIds: staleIds,
        reason: `superseded_by_head_${headSha}`,
      });
    }
  } catch (error) {
    const result: IngestResult = {
      disposition: 'blocked',
      status: 500,
      reason: `stale_head_invalidation_failed:${errorCode(error)}`,
      correlationId,
      headSha,
    };
    await safeReceipt(deps, {
      correlationId,
      deliveryId,
      owner,
      repo,
      prNumber,
      headSha,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }

  // JUDGE LADDER CIRCUIT BREAKER (#847). When every configured rung is known
  // to be out of quota, credits, or credentials, running the judge can only
  // spawn dead processes and post a rejecting review for a code-blind reason
  // -- which is what every push did from 20:45Z on 2026-09-14. So the head is
  // PARKED, not enqueued: a `blocked` receipt says until when, nothing is
  // posted on the PR, the operator is told at most once an hour, and the
  // parked head is re-enqueued by `recoverParkedJudgeHeads` (review worker
  // tick) when the earliest retry time passes -- or at once when an operator
  // clears the breaker with an `operator_request:ladder_restored` row.
  //
  // Placed AFTER stale-head invalidation on purpose -- in-flight work on a
  // dead head is cancelled either way -- and BEFORE the re-review cap, whose
  // `isHeadCiGreen` lookup is a GitHub read the parked head does not need.
  const breaker = deps.judgeLadderBreaker;
  const exhaustion = breaker?.check() ?? null;
  if (breaker && exhaustion) {
    breaker.park({
      correlationId,
      idempotencyKey: reviewIdempotencyKey({ owner, repo, prNumber, headSha }),
      owner,
      repo,
      prNumber,
      headSha,
      baseRef,
      author,
    });
    let notified = false;
    try {
      notified = await breaker.notify(exhaustion);
    } catch {
      // The block stands either way: the receipt below reaches the operator.
    }
    const result: IngestResult = {
      disposition: 'blocked',
      status: 200,
      reason: `judge_ladder_exhausted_until:${exhaustion.until}`,
      correlationId,
      headSha,
      ...(invalidatedMessageIds.length > 0 ? { invalidatedMessageIds } : {}),
    };
    log.warn(
      {
        owner,
        repo,
        prNumber,
        headSha,
        until: exhaustion.until,
        rungs: exhaustion.rungs.map(rung => `${rung.binary}=${rung.code}`),
        operatorNotified: notified,
      },
      'overseer.pr_review.judge_ladder_exhausted'
    );
    await safeReceipt(deps, {
      correlationId,
      deliveryId,
      owner,
      repo,
      prNumber,
      headSha,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }

  let headCiGreen = false;
  const priorAtDifferentHead = findAuthorizingPriorReview(prior, headSha);
  let repeatReason: string | null = null;
  if (priorAtDifferentHead?.verdict === 'changes_requested') {
    // Persist this exact head's CI state only for an automatic re-review. The
    // live evidence lookup has durable failure accounting, so initial reviews
    // must not invoke it when progress/cap tracking cannot use the result.
    // Fail closed: unavailable or unknown evidence is never recorded as green.
    if (deps.isHeadCiGreen) {
      try {
        headCiGreen = await deps.isHeadCiGreen({ owner, repo, prNumber, headSha });
      } catch {
        headCiGreen = false;
      }
    }
    // CONSECUTIVE, not lifetime (#797): a hand-requested review that ran resets
    // the budget, so a PR converging on a later round is not permanently locked
    // out of automatic review.
    const maxAttempts = resolveMaxRereviewAttempts();
    const maxTotalRereviews = resolveMaxTotalRereviews();
    const rereviewAttempts = countConsecutiveAutoRereviews(prior, headSha, headCiGreen);
    const totalRereviews = countTotalAutoRereviews(prior);
    const blockedReason =
      totalRereviews >= maxTotalRereviews
        ? 'rereview_total_ceiling_reached'
        : rereviewAttempts >= maxAttempts
          ? 'rereview_attempts_exhausted'
          : null;
    if (blockedReason) {
      const firedRule =
        blockedReason === 'rereview_total_ceiling_reached' ? 'total' : 'consecutive';
      // SAY SO ON THE PR. The cap previously blocked with HTTP 200 and no
      // visible trace, so the author saw the reviewer simply go quiet.
      let commentPosted: boolean | null = null;
      if (deps.postCapExhaustedComment) {
        try {
          const outcome = await deps.postCapExhaustedComment({
            owner,
            repo,
            prNumber,
            headSha,
            body: buildRereviewCapComment(
              headSha,
              maxAttempts,
              totalRereviews,
              maxTotalRereviews,
              firedRule,
              rereviewAttempts
            ),
            marker: rereviewCapCommentMarker(headSha),
          });
          commentPosted = outcome.posted;
        } catch {
          // A comment failure must not change the disposition: the block is
          // correct either way, and the receipt still reaches the operator.
          commentPosted = false;
        }
      }
      const result: IngestResult = {
        disposition: 'blocked',
        status: 200,
        reason: blockedReason,
        correlationId,
        headSha,
        ...(invalidatedMessageIds.length > 0 ? { invalidatedMessageIds } : {}),
      };
      await safeReceipt(deps, {
        correlationId,
        deliveryId,
        owner,
        repo,
        prNumber,
        headSha,
        disposition: result.disposition,
        reason: `${result.reason}:consecutive=${rereviewAttempts}:total=${totalRereviews}${
          commentPosted === null
            ? ''
            : `:comment_${commentPosted ? 'posted' : 'existing_or_failed'}`
        }`,
      });
      return result;
    }
    repeatReason = buildRereviewReason(
      priorAtDifferentHead.verdictId ?? priorAtDifferentHead.messageId,
      priorAtDifferentHead.headSha,
      headSha
    );
  } else {
    // Any TERMINAL prior row on this PR makes Dispatch require a repeat_reason
    // (repeat_reason_required); without one the enqueue is refused and the
    // new head is never reviewed (#836). The auto prefix is reserved for
    // changes_requested so this path does not burn the cap. A push after
    // approved/other is a fresh exact-head review: the prior approval is
    // stale and the merge manager requires an exact-head match. A prior row
    // that is merely queued or was cancelled before a verdict never triggered
    // the transport rule, so it gets no reason (operator dedupe stays exact).
    const standing =
      priorAtDifferentHead ??
      prior.find(
        work => work.headSha !== headSha && (work.status === 'done' || work.status === 'failed')
      );
    if (standing) {
      repeatReason = buildSupersedeReason(standing.headSha, headSha, standing.verdict);
    }
  }

  // Queue durable work bound to this EXACT head.
  try {
    const enqueued = await deps.enqueueReviewWork({
      correlationId,
      idempotencyKey: reviewIdempotencyKey({ owner, repo, prNumber, headSha }),
      owner,
      repo,
      prNumber,
      headSha,
      baseRef,
      author,
      repeatReason,
      headCiGreen,
    });
    const disposition: IngestDisposition = enqueued.alreadyExisted
      ? 'duplicate_delivery'
      : invalidatedMessageIds.length > 0
        ? 'superseded_head'
        : 'queued';
    const result: IngestResult = {
      disposition,
      status: 200,
      correlationId,
      messageId: enqueued.messageId,
      headSha,
      ...(invalidatedMessageIds.length > 0 ? { invalidatedMessageIds } : {}),
      ...(enqueued.alreadyExisted ? { reason: 'idempotent_replay' } : {}),
    };
    await safeReceipt(deps, {
      correlationId,
      deliveryId,
      owner,
      repo,
      prNumber,
      headSha,
      disposition,
      messageId: enqueued.messageId,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    return result;
  } catch (error) {
    const result: IngestResult = {
      disposition: 'blocked',
      status: 500,
      reason: `enqueue_failed:${errorCode(error)}`,
      correlationId,
      headSha,
      ...(invalidatedMessageIds.length > 0 ? { invalidatedMessageIds } : {}),
    };
    log.warn(
      { owner, repo, prNumber, headSha, reason: result.reason },
      'overseer.pr_review_enqueue_failed'
    );
    await safeReceipt(deps, {
      correlationId,
      deliveryId,
      owner,
      repo,
      prNumber,
      headSha,
      disposition: result.disposition,
      reason: result.reason,
    });
    return result;
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 120);
  return 'unknown_error';
}

async function finishIgnored(
  deps: IngestDeps,
  deliveryId: string,
  disposition: Extract<IngestDisposition, 'ignored_event' | 'ignored_draft'>,
  reason: string,
  context?: { owner: string; repo: string; prNumber: number; headSha: string }
): Promise<IngestResult> {
  const result: IngestResult = { disposition, status: 200, reason };
  await safeReceipt(deps, {
    correlationId: context
      ? reviewCorrelationId({
          owner: context.owner,
          repo: context.repo,
          prNumber: context.prNumber,
          headSha: context.headSha,
        })
      : '',
    deliveryId,
    owner: context?.owner ?? '',
    repo: context?.repo ?? '',
    prNumber: context?.prNumber ?? null,
    headSha: context?.headSha ?? null,
    disposition,
    reason,
  });
  return result;
}

/**
 * Receipt persistence must never convert a classified outcome into an
 * unhandled throw. A receipt failure is itself logged as a blocker by the
 * caller's logger, but the ingest disposition stands.
 */
async function safeReceipt(
  deps: IngestDeps,
  input: Parameters<IngestDeps['recordReceipt']>[0]
): Promise<void> {
  try {
    await deps.recordReceipt(input);
  } catch {
    // Intentionally swallowed: see doc comment.
  }
}
