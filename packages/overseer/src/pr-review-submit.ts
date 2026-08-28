/**
 * Governed reviewer -> GitHub review submission
 * (WO-HARNESS-OVERSEER-REVIEW-ROUTE-01, XO authorization 2026-08-17).
 *
 * The second half of the review route. `pr-review-ingest.ts` turns a verified
 * pull_request event into durable work bound to an exact head; this module
 * takes one claimed work item, runs the governed reviewer, and submits the
 * resulting verdict through the EXISTING Overseer App adapter.
 *
 * XO decision 1 (2026-08-17): a non-approving verdict MUST submit
 * REQUEST_CHANGES -- approve-only is not a reviewer. If submission fails, we
 * fail closed and record the blocker rather than silently degrading to "no
 * review", which would leave the PR indistinguishable from never-reviewed.
 *
 * The reviewer itself is injected. This module owns custody enforcement,
 * exact-head binding, verdict-to-event mapping, evidence-body construction,
 * and receipt writing -- not the review judgment.
 */
import type {
  OverseerReviewEvent,
  SubmitPullRequestReviewInput,
  SubmitPullRequestReviewResult,
} from './adapters/github-real-deps.ts';
import { hasDistinctMergeIdentity } from './adapters/github-real-deps';
import { resolveMergeManagerMode } from './merge-manager';
import type { IndependentReviewFinding } from './independent-review-evidence.ts';
import {
  decideRemediation,
  type RemediationCandidateBody,
  type RemediationRefusalReason,
} from './remediation-candidate';

/** What the governed reviewer returns. */
export interface ReviewerVerdict {
  /** true -> APPROVE; false -> REQUEST_CHANGES. */
  approved: boolean;
  /** Evidence. REQUIRED (non-empty) when approved === false. */
  summary: string;
  /** The head the reviewer actually examined. Must match the work item. */
  reviewedHeadSha: string;
  /**
   * The structured findings behind the verdict.
   *
   * Carried alongside `summary` because remediation classification must read
   * SEVERITY and per-finding text, which the flattened summary string has
   * already lost. Optional so existing reviewers that only produce a summary
   * keep working -- absent findings simply yield no remediation candidate,
   * which is the fail-closed direction.
   */
  findings?: readonly IndependentReviewFinding[];
}

export interface ReviewWorkItem {
  correlationId: string;
  messageId: string;
  owner: string;
  repo: string;
  prNumber: number;
  /** The exact head this work item is bound to. */
  headSha: string;
  author: string;
}

export type SubmitDisposition =
  | 'approved'
  | 'changes_requested'
  | 'custody_conflict'
  | 'merge_custody_conflict'
  | 'stale_head'
  | 'reviewer_failed'
  | 'submission_failed';

export interface SubmitOutcome {
  disposition: SubmitDisposition;
  reason?: string;
  event?: OverseerReviewEvent;
  /**
   * Present only on a changes_requested disposition. Reports whether the
   * verdict was handed back to Taskmaster and, when it was not, why it stopped
   * with a human instead.
   */
  remediation?: RemediationOutcome;
}

export interface SubmitDeps {
  reviewerIdentity: string;
  /** Runs the governed reviewer against an exact head. */
  runReviewer(work: ReviewWorkItem): Promise<ReviewerVerdict>;
  /** The existing Overseer App adapter's general review submission. */
  submitReview(input: SubmitPullRequestReviewInput): Promise<SubmitPullRequestReviewResult>;
  /**
   * Current head of the PR, re-read immediately before submission. A review
   * must never land on a head the reviewer did not examine.
   */
  currentHeadSha(input: { owner: string; repo: string; prNumber: number }): Promise<string>;
  recordReceipt(input: {
    correlationId: string;
    messageId: string;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    disposition: SubmitDisposition;
    event?: OverseerReviewEvent;
    reason?: string;
    /**
     * Carried onto the operator card so a human reading the escalation can
     * tell "handed back to Taskmaster, attempt 1" from "stopped here because a
     * blocking finding needs your judgment".
     */
    remediation?: RemediationOutcome;
  }): Promise<void>;

