/**
 * Taskmaster Slice 1 rules (WO-HARNESS-TASKMASTER-SLICE1-01, M-133).
 *
 * Pure functions only: thread classification and next-action computation.
 * No I/O, no clock reads -- the caller injects `now`.
 *
 * Nudge clocks per the ratified Q1 numbers: 30min P0/customer, 4h P1,
 * 24h P2-P3. Exceptions (undelivered ratified rulings, unclaimed P0s) act
 * on the tick that confirms eligibility; ordinary nudges require the same
 * proposal to be eligible on TWO consecutive ticks before acting.
 *
 * NOTE (Rule 17): the WO spec cites duty_officer.ts as the source of the
 * idle/stale math, but the live file contains transport + content-guard code
 * only -- no staleness classification exists there to port. The math here is
 * implemented directly from spec Section 8's ratified nudge clocks.
 *
 * Exception-push extension (WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01, M-155 WO
 * 3): nudges now compose from the adoption projection (title/owner/blocker/next
 * action) and stay quiet on threads whose own grader called them noise. The
 * functions here remain PURE (no I/O, no clock reads) -- the caller injects the
 * adoption row, graded journal rows, and any active suppression record.
 */
import { createHash } from 'crypto';
import type { TmAdoptionRow, TmJournalEntry, TmSuppressionRow } from '@archon/core/db/taskmaster';

export type ThreadPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type ThreadClass = 'ready' | 'stale' | 'blocked' | 'healthy';
export type TmActionType = 'deliver_ruling' | 'nudge' | 'escalate_p0' | 'digest';

export interface ThreadSnapshot {
  /** Stable reference, e.g. "gh:owner/repo#123" or "dispatch:<message-id>" */
  ref: string;
  priority: ThreadPriority;
  /** Customer-facing threads use the P0 clock regardless of priority. */
  isCustomerFacing?: boolean;
  /** ISO timestamp of last observed activity on the thread. */
  lastActivityAt: string;
  /** Blocked threads are watched, never nudged (John's decision surface). */
  isBlocked?: boolean;
  /** Ratified ruling sitting undelivered for this thread's seat. */
  undeliveredRulingId?: string;
  /** P0 with no assignee/claim. */
  isUnclaimedP0?: boolean;
  /** Recipient seat for any message about this thread. */
  recipient: string;
}

