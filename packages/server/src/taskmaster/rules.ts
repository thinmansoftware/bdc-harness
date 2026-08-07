/**
 * Taskmaster Slice 1 -- pure classification + action rules
 * (WO-HARNESS-TASKMASTER-SLICE1-01, M-133 ratified).
 *
 * These are PURE functions (no I/O, no clock of their own -- `now` is injected)
 * so the loop's decisions are deterministic and unit-testable. The idle/stale
 * math is ported from the duty-officer classifier: a thread is stale once it has
 * been idle past the nudge clock for its priority.
 *
 * Nudge clocks (Q1 adopted): 30min P0/customer, 4h P1, 24h P2-P3.
 */

export type ThreadPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'customer';
export type ThreadClass = 'ready' | 'stale' | 'blocked' | 'healthy';
export type TaskmasterActionType = 'deliver_ruling' | 'nudge' | 'escalate';

export interface TaskmasterThread {
  /** Stable reference for journaling + dedupe (e.g. "wo/42", "ruling/M-133"). */
  ref: string;
  priority: ThreadPriority;
  /** Epoch ms of the last observed activity on the thread. */
  lastActivityAt: number;
  /** True when the work has been claimed/assigned. */
  claimed: boolean;
  /** True when the thread is an undelivered, ratified ruling awaiting delivery. */
  undeliveredRuling?: boolean;
  /** True when an external blocker prevents progress (do not nudge a blocked item). */
  blocked?: boolean;
  /** Canonical recipient for any message this thread would generate. */
  recipient: string;
  /** Human-readable subject used to build the message body. */
  subject: string;
}

export interface TaskmasterProposal {
  threadRef: string;
  actionType: TaskmasterActionType;
  recipient: string;
  body: string;
  idempotencyKey: string;
  /**
   * Undelivered rulings and unclaimed P0s act on the CONFIRMING tick; everything
   * else must be eligible on TWO consecutive ticks before it may actuate.
   */
  actImmediately: boolean;
  priority: ThreadPriority;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Idle threshold (ms) after which a thread of the given priority is stale. */
export function nudgeClockMs(priority: ThreadPriority): number {
  switch (priority) {
    case 'P0':
    case 'customer':
      return 30 * MINUTE;
    case 'P1':
      return 4 * HOUR;
    case 'P2':
    case 'P3':
      return 24 * HOUR;
    default:
      return 24 * HOUR;
  }
}

/**
 * Classify a thread relative to `now`.
 *  - ready:   demands action on the confirming tick (undelivered ruling, or an
 *             unclaimed P0 past its clock).
 *  - blocked: an external blocker holds it -- monitor, do not nudge.
 *  - stale:   idle past its nudge clock -- a nudge is warranted.
 *  - healthy: within its clock -- leave it alone.
 */
export function classifyThread(thread: TaskmasterThread, now: number): ThreadClass {
  if (thread.undeliveredRuling) return 'ready';
  if (thread.blocked) return 'blocked';

  const idleMs = now - thread.lastActivityAt;
  const overClock = idleMs >= nudgeClockMs(thread.priority);

  if (thread.priority === 'P0' && !thread.claimed && overClock) return 'ready';
  if (overClock) return 'stale';
  return 'healthy';
}

function rulingBody(thread: TaskmasterThread): string {
  return `Ratified ruling for ${thread.subject} has not been delivered. Delivering the pending ruling to ${thread.recipient}.`;
}

function escalateBody(thread: TaskmasterThread): string {
  return `Unclaimed P0: ${thread.subject} has been idle past its 30-minute clock and remains unassigned. Escalating for immediate attention.`;
}

function nudgeBody(thread: TaskmasterThread): string {
  return `Reminder: ${thread.subject} (${thread.priority}) has been idle past its nudge clock. A status update or next step is needed to move it forward.`;
}

/**
 * Compute at most ONE typed proposal for a thread, or null for a no-op. Pure --
 * the caller enforces budgets, two-tick eligibility, pause, and dedupe.
 *
 * `epoch` is folded into the idempotency key so a proposal computed under a prior
 * (paused) epoch cannot collide with -- or replay as -- one computed after resume.
 */
export function computeNextAction(
  thread: TaskmasterThread,
  now: number,
  epoch: number
): TaskmasterProposal | null {
  const klass = classifyThread(thread, now);

  if (klass === 'ready' && thread.undeliveredRuling) {
    return {
      threadRef: thread.ref,
      actionType: 'deliver_ruling',
      recipient: thread.recipient,
      body: rulingBody(thread),
      idempotencyKey: `tm:deliver_ruling:${thread.ref}:${epoch}`,
      actImmediately: true,
      priority: thread.priority,
    };
  }

  if (klass === 'ready' && thread.priority === 'P0') {
    // Unclaimed P0 past clock -- escalate immediately.
    const dayBucket = Math.floor(now / (24 * HOUR));
    return {
      threadRef: thread.ref,
      actionType: 'escalate',
      recipient: thread.recipient,
      body: escalateBody(thread),
      idempotencyKey: `tm:escalate:${thread.ref}:${epoch}:${dayBucket}`,
      actImmediately: true,
      priority: thread.priority,
    };
  }

  if (klass === 'stale') {
    const dayBucket = Math.floor(now / (24 * HOUR));
    return {
      threadRef: thread.ref,
      actionType: 'nudge',
      recipient: thread.recipient,
      body: nudgeBody(thread),
      idempotencyKey: `tm:nudge:${thread.ref}:${epoch}:${dayBucket}`,
      actImmediately: false,
      priority: thread.priority,
    };
  }

  return null;
}
