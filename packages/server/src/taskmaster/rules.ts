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
 * Seat names -- and the aliases a human actually types in a [BLOCKED] marker --
 * that count as NAMING THE SEAT which must move. Anchored to the seat
 * vocabulary the Taskmaster can address (TmRecipient) plus 'john', the
 * documented human principal behind the 'operator' seat (guard.ts). Nothing
 * else counts: naming a vendor, a service, or a date does not tell the reader
 * who has to act.
 */
const SEAT_ALIASES: Readonly<Record<TmRecipient, readonly string[]>> = {
  xo: ['xo'],
  'major-build': ['major-build', 'major build', 'majorbuild'],
  'captain-ci': ['captain-ci', 'captain ci', 'captainci'],
  operator: ['operator', 'john'],
};

/** Regex-escape a literal alias for whole-token matching. */
function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The seat named by a free-text blocker reason, or null when it names none.
 *
 * A blocker becomes ACTIONABLE content only when the reader can tell which seat
 * has to move. "waiting on infra key" names no seat: it reads as an excuse, not
 * a request, and is exactly the audited noise class this WO exists to end. A
 * seatless blocker is therefore NOT sufficient content for an ordinary nudge
 * (composeNudgeBody discards it); the item surfaces on the register instead.
 *
 * Matching is case-insensitive and whole-token, so 'xo' does not fire inside an
 * unrelated word and 'john' does not fire inside 'johnson'. Pure.
 */