export interface ActionProposal {
  type: TmActionType;
  threadRef: string;
  recipient: string;
  body: string;
  idempotencyKey: string;
  /** True for the exception classes that act on the confirming tick. */
  actsImmediately: boolean;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Ratified Q1 nudge clocks. */
export const NUDGE_CLOCK_MS: Record<ThreadPriority, number> = {
  P0: 30 * MINUTE_MS,
  P1: 4 * HOUR_MS,
  P2: 24 * HOUR_MS,
  P3: 24 * HOUR_MS,
};

export const CUSTOMER_CLOCK_MS = 30 * MINUTE_MS;

/** Max automated interventions per item per 24h (ratified budget). */
export const MAX_INTERVENTIONS_PER_ITEM_24H = 3;

export function nudgeClockMs(
  thread: Pick<ThreadSnapshot, 'priority' | 'isCustomerFacing'>
): number {
  if (thread.isCustomerFacing) return CUSTOMER_CLOCK_MS;
  return NUDGE_CLOCK_MS[thread.priority];
}

/** Classify a thread at `nowMs` (epoch millis). */
export function classifyThread(thread: ThreadSnapshot, nowMs: number): ThreadClass {
  if (thread.isBlocked) return 'blocked';
  if (thread.undeliveredRulingId || thread.isUnclaimedP0) return 'ready';
  const lastActivityMs = Date.parse(thread.lastActivityAt);
  if (Number.isNaN(lastActivityMs)) {
    // Unparseable activity timestamp: treat as healthy rather than guessing
    // staleness from garbage. The read layer logs the anomaly.
    return 'healthy';
  }
  const idleMs = nowMs - lastActivityMs;
  return idleMs >= nudgeClockMs(thread) ? 'stale' : 'healthy';
}

export interface NextActionContext {
  /** Automated interventions already journaled for this item in last 24h. */
  interventionsLast24h: number;
  nowMs: number;
  /**
   * Adoption projection row for this thread (WO 1). Optional: undefined means
   * the row was never enriched (e.g. adoption refresh has not run yet). A nudge
   * composes its content from this row; the exempt verbs ignore it.
   */
  adoption?: TmAdoptionRow;
  /**
   * Graded journal rows scoped to this thread's canonical ref, supplied by the
   * caller for noise suppression. Pure -- the function does no I/O.
   */
  grades?: TmJournalEntry[];
  /** Active persistent suppression record for this thread's canonical ref, if any. */
  suppression?: TmSuppressionRow;
}

/**
 * Named seats a nudge may be routed to. Mirrors the guard allowlist members;
 * routing chooses a mailbox and writes nothing to GitHub (this is NOT
 * assignment). Only 'xo' and 'operator' currently have a documented drainer.
 */
export type TmRecipient = 'xo' | 'major-build' | 'captain-ci' | 'operator';

/**
 * owner_login -> recipient routing. SHIPS EMPTY so every owner resolves to 'xo'
 * (the default) -- the only nudge mailbox with a documented drainer (XO's
 * session-start reflex; John drains 'operator'). 'major-build' and 'captain-ci'
 * have NO reader, so routing a nudge there would manufacture a second
 * dead-letter box -- exactly the failure this WO exists to end. Widen an entry
 * ONLY once its target mailbox has a documented drain path; that is a data
 * change (a follow-on WO), not a code change here.
 */
const OWNER_RECIPIENT_MAP: Record<string, TmRecipient> = {};

/** Resolve a nudge recipient from the item owner. Currently always 'xo'. */
export function resolveRecipient(ownerLogin: string | null | undefined): TmRecipient {
  const key = (ownerLogin ?? '').trim().toLowerCase();
  return OWNER_RECIPIENT_MAP[key] ?? 'xo';
}

/**
 * Stable hash over the fields a human would act on. Excludes evidence_observed_at
 * and attempt counts (those move without the work moving). Used to decide when
 * suppression lifts: a different hash means the item actually moved.
 */
export function adoptionContentHash(adoption: TmAdoptionRow): string {
  const parts = [
    adoption.title ?? '',
    adoption.owner_login ?? '',
    String(adoption.is_blocked),
    adoption.blocked_reason ?? '',
    adoption.next_action ?? '',
    adoption.last_movement_at ?? '',
  ];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * Compose a nudge body from the adoption row, or null when the row lacks the
 * parts a human needs to act without opening the issue. Null means INELIGIBLE
 * -- the caller must not send (it surfaces on the register instead). Eligible
 * requires a title AND at least one of (blocked_reason, next_action).
 */
export function composeNudgeBody(thread: ThreadSnapshot, adoption?: TmAdoptionRow): string | null {
  if (!adoption) return null;
  const title = adoption.title?.trim();
  if (!title) return null;
  const nextAction = adoption.next_action?.trim() || null;
  const blockedReason = adoption.blocked_reason?.trim() || null;
  if (!nextAction && !blockedReason) return null;

  const owner = adoption.owner_login?.trim() || 'UNKNOWN';
  const url = `https://github.com/${adoption.repo}/issues/${adoption.issue_number}`;
  const detail = blockedReason ? `Blocked: ${blockedReason}` : `Next action: ${nextAction}`;
  const movement = adoption.last_movement_at
    ? `last real movement ${adoption.last_movement_at}`
    : 'no recorded movement';

  return (
    `${title} (${thread.priority}) -- owner ${owner}. ${detail}. ` +
    `Item has ${movement}. Post [PROGRESS] or [BLOCKED] with a reason so the ` +
    `source of truth is updated. ${url}`
  );
}

/**
 * True when the two most recent GRADED journal rows for this thread are both
 * 'noise'. Pure -- the caller supplies grade rows scoped (and canonically
 * re-stamped) to the thread. Ungraded rows never count as noise: the audit found
 * 757 ungraded sends, and an ungraded send is not evidence of anything.
 */
export function isSuppressedByNoise(
  threadRef: string,
  grades: TmJournalEntry[],
  adoption?: TmAdoptionRow
): boolean {
  if (!adoption) return false;
  const graded = grades
    .filter(g => g.thread_ref === threadRef && g.grade !== null && g.graded_at !== null)
    .sort((a, b) => Date.parse(b.graded_at ?? '') - Date.parse(a.graded_at ?? ''));
  if (graded.length < 2) return false;
  return graded[0].grade === 'noise' && graded[1].grade === 'noise';
}

function fallbackNudgeBody(thread: ThreadSnapshot): string {
  return (
    `Stale item ${thread.ref} (${thread.priority}) needs a status update. ` +
    'Post [PROGRESS] or [BLOCKED] with a reason so the source of truth is updated.'
  );
}

function buildNudgeProposal(
  thread: ThreadSnapshot,
  context: NextActionContext,
  body: string
): ActionProposal {
  const clock = nudgeClockMs(thread);
  const bucket = Math.floor(context.nowMs / clock);
  return {
    type: 'nudge',
    threadRef: thread.ref,
    recipient: resolveRecipient(context.adoption?.owner_login),
    body,
    idempotencyKey: `tm:nudge:${thread.ref}:${bucket}`,
    actsImmediately: false,
  };
}

/**
 * Compute at most ONE typed proposal for a thread, or null for no-op.
 * Priority order within a thread: ruling delivery > P0 escalation > nudge.
 */
export function computeNextAction(
  thread: ThreadSnapshot,
  classification: ThreadClass,
  context: NextActionContext
): ActionProposal | null {
  if (classification === 'blocked' || classification === 'healthy') return null;
  if (context.interventionsLast24h >= MAX_INTERVENTIONS_PER_ITEM_24H) return null;

  if (thread.undeliveredRulingId) {
    return {
      type: 'deliver_ruling',
      threadRef: thread.ref,
      recipient: thread.recipient,
      body:
        `Ratified ruling ${thread.undeliveredRulingId} is addressed to you and has no ` +
        'delivery record. Please acknowledge it via the dispatch mailbox and act on it. ' +
        `Thread: ${thread.ref}.`,
      idempotencyKey: `tm:deliver_ruling:${thread.undeliveredRulingId}`,
      actsImmediately: true,
    };
  }

  if (thread.isUnclaimedP0) {
    const bucket = Math.floor(context.nowMs / NUDGE_CLOCK_MS.P0);
    return {
      type: 'escalate_p0',
      threadRef: thread.ref,
      recipient: 'operator',
      body:
        `Unclaimed P0: ${thread.ref} has no owner. This is an escalation for John's ` +
        'attention; no automated assignment is made (Slice 1 has no assignment authority).',
      idempotencyKey: `tm:escalate_p0:${thread.ref}:${bucket}`,
      actsImmediately: true,
    };
  }

  if (classification === 'stale') {
    const { adoption } = context;
    const body = composeNudgeBody(thread, adoption);
    if (body === null) {
      // No actionable content. A present-but-incomplete adoption row is the
      // audited noise class (355/384 graded nudges) -- do NOT send; it surfaces
      // on the register (WO 2) instead. A wholly ABSENT adoption row (undefined,
      // e.g. adoption refresh not yet run) keeps the pre-WO fallback nudge so a
      // stale thread is never silently dropped.
      if (adoption !== undefined) return null;
      return buildNudgeProposal(thread, context, fallbackNudgeBody(thread));
    }
    // Noise suppression: two consecutive 'noise' grades keep this quiet until
    // the adoption content hash changes (the work actually moved). The caller
    // persists tm_suppression; here it is a pure function of injected state.
    // (body !== null already implies adoption is defined; the `adoption &&`
    // guard is a type narrow for the hash call.)
    if (adoption && isSuppressedByNoise(thread.ref, context.grades ?? [], adoption)) {
      const currentHash = adoptionContentHash(adoption);
      const priorHash = context.suppression?.suppressed_until_hash ?? currentHash;
      if (priorHash === currentHash) return null;
    }
    return buildNudgeProposal(thread, context, body);
  }

  return null;
}
