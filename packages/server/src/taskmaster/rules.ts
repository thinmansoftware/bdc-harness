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
 */

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
    const clock = nudgeClockMs(thread);
    const bucket = Math.floor(context.nowMs / clock);
    return {
      type: 'nudge',
      threadRef: thread.ref,
      recipient: thread.recipient,
      body:
        `Nudge: ${thread.ref} (${thread.priority}) has had no activity past its ` +
        `${Math.round(clock / MINUTE_MS)}min clock. Please post a status update, ` +
        'progress the item, or mark it blocked with a reason. Begin the update with ' +
        '[PROGRESS] or [BLOCKED] so the source-of-truth change can be verified.',
      idempotencyKey: `tm:nudge:${thread.ref}:${bucket}`,
      actsImmediately: false,
    };
  }

  return null;
}
