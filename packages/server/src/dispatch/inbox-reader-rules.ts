/**
 * The xo/operator mailbox triage rules (WO-HARNESS-DO-MAILBOX-TRIAGE-DIGEST-01).
 *
 * Each queued row is assigned to the FIRST matching rule. Every rule names an
 * action:
 *   DROP     -- machine disposition 'expired' (benign bookkeeping, terminal).
 *   DIGEST   -- surface in the digest, then machine disposition 'auto_surfaced'.
 *   COLLAPSE -- keep the newest per collapse_key open for the digest, DROP the
 *               older duplicates as 'superseded'.
 *   BRING    -- leave open, list at the top of the digest, and interrupt only
 *               when the event-routing table says so.
 *
 * Hard invariants (never silently drop something a person must read):
 *   - a row at Dispatch priority 'blocker' is never DROP/DIGEST-and-dispose or
 *     COLLAPSE-older; it is BRING.
 *   - a sender the triage table does not recognize is never disposed; it is
 *     BRING (the default fallthrough).
 *   - a body that the event-routing table classifies NEEDS_A_PERSON or BLOCKER
 *     overrides any tentative DROP/DIGEST/COLLAPSE to BRING.
 *
 * The classifier is pure. Rules that depend on GitHub issue/PR state (X3c, X4a,
 * O2, O3b, O5a, O5b) read it from the injected `ghState` lookup; the reader
 * resolves and caches those states (bounded per run) and passes them in.
 */

import type { DispatchMessage } from '@archon/core/db/dispatch';
import { BENIGN_RECEIPT_DISPOSITIONS } from '@archon/overseer/pr-review-wiring';
import { classifyOpsEvent } from './ops-event-routing';

export type InboxAction = 'DROP' | 'DIGEST' | 'COLLAPSE' | 'BRING';
/** Triage/routing class carried through to the reader so BRING rows can be routed. */
export type InboxClass = 'ROUTINE' | 'NEEDS_A_PERSON' | 'BLOCKER';
/** Resolved GitHub subject state for the rules that depend on it. */
export type GhSubjectState = 'OPEN' | 'CLOSED' | 'MERGED' | 'UNKNOWN';

export type InboxMessage = Pick<
  DispatchMessage,
  | 'id'
  | 'sender'
  | 'task_type'
  | 'recipient'
  | 'body'
  | 'subject_key'
  | 'created_at'
  | 'status'
  | 'acknowledged_at'
  | 'addressed_at'
  | 'route_disposition'
> & { priority?: string };

export interface InboxClassification {
  class: InboxClass;
  rule_id: string;
  action: InboxAction;
  reason: string;
  collapse_key: string | null;
}

export interface InboxClassifyContext {
  now?: Date;
  /** Resolved GitHub state for a subject_key, or undefined when not resolved. */
  ghState?: (subjectKey: string) => GhSubjectState | undefined;
}

const DAY_MS = 86_400_000;
const AGE_THRESHOLD_DAYS = 14;

/** Canonical Duty Officer escalation senders (escalateToXo historically 'dispatch'). */
const DO_SENDERS = new Set(['dispatch', 'duty-officer', 'do']);
/** Non-system agent-seat senders whose xo rows are triaged by X5a/X5b/X5c. */
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
/** Overseer receipt producers whose operator rows are triaged by O1-O4. */
const OVERSEER_SENDERS = new Set(['overseer', 'overseer-review-route']);
/** Senders whose operator rows a person must read (O10). */
const O10_SENDERS = new Set(['voice', 'xo', 'xo-board']);
/** Dispositions that mark an operator receipt as a MERGED/CLOSED-eligible change request. */
const CHANGE_REQUEST_DISPOSITIONS = new Set([
  'changes_requested',
  'blocked',
  'blocked_required_contexts_unavailable',
  'custody',
  'merge_custody_pending',
]);
/** Dispositions that are receipt failures a person must read (O3a). */
const RECEIPT_FAILURE_DISPOSITIONS = new Set([
  'merge_custody_conflict',
  'submission_failed',
  'rejected_signature',
]);

function result(
  cls: InboxClass,
  rule_id: string,
  action: InboxAction,
  reason: string,
  collapse_key: string | null = null
): InboxClassification {
  return { class: cls, rule_id, action, reason, collapse_key };
}

function ageDays(message: InboxMessage, now: Date): number {
  const created = Date.parse(message.created_at);
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, (now.getTime() - created) / DAY_MS);
}

function parseBody(message: InboxMessage): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(message.body) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}

function disposition(body: Record<string, unknown> | null): string | null {
  const value = body?.disposition;
  return typeof value === 'string' ? value : null;
}

function bodyKind(body: Record<string, unknown> | null): string | null {
  const value = body?.kind;
  return typeof value === 'string' ? value : null;
}

/** The single routing verdict, computed once per classify call (pure, no suppression). */
function routeClass(message: InboxMessage): InboxClass {
  const verdict = classifyOpsEvent({
    sender: message.sender,
    task_type: message.task_type,
    priority: message.priority ?? null,
    body: message.body,
    subject_key: message.subject_key,
  });
  return verdict.class;
}

