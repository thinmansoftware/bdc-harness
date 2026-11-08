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
 * Responsible-actor values that name an XO principal. A run report owned by
 * any of these must reach the operator mailbox; a T3-only copy is invisible
 * to the XO. `acting-xo` is also the default buildDispatchRunReportBody
 * writes when the card carries no actor, so a blank actor counts too.
 */
const XO_RESPONSIBLE_ACTORS: ReadonlySet<string> = new Set(['acting-xo', 'xo', 'operator']);

export function isXoResponsibleActor(actor: string | null | undefined): boolean {
  const normalized = (actor ?? '').trim().toLowerCase();
  return normalized === '' || XO_RESPONSIBLE_ACTORS.has(normalized);
}