  /**
   * Hands a CHANGES_REQUESTED verdict back to Taskmaster as a remediation
   * PROPOSAL (WO-...-VERDICT-TO-TASKMASTER-REMEDIATION-01).
   *
   * OPTIONAL BY DESIGN. When absent, this module behaves exactly as it did
   * before: the review is submitted and the operator-card path is unchanged.
   * That keeps the existing escalation regression-safe and makes the hand-back
   * an additive capability rather than a rewrite of the review route.
   *
   * The implementation must return the attempts ALREADY made for this PR so
   * the cap can be enforced against durable state rather than a value this
   * module guesses. Returning nothing signals the counter was unavailable, and
   * the caller then declines to emit -- fail-closed.
   */
  countPriorRemediationAttempts?(input: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<number>;

  /**
   * Writes the remediation candidate onto the existing dispatch seam. Never
   * fires a builder: Taskmaster's budget, backoff, pause state, and
   * fire-eligibility still decide whether the proposal becomes work.
   */
  emitRemediationCandidate?(body: RemediationCandidateBody): Promise<void>;
}

/** What the remediation hand-back did, recorded on the receipt. */
export interface RemediationOutcome {
  readonly emitted: boolean;
  /** Present when emitted; identifies the attempt for audit. */
  readonly attempt?: number;
  /** Present when NOT emitted, so a human sees why it stopped with them. */
  readonly reason?: RemediationRefusalReason | 'remediation_not_configured' | 'emit_failed';
}

/** Bounds the evidence body so a runaway reviewer cannot post an essay. */
const MAX_EVIDENCE_BODY = 60_000;

/**
 * Builds the review body. Always states the exact head so the review is
 * self-evidencing about what was examined.
 */
export function buildReviewBody(work: ReviewWorkItem, verdict: ReviewerVerdict): string {
  const header = `Independent review by the Overseer App at head \`${work.headSha}\`.`;
  const summary = verdict.summary.trim();
  const body = summary.length > 0 ? `${header}\n\n${summary}` : header;
  return body.length > MAX_EVIDENCE_BODY ? body.slice(0, MAX_EVIDENCE_BODY) : body;
}

/**
 * Run the governed reviewer for one claimed work item and submit its verdict.
 *
 * Order is deliberate: custody first (never review our own PR), then the
 * reviewer, then a head re-read (a push during review invalidates the result),
 * then submission. Every terminal branch writes a receipt.
 */
export async function runAndSubmitReview(
  work: ReviewWorkItem,
  deps: SubmitDeps
): Promise<SubmitOutcome> {
  // CUSTODY: enforced here as well as at ingest, because a work item can be
  // claimed long after it was queued and this is the last point before a real
  // review lands.
  if (work.author?.toLowerCase() === deps.reviewerIdentity.toLowerCase()) {
    return finish(deps, work, work.headSha, {
      disposition: 'custody_conflict',
      reason: 'reviewer_is_pull_request_author',
    });
  }

  // MERGE-CUSTODY (M-153, RULED by John 2026-08-24: "the Review Gate reviews;
  // the Merge Manager merges" -- one identity never does both on the same PR).
  //
  // The question this gate answers is IDENTITY SEPARATION, not merge mode. A
  // review is safe to submit whenever the merge mutation will run as a
  // DIFFERENT GitHub identity than this reviewer, because then approving here
  // cannot let the same actor execute its own approval.
  //
  // Before the ruling this gate blocked on `mode === 'execute'` as a
  // conservative stand-in while M-153 was tabled. That stand-in outlived the
  // question: with the merge manager armed (the only mode that ever merges)
  // no review could be submitted, so no approval ever existed, so the merge
  // manager denied every PR for `review_gate_approval_missing_for_head`. The
  // two halves deadlocked and the machine merged nothing.
  //
  // STILL FAILS CLOSED: when no distinct merge identity is configured, the
  // merge octokit falls back to this same App, so review submission is
  // refused exactly as before.
  const mergeMode = resolveMergeManagerMode();
  if (mergeMode === 'execute' && !hasDistinctMergeIdentity()) {
    return finish(deps, work, work.headSha, {
      disposition: 'merge_custody_conflict',
      reason: 'merge_manager_shares_reviewer_identity_m153',
    });
  }

  let verdict: ReviewerVerdict;
  try {
    verdict = await deps.runReviewer(work);
  } catch (error) {
    return finish(deps, work, work.headSha, {
      disposition: 'reviewer_failed',
      reason: `reviewer_error:${errorCode(error)}`,
    });
  }

  // EXACT-HEAD BINDING: the reviewer must have examined the bound head.
  if (verdict.reviewedHeadSha !== work.headSha) {
    return finish(deps, work, work.headSha, {
      disposition: 'stale_head',
      reason: 'reviewer_examined_different_head',
    });
  }

  // A push during review invalidates the verdict; do not land it on a head
  // nobody reviewed.
  let liveHead: string;
  try {
    liveHead = await deps.currentHeadSha({
      owner: work.owner,
      repo: work.repo,
      prNumber: work.prNumber,
    });
  } catch (error) {
    return finish(deps, work, work.headSha, {
      disposition: 'submission_failed',
      reason: `head_recheck_failed:${errorCode(error)}`,
    });
  }
  if (liveHead !== work.headSha) {
    return finish(deps, work, work.headSha, {
      disposition: 'stale_head',
      reason: 'head_advanced_during_review',
    });
  }

  const event: OverseerReviewEvent = verdict.approved ? 'APPROVE' : 'REQUEST_CHANGES';
  const body = buildReviewBody(work, verdict);

  // A rejection with no evidence is not actionable; refuse before the call.
  if (!verdict.approved && verdict.summary.trim().length === 0) {
    return finish(deps, work, work.headSha, {
      disposition: 'submission_failed',
      reason: 'request_changes_missing_evidence',
      event,
    });
  }

  let submission: SubmitPullRequestReviewResult;
  try {
    submission = await deps.submitReview({
      owner: work.owner,
      repo: work.repo,
      number: work.prNumber,
      event,
      body,
      // The exact head this work item is bound to -- the SAME sha the
      // reviewer verdict was already checked against above. Never the
      // live/current head; a push during review is caught by the
      // stale-head check before this call is ever reached.
      commitId: work.headSha,
    });
  } catch (error) {
    return finish(deps, work, work.headSha, {
      disposition: 'submission_failed',
      reason: `submit_threw:${errorCode(error)}`,
      event,
    });
  }

  if (!submission.submitted) {
    return finish(deps, work, work.headSha, {
      disposition: 'submission_failed',
      reason: submission.message ?? 'submit_rejected',
      event,
    });
  }

  if (verdict.approved) {
    return finish(deps, work, work.headSha, { disposition: 'approved', event });
  }

  // THE MISSING ARROW. The review has landed as REQUEST_CHANGES; without this
  // the loop ended here and the finding waited on a human mailbox. Hand it
  // back to Taskmaster, which decides whether it actually becomes work.
  const remediation = await handBackToTaskmaster(work, verdict, deps);
  return finish(deps, work, work.headSha, {
    disposition: 'changes_requested',
    event,
    remediation,
  });
}

/**
 * Turn a rejected verdict into a remediation proposal for Taskmaster.
 *
 * NEVER THROWS. A failure to hand back must not convert a successfully
 * submitted review into a failed submission -- the review is already on the PR
 * and that fact must survive. Every failure path degrades to "not emitted" with
 * a stated reason, which routes the finding to a human: the same place it went
 * before this capability existed.
 */
async function handBackToTaskmaster(
  work: ReviewWorkItem,
  verdict: ReviewerVerdict,
  deps: SubmitDeps
): Promise<RemediationOutcome> {
  if (!deps.emitRemediationCandidate || !deps.countPriorRemediationAttempts) {
    return { emitted: false, reason: 'remediation_not_configured' };
  }

  let priorAttempts: number;
  try {
    priorAttempts = await deps.countPriorRemediationAttempts({
      owner: work.owner,
      repo: work.repo,
      prNumber: work.prNumber,
    });
  } catch {
    // Cannot prove we are under the cap -> must not emit. An unbounded
    // reviewer-fix-reviewer loop is the exact failure this WO must not create.
    return { emitted: false, reason: 'emit_failed' };
  }

  const decision = decideRemediation({
    owner: work.owner,
    repo: work.repo,
    prNumber: work.prNumber,
    headSha: work.headSha,
    verdict: 'CHANGES_REQUESTED',
    findings: verdict.findings ?? [],
    verdictBody: buildReviewBody(work, verdict),
    priorAttempts,
    owningLane: work.author || null,
  });

  if (!decision.emit) return { emitted: false, reason: decision.reason };

  try {
    await deps.emitRemediationCandidate(decision.body);
  } catch {
    return { emitted: false, reason: 'emit_failed' };
  }
  return { emitted: true, attempt: decision.body.attempt };
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 120);
  return 'unknown_error';
}

async function finish(
  deps: SubmitDeps,
  work: ReviewWorkItem,
  headSha: string,
  outcome: SubmitOutcome
): Promise<SubmitOutcome> {
  try {
    await deps.recordReceipt({
      correlationId: work.correlationId,
      messageId: work.messageId,
      owner: work.owner,
      repo: work.repo,
      prNumber: work.prNumber,
      headSha,
      disposition: outcome.disposition,
      ...(outcome.event ? { event: outcome.event } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.remediation ? { remediation: outcome.remediation } : {}),
    });
  } catch {
    // Receipt failure never converts a classified outcome into a throw.
  }
  return outcome;
}
