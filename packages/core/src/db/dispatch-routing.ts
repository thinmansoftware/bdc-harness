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
