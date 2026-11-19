/**
 * WO-HARNESS-DISPATCH-ROUTING-CUTOFF-01: dispatch routing constants.
 *
 * Since the cut-off, PR-review receipts go to a log recipient and real run
 * reports / owner cards go to the T3 desktop results queue. Rows queued to
 * `operator` before the cut-off are history: never cancelled, never deleted.
 */
export const T3_DESKTOP_RECIPIENT = 't3-desktop';
export const PR_REVIEW_LOG_RECIPIENT = 'pr-review-log';
/** UTC midnight, 2026-11-01. */
export const OPERATOR_HISTORY_CUTOFF = '2026-11-01T00:00:00.000Z';

/**
 * WO-HARNESS-RUN-REPORT-ACTING-XO-TO-OPERATOR (fence 281): the mailbox the XO
 * session-start drain and the operator-inbox-consumer read.
 */
export const OPERATOR_RECIPIENT = 'operator';

/**
 * WO-HARNESS-OVERSEER-OWNER-ROUTING-01: the responsible actor of a card whose
 * work has no recorded owner. It is NOT an XO principal; an unowned card is
 * an explicit bucket for John to assign (M-93 clause 2).
 */
export const UNOWNED_RESPONSIBLE_ACTOR = 'unowned';

/**
 * Responsible-actor values that name an XO principal. A run report owned by
 * any of these must reach the operator mailbox; a T3-only copy is invisible
 * to the XO. Only an EXPLICIT XO principal counts (M-93 clause 3): a blank
 * actor is no longer treated as XO, because XO is never automatically
 * assigned (M-93 clause 2).
 */
const XO_RESPONSIBLE_ACTORS: ReadonlySet<string> = new Set(['acting-xo', 'xo', 'operator']);

export function isXoResponsibleActor(actor: string | null | undefined): boolean {
  const normalized = (actor ?? '').trim().toLowerCase();
  return XO_RESPONSIBLE_ACTORS.has(normalized);
}