/**
 * The ordered rule table. Each rule's `match` is sender/recipient-scoped so an
 * unrecognized sender never reaches a disposing rule -- it falls through to the
 * BRING default. Rules that need GitHub state read it from `ctx.ghState`.
 */
function matchXoRules(
  message: InboxMessage,
  ctx: Required<Pick<InboxClassifyContext, 'now'>> & InboxClassifyContext
): InboxClassification | null {
  const now = ctx.now;
  const gh = (key: string | null): GhSubjectState =>
    key && ctx.ghState ? (ctx.ghState(key) ?? 'UNKNOWN') : 'UNKNOWN';
  const body = parseBody(message);
  const kind = bodyKind(body);
  const sender = message.sender.toLowerCase();

  // X1: stale taskmaster nudge.
  if (
    sender === 'taskmaster' &&
    /^nudge:/i.test(message.body.trim()) &&
    ageDays(message, now) > AGE_THRESHOLD_DAYS
  ) {
    return result('ROUTINE', 'X1', 'DROP', 'stale taskmaster nudge older than 14 days');
  }
  // X2: expectation-exhausted notice (digest keeps one summary line; reader owns it).
  if (/expectation exhausted/i.test(message.body)) {
    return result(
      'ROUTINE',
      'X2',
      'DROP',
      'expectation EXHAUSTED notice, summarized in the digest'
    );
  }
  // X4a/X4b: xo escalation handoffs keyed on a GitHub subject.
  if (kind === 'xo_escalation_handoff') {
    const state = gh(message.subject_key);
    if (state === 'MERGED' || state === 'CLOSED') {
      return result(
        'ROUTINE',
        'X4a',
        'DROP',
        'escalation handoff whose gh subject is merged or closed'
      );
    }
    return result('ROUTINE', 'X4b', 'DIGEST', 're-verify escalation handoff on an open subject');
  }
  // X3b/X3c/X3a: Duty Officer escalations to xo.
  if (DO_SENDERS.has(sender) && message.subject_key) {
    if (/^digest:/i.test(message.subject_key)) {
      return result('ROUTINE', 'X3b', 'DIGEST', 'duty officer digest escalation');
    }
    if (/^gh:/i.test(message.subject_key) && gh(message.subject_key) === 'OPEN') {
      // Newest per open issue; routing override promotes to BRING when it needs a person.
      return result(
        'ROUTINE',
        'X3c',
        'DIGEST',
        'newest duty officer escalation per open issue',
        message.subject_key
      );
    }
    return result(
      'ROUTINE',
      'X3a',
      'COLLAPSE',
      'duplicate duty officer escalation',
      message.subject_key
    );
  }
  // X5a/X5b/X5c: agent-seat rows.
  if (SEAT_SENDERS.has(sender)) {
    const text = message.body.trim();
    const isReceiptOrProbe =
      /^pong$/i.test(text) ||
      /\bpong\b/i.test(text) ||
      /^probe$/i.test(text) ||
      /\bprobe\b/i.test(text) ||
      (kind !== null && /receipt/i.test(kind)) ||
      /\breceipt\b/i.test(text);
    if (ageDays(message, now) > AGE_THRESHOLD_DAYS) {
      if (isReceiptOrProbe) {
        return result('ROUTINE', 'X5a', 'DROP', 'stale seat receipt, PONG or probe');
      }
      return result('ROUTINE', 'X5b', 'DIGEST', 'older seat ask or report, summarized once');
    }
    return result('ROUTINE', 'X5c', 'BRING', 'recent seat message a person should read');
  }
  return null;
}