export function blockerNamesSeat(reason: string | null | undefined): TmRecipient | null {
  const text = (reason ?? '').trim().toLowerCase();
  if (!text) return null;
  for (const seat of Object.keys(SEAT_ALIASES) as TmRecipient[]) {
    for (const alias of SEAT_ALIASES[seat]) {
      if (new RegExp(`(?<![a-z0-9])${escapeLiteral(alias)}(?![a-z0-9])`).test(text)) {
        return seat;
      }
    }
  }
  return null;
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
 * Human-readable elapsed duration between an ISO instant and `nowMs`, e.g.
 * "3d 4h", "5h 12m", "9m". Pure: the caller injects `nowMs` (no clock read).
 * The composer reports "how long since real movement" rather than a raw
 * timestamp so a reader knows the age at a glance without doing date math.
 */
function elapsedSince(iso: string, nowMs: number | undefined): string {
  const thenMs = Date.parse(iso);
  if (Number.isNaN(thenMs) || nowMs === undefined) return 'an unknown duration';
  const totalMinutes = Math.floor(Math.max(0, nowMs - thenMs) / MINUTE_MS);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "How long since real movement" phrase from an adoption row, given `nowMs`. */
function movementPhrase(adoption: TmAdoptionRow, nowMs: number | undefined): string {
  return adoption.last_movement_at
    ? `Last real movement was ${elapsedSince(adoption.last_movement_at, nowMs)} ago`
    : 'No recorded movement';
}

/**
 * Compose a nudge body from the adoption row, or null when the row lacks the
 * parts a human needs to act without opening the issue. Null means INELIGIBLE
 * -- the caller must not send (it surfaces on the register instead). Eligible
 * requires a title AND at least one of:
 *   - a blocked_reason that NAMES A SEAT (blockerNamesSeat), or
 *   - a next_action.
 * A blocker that names no seat is NOT content: it says the item is stuck
 * without saying who unsticks it, which is the audited noise class. Such a row
 * is eligible only if it also carries a next_action, and the body then reports
 * that next action rather than the seatless blocker. The caller injects `nowMs`
 * so the body can report elapsed time since real movement (not a raw
 * timestamp); the function stays pure.
 */
export function composeNudgeBody(
  thread: ThreadSnapshot,
  adoption?: TmAdoptionRow,
  nowMs?: number
): string | null {
  if (!adoption) return null;
  const title = adoption.title?.trim();
  if (!title) return null;
  const nextAction = adoption.next_action?.trim() || null;
  const rawBlocker = adoption.blocked_reason?.trim() || null;
  // Discard a blocker that names no seat -- it is not actionable content, so it
  // cannot on its own make this row eligible (see the doc block above).
  const blockedReason = rawBlocker && blockerNamesSeat(rawBlocker) ? rawBlocker : null;
  if (!nextAction && !blockedReason) return null;

  const owner = adoption.owner_login?.trim() || 'UNKNOWN';
  const url = `https://github.com/${adoption.repo}/issues/${adoption.issue_number}`;
  const detail = blockedReason ? `Blocked: ${blockedReason}` : `Next action: ${nextAction}`;

  return (
    `${title} (${thread.priority}) -- owner ${owner}. ${detail}. ` +
    `${movementPhrase(adoption, nowMs)}. Post [PROGRESS] or [BLOCKED] with a reason ` +
    `so the source of truth is updated. ${url}`
  );
}

/**
 * Content enrichment appended to the exempt verbs (deliver_ruling, escalate_p0)
 * WHEN an adoption row with a title is available. Returns '' when there is no
 * usable adoption content -- the exempt verbs must still send on their own
 * merit (an undelivered ruling / unclaimed P0 is a governance fact, not an item
 * state fact), so a null title never suppresses them (Section 6 exemption).
 */
function adoptionEnrichment(adoption: TmAdoptionRow | undefined, nowMs: number): string {
  if (!adoption) return '';
  const title = adoption.title?.trim();
  if (!title) return '';
  const owner = adoption.owner_login?.trim() || 'UNKNOWN';
  const nextAction = adoption.next_action?.trim() || null;
  const blockedReason = adoption.blocked_reason?.trim() || null;
  const url = `https://github.com/${adoption.repo}/issues/${adoption.issue_number}`;
  const parts = [`Item: ${title} (owner ${owner})`];
  if (blockedReason) parts.push(`Blocked: ${blockedReason}`);
  else if (nextAction) parts.push(`Next action: ${nextAction}`);
  parts.push(movementPhrase(adoption, nowMs));
  parts.push(url);
  return ` ${parts.join('. ')}.`;
}

/**
 * True when the two most recent GRADED journal rows for this thread are both
 * 'noise' AND the adoption row's content is unchanged since the later (most
 * recent) of them. Pure -- the caller supplies grade rows scoped (and
 * canonically re-stamped) to the thread.
 *
 * The nudge journal row records `before_hash = adoptionContentHash(adoption)`
 * at send time (loop.ts), so comparing the live content hash against the later
 * noise grade's `before_hash` establishes that the work has NOT moved since the
 * grader called it noise. If the content moved after the grade (a different
 * hash), suppression must NOT apply -- otherwise newly-changed content would be
 * silenced immediately. Ungraded rows never count as noise: the audit found 757
 * ungraded sends, and an ungraded send is not evidence of anything.
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
  if (graded[0].grade !== 'noise' || graded[1].grade !== 'noise') return false;
  // Unchanged since the later noise grade: the live hash must match the hash
  // captured when that noise message was sent.
  return graded[0].before_hash === adoptionContentHash(adoption);
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
  if (context.interventionsLast24h >= MAX_INTERVENTIONS_PER_ITEM_24H) return null;

  // Exempt verbs FIRST -- evaluated before any classification short-circuit so a
  // thread that is also blocked/healthy but carries an undelivered ruling or is
  // an unclaimed P0 still acts (classifyThread returns 'blocked' when isBlocked
  // is set, which would otherwise swallow these governance facts). Both are
  // content-enriched when an adoption row is available but NEVER suppressed for
  // missing content (Section 6 exemption): a null title must not silence a P0.
  if (thread.undeliveredRulingId) {
    return {
      type: 'deliver_ruling',
      threadRef: thread.ref,
      recipient: thread.recipient,
      body:
        `Ratified ruling ${thread.undeliveredRulingId} is addressed to you and has no ` +
        'delivery record. Please acknowledge it via the dispatch mailbox and act on it. ' +
        `Thread: ${thread.ref}.` +
        adoptionEnrichment(context.adoption, context.nowMs),
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
        'attention; no automated assignment is made (Slice 1 has no assignment authority).' +
        adoptionEnrichment(context.adoption, context.nowMs),
      idempotencyKey: `tm:escalate_p0:${thread.ref}:${bucket}`,
      actsImmediately: true,
    };
  }

  // Ordinary nudges: only stale or blocked items, and only when the adoption row
  // carries full content (title + a seat-naming blocker or a next action). A
  // blocked item is nudged only when its blocker NAMES THE SEAT that must move
  // (Section 6 row 3); a blocker like "waiting on infra" is not content and is
  // held back to the register. A healthy item is never nudged.
  if (classification === 'stale' || classification === 'blocked') {
    const { adoption } = context;
    // A wholly ABSENT adoption row is INELIGIBLE: ordinary nudges require full
    // adoption content, so we send nothing (it surfaces on the register, WO 2)
    // rather than emitting a contentless fallback. This guard also narrows
    // `adoption` to defined for the hash/compose calls below.
    if (!adoption) return null;
    const body = composeNudgeBody(thread, adoption, context.nowMs);
    // Present-but-incomplete content (no title, or neither blocker nor next
    // action) is likewise ineligible -- this is the audited noise class.
    if (body === null) return null;

    // Noise suppression: keep quiet while the grader has called this thread
    // noise on unchanged content -- via the recent grades (isSuppressedByNoise
    // establishes the content hash is unchanged since the later noise grade) OR
    // the durable tm_suppression record (which survives grade rollover past the
    // 24h lookback). Suppression lifts the moment the content hash moves.
    const currentHash = adoptionContentHash(adoption);
    const noiseSuppressed = isSuppressedByNoise(thread.ref, context.grades ?? [], adoption);
    const durablySuppressed = context.suppression?.suppressed_until_hash === currentHash;
    if (noiseSuppressed || durablySuppressed) return null;

    return buildNudgeProposal(thread, context, body);
  }

  return null;
}
