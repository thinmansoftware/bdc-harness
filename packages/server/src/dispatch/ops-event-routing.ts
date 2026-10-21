/**
 * Ops-event routing table (WO-HARNESS-DO-MAILBOX-TRIAGE-DIGEST-01).
 *
 * One deterministic classifier that decides, for every event that would
 * otherwise interrupt the XO or land as an unread Dispatch mailbox row, whether
 * it is:
 *   ROUTINE        -> the Duty Officer's single daily digest comment. No row.
 *   NEEDS_A_PERSON -> interrupt (recipient 'xo' ops_interrupt, Dispatch normal).
 *   BLOCKER        -> interrupt (recipient 'xo' ops_interrupt, Dispatch blocker).
 *
 * First match wins, in the order documented inline. A second BLOCKER for the
 * same subject_key within 24 hours is downgraded to ROUTINE so a repeating
 * alarm cannot interrupt a person twice.
 *
 * This module is pure given its context: it owns no database handle and makes
 * no GitHub call. The caller (duty-officer-clock, taskmaster/loop) turns a
 * ROUTINE verdict into a digest line and an interrupt verdict into exactly one
 * recipient 'xo' row.
 */

export type OpsEventClass = 'ROUTINE' | 'NEEDS_A_PERSON' | 'BLOCKER';
export type OpsEventDestination = 'digest' | 'interrupt';

export interface OpsEvent {
  /** Canonical dispatch sender (e.g. 'taskmaster', 'codex', 'overseer'). */
  sender: string;
  /** Dispatch task_type, when known (e.g. 'run_report', 'agent_message'). */
  task_type?: string | null;
  /** Dispatch priority of the originating row, when known. */
  priority?: string | null;
  /** The event text the rules match against. */
  body: string;
  /** Canonical subject_key, used for the 24h same-subject blocker suppression. */
  subject_key?: string | null;
  /**
   * Explicit hint that this is a Taskmaster blocker_report. Callers identify it
   * by the idempotency-key namespace (duty-officer-clock) or the proposal type
   * (taskmaster/loop); the router does not re-derive it from the body.
   */
  taskmaster_blocker_report?: boolean;
}

export interface OpsRouteResult {
  class: OpsEventClass;
  destination: OpsEventDestination;
  /** The first-match-wins step id that decided the class. */
  rule: string;
  reason: string;
  /**
   * The default action if the interrupt is left unanswered. Non-empty for
   * NEEDS_A_PERSON and BLOCKER; empty string for ROUTINE.
   */
  default_if_unanswered: string;
}

/**
 * Suppression store for the 24h same-subject blocker rule. Injected so the unit
 * test can drive the clock deterministically; the clock supplies an in-memory
 * implementation.
 */
export interface OpsRouteContext {
  now: Date;
  /** ISO timestamp of the most recent prior BLOCKER interrupt for this subject. */
  lastBlockerAt?: (subjectKey: string) => string | null | undefined;
  /** Record that a BLOCKER interrupt fired for this subject at the given time. */
  recordBlocker?: (subjectKey: string, atIso: string) => void;
}

const SEAT_SENDERS = new Set([
  'codex',
  'cursor',
  'claude',
  'grok',
  'desktop-claude',
  'codex-desktop',
  'codex-voice',
  'xo-board',
  'arcb-owner',
]);

const EXPECTATION_EXHAUSTED = /^expectation exhausted\b/i;
const NO_RETRY_PATH =
  /\bretries exhausted\b|\bno retry\b|\bcannot retry\b|\bwill not retry\b|\bmax attempts\b|\bmax retries\b|\bgave up\b|\bgiven_up\b|\ball tiers exhausted\b/i;
const NAMES_RUN_OR_WO = /\bWO-[A-Z0-9][A-Z0-9-]*\b|\brun\b/i;
const SECURITY_MONEY =
  /\bsecurity\b|\bsecret\b|\bcredential\b|\bservice_role\b|\bmoney\b|\bbilling\b|\brefund\b|\bcharge\b/i;
const DECISION_NEEDED =
  /\bdecision needed\b|\bapprove\b|\bapproval\b|\bhuman-only\b|\brotate\b|\brotation\b|\blogin\b|\bowner:john\b|\bowner:board\b/i;
const CUSTOMER = /\bcustomer\b/i;
const CUSTOMER_IMPACT = /\bbroken\b|\bdown\b|\bwrong\b|\bfailing\b|\bovercharged\b/i;

const SUPPRESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

const defaultSuppression = new Map<string, string>();

function result(
  cls: OpsEventClass,
  rule: string,
  reason: string,
  defaultIfUnanswered: string
): OpsRouteResult {
  return {
    class: cls,
    destination: cls === 'ROUTINE' ? 'digest' : 'interrupt',
    rule,
    reason,
    default_if_unanswered: cls === 'ROUTINE' ? '' : defaultIfUnanswered,
  };
}