function matchOperatorRules(
  message: InboxMessage,
  ctx: Required<Pick<InboxClassifyContext, 'now'>> & InboxClassifyContext
): InboxClassification | null {
  const now = ctx.now;
  const gh = (key: string | null): GhSubjectState =>
    key && ctx.ghState ? (ctx.ghState(key) ?? 'UNKNOWN') : 'UNKNOWN';
  const body = parseBody(message);
  const kind = bodyKind(body);
  const disp = disposition(body);
  const sender = message.sender.toLowerCase();
  const text = message.body.trim();

  // O10: rows a person must read.
  if (O10_SENDERS.has(sender)) {
    return result('ROUTINE', 'O10', 'BRING', 'voice/xo/xo-board seat row');
  }
  // O1-O4: overseer review receipts and run reports.
  if (OVERSEER_SENDERS.has(sender)) {
    const isPrReviewReceipt = kind?.startsWith('pr_review_') ?? false;
    if (isPrReviewReceipt && disp !== null) {
      // O1: benign review receipt.
      if (BENIGN_RECEIPT_DISPOSITIONS.has(disp)) {
        return result('ROUTINE', 'O1', 'DROP', 'benign review receipt');
      }
      // O3a: receipt failure a person must read.
      if (RECEIPT_FAILURE_DISPOSITIONS.has(disp)) {
        return result('ROUTINE', 'O3a', 'BRING', 'review receipt failure');
      }
      // O2/O3b: change-request receipt, by PR state.
      if (CHANGE_REQUEST_DISPOSITIONS.has(disp)) {
        const state = gh(message.subject_key);
        if (state === 'MERGED' || state === 'CLOSED') {
          return result('ROUTINE', 'O2', 'DROP', 'change-request receipt on a merged or closed PR');
        }
        return result(
          'ROUTINE',
          'O3b',
          'DIGEST',
          'change-request receipt on an open PR, newest per PR',
          message.subject_key
        );
      }
    }
    // O4a/O4b: generic overseer run reports by age.
    if (ageDays(message, now) > AGE_THRESHOLD_DAYS) {
      return result('ROUTINE', 'O4a', 'DROP', 'overseer run report older than 14 days');
    }
    return result('ROUTINE', 'O4b', 'DIGEST', 'recent overseer run report');
  }
  // O5a/O5b: Unclaimed P0 repeats.
  if (/unclaimed p0/i.test(text)) {
    const state = gh(message.subject_key);
    if (state === 'MERGED' || state === 'CLOSED') {
      return result('ROUTINE', 'O5a', 'DROP', 'Unclaimed P0 repeat on a closed or merged issue');
    }
    return result(
      'ROUTINE',
      'O5b',
      'COLLAPSE',
      'Unclaimed P0 repeat on an open issue',
      message.subject_key
    );
  }
  // O6: dead-man alarms.
  if (/\bdead[-\s]?man\b/i.test(text)) {
    return result('ROUTINE', 'O6', 'COLLAPSE', 'dead-man alarm', 'deadman');
  }
  // O7: Fuelglass seat-gate notices.
  if (/\bfuelglass\b/i.test(text) && /seat[-\s]?gate/i.test(text)) {
    return result('ROUTINE', 'O7', 'COLLAPSE', 'Fuelglass seat-gate notice', 'fuelglass-seat-gate');
  }
  // O8: Taskmaster daily count digests.
  if (sender === 'taskmaster' && /\bdaily\b/i.test(text)) {
    const key = message.subject_key ?? `taskmaster-daily:${utcDate(message.created_at)}`;
    return result('ROUTINE', 'O8', 'COLLAPSE', 'Taskmaster daily count digest', key);
  }
  // O9a/O9b: Duty Officer operator rows.
  if (DO_SENDERS.has(sender)) {
    if (text.toLowerCase() === 'probe') {
      return result('ROUTINE', 'O9a', 'DROP', 'duty officer probe');
    }
    return result(
      'ROUTINE',
      'O9b',
      'COLLAPSE',
      'duty officer pass',
      `do-pass:${utcDate(message.created_at)}`
    );
  }
  return null;
}

function utcDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Assign a queued row to its first matching triage rule, then enforce the hard
 * invariants. Returns {class, rule_id, action, reason, collapse_key}.
 */
export function classifyInboxMessage(
  message: InboxMessage,
  ctx: InboxClassifyContext = {}
): InboxClassification {
  const now = ctx.now ?? new Date();
  const scopedCtx = { ...ctx, now };

  // Invariant 1: a blocker-priority row is always surfaced, never disposed.
  if (message.priority === 'blocker') {
    return result('BLOCKER', 'blocker_priority', 'BRING', 'blocker priority is never disposed');
  }

  const matched =
    message.recipient === 'xo'
      ? matchXoRules(message, scopedCtx)
      : message.recipient === 'operator'
        ? matchOperatorRules(message, scopedCtx)
        : null;

  // Invariant 2: an unrecognized sender/recipient falls through to BRING.
  if (!matched) {
    return result(
      'ROUTINE',
      'unrecognized',
      'BRING',
      'no triage rule matched; surface for a person'
    );
  }

  // Invariant 3: a body the routing table flags NEEDS_A_PERSON or BLOCKER is
  // never DROP/DIGEST/COLLAPSE -- override to BRING, keeping the matched rule id.
  if (matched.action !== 'BRING') {
    const route = routeClass(message);
    if (route === 'NEEDS_A_PERSON' || route === 'BLOCKER') {
      return result(
        route,
        matched.rule_id,
        'BRING',
        `${matched.reason} (routed ${route})`,
        matched.collapse_key
      );
    }
  }
  return matched;
}

/**
 * True when classifying this row MAY require a GitHub issue/PR state lookup
 * (X3c, X4a, O2/O3b, O5a/O5b). The reader uses this to bound how many distinct
 * subjects it resolves per run.
 */
export function needsGithubState(message: InboxMessage): boolean {
  if (!message.subject_key) return false;
  if (message.priority === 'blocker') return false;
  const body = parseBody(message);
  const kind = bodyKind(body);
  const disp = disposition(body);
  const sender = message.sender.toLowerCase();
  if (message.recipient === 'xo') {
    if (kind === 'xo_escalation_handoff') return true;
    if (DO_SENDERS.has(sender) && /^gh:/i.test(message.subject_key)) return true;
    return false;
  }
  if (message.recipient === 'operator') {
    if (OVERSEER_SENDERS.has(sender) && disp !== null && CHANGE_REQUEST_DISPOSITIONS.has(disp)) {
      return true;
    }
    if (/unclaimed p0/i.test(message.body)) return true;
    return false;
  }
  return false;
}