/**
 * Classify an ops event WITHOUT the suppression downgrade. Exported for tests
 * and for callers that only need the raw table verdict.
 */
export function classifyOpsEvent(event: OpsEvent): OpsRouteResult {
  const body = event.body ?? '';
  const sender = (event.sender ?? '').toLowerCase();
  const isTaskmaster = sender === 'taskmaster';
  const isBlockerPriority = event.priority === 'blocker';

  // (1) An explicit blocker priority, or a Taskmaster blocker_report, always
  // wins -- including an "expectation EXHAUSTED" body carried at blocker
  // priority, which rule (2) must NOT downgrade.
  if (isBlockerPriority || event.taskmaster_blocker_report) {
    return result(
      'BLOCKER',
      'R1_blocker_priority',
      event.taskmaster_blocker_report ? 'taskmaster_blocker_report' : 'blocker_priority',
      'XO triages the blocker; if unanswered it stays open on the ops-inbox issue.'
    );
  }

  // (2) An ORDINARY-priority Taskmaster "expectation EXHAUSTED" notice is a
  // routine summary; rule X2 owns its disposition in the reader.
  if (isTaskmaster && EXPECTATION_EXHAUSTED.test(body)) {
    return result(
      'ROUTINE',
      'R2_expectation_exhausted',
      'taskmaster_expectation_exhausted_notice',
      ''
    );
  }

  // (3) A failure with no retry path, scoped to a lane-run or WO event.
  const isRunOrWoEvent = event.task_type === 'run_report' || NAMES_RUN_OR_WO.test(body);
  if (isRunOrWoEvent && NO_RETRY_PATH.test(body)) {
    return result(
      'BLOCKER',
      'R3_no_retry_path',
      'failure_with_no_retry_path',
      'XO decides whether to refire or abandon the run; if unanswered it stays open.'
    );
  }

  // (4) An owner question from a non-system seat.
  if (SEAT_SENDERS.has(sender) && body.includes('?')) {
    return result(
      'BLOCKER',
      'R4_owner_question',
      'owner_question',
      'XO answers the question; if unanswered the seat stays blocked.'
    );
  }

  // (5) Security or money.
  if (SECURITY_MONEY.test(body)) {
    return result(
      'BLOCKER',
      'R5_security_money',
      'security_or_money',
      'XO escalates to John; if unanswered it stays open as a blocker.'
    );
  }

  // (6) A decision, a human-only step, or a credential rotation.
  if (DECISION_NEEDED.test(body)) {
    return result(
      'NEEDS_A_PERSON',
      'R6_decision_needed',
      'decision_or_human_only_step',
      'XO or the board decides; if unanswered the default is to hold the item.'
    );
  }

  // (7) A customer-facing risk.
  if (CUSTOMER.test(body) && CUSTOMER_IMPACT.test(body)) {
    return result(
      'NEEDS_A_PERSON',
      'R7_customer_risk',
      'customer_facing_risk',
      'XO assesses customer impact; if unanswered the default is to hold and notify John.'
    );
  }

  // (8) Everything else.
  return result('ROUTINE', 'R8_default', 'no_interrupt_rule_matched', '');
}

/**
 * Classify an ops event and apply the 24h same-subject blocker suppression.
 *
 * A BLOCKER whose subject_key already produced a BLOCKER interrupt within the
 * last 24 hours is downgraded to ROUTINE (destination digest). When a BLOCKER
 * is NOT suppressed it is recorded so the next one inside the window is.
 */
export function routeOpsEvent(event: OpsEvent, ctx?: OpsRouteContext): OpsRouteResult {
  const now = ctx?.now ?? new Date();
  const lastBlockerAt =
    ctx?.lastBlockerAt ?? ((key: string): string | null => defaultSuppression.get(key) ?? null);
  const recordBlocker =
    ctx?.recordBlocker ??
    ((key: string, atIso: string): void => void defaultSuppression.set(key, atIso));

  const verdict = classifyOpsEvent(event);
  if (verdict.class !== 'BLOCKER') return verdict;

  const subjectKey = event.subject_key ?? null;
  if (!subjectKey) return verdict;

  const prior = lastBlockerAt(subjectKey);
  if (prior) {
    const priorMs = Date.parse(prior);
    if (Number.isFinite(priorMs) && now.getTime() - priorMs < SUPPRESSION_WINDOW_MS) {
      return result(
        'ROUTINE',
        'R0_blocker_suppressed_24h',
        `repeat blocker for ${subjectKey} within 24h`,
        ''
      );
    }
  }
  recordBlocker(subjectKey, now.toISOString());
  return verdict;
}

/** Test-only: clear the module-level default suppression store. */
export function resetOpsRouteSuppressionForTests(): void {
  defaultSuppression.clear();
}
