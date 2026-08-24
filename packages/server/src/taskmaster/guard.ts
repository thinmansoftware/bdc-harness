/**
 * Taskmaster Slice 1 outbound guard (WO-HARNESS-TASKMASTER-SLICE1-01).
 *
 * Ported from BDC_XO/scripts/duty-officer/content-guard.ts: code-level
 * enforcement of what the design merely states. The Taskmaster's ONLY
 * authorized effect is a dispatch message of an allowlisted action type to
 * an allowlisted named seat, with a body free of spend/send/deploy verbs
 * and a non-empty idempotency key.
 *
 * Do NOT weaken these checks to make a tick pass. A rejection here is
 * journal-only (no send); a forbidden-effect class rejection additionally
 * HARD-PAUSES effects (auto-circuit tightens into pause, never KILL).
 */
import type { ActionProposal } from './rules';

/** The complete Slice 1 effect allowlist. Anything else is unauthorized. */
export const TM_ALLOWED_ACTION_TYPES = [
  'deliver_ruling',
  'nudge',
  'escalate_p0',
  'digest',
] as const;
export type TmAllowedActionType = (typeof TM_ALLOWED_ACTION_TYPES)[number];

/**
 * Named seats the Taskmaster may address. 'operator' is the John-facing
 * drain used for escalations and the daily digest (the 'john' dispatch
 * principal is seeded inactive). No broadcast, no 'board', no customers.
 */
export const TM_ALLOWED_RECIPIENTS = ['xo', 'major-build', 'captain-ci', 'operator'] as const;
export type TmAllowedRecipient = (typeof TM_ALLOWED_RECIPIENTS)[number];

/**
 * Spend/send/deploy verbs, ported from the DO content guard. The Taskmaster
 * has zero money/customer-send/production authority (M-15 tier wall); a
 * message body must never instruct such an action.
 */
const SPEND_SEND_DEPLOY_RE =
  /\b(charge|bill|invoice(?:d)?|refund|pay(?:ment|out)?|wire|transfer\s+funds|withdraw|deposit|purchase|buy(?:\s+now)?|discount(?:ed)?(?:\s+\w+){0,3}?\s+(?:\d+\s*%|\d+\s*percent|percent)|discount(?:ed)?\s+\d|price\s+match|comp(?:\s+the\s+order)?|send\s+(?:the\s+)?(?:email|sms|text|message|dm|invoice|listing)|email\s+the\s+customer|text\s+the\s+customer|post\s+to\s+(?:whatnot|instagram|facebook|discord)|publish\s+the\s+listing|go\s+live|deploy|merge\s+(?:to|into)\s+(?:main|master|prod|production)|push\s+to\s+prod(?:uction)?|activate\s+the\s+listing|mark\s+(?:it\s+)?send-ready)\b/i;

export interface GuardResult {
  allowed: boolean;
  reason?: string;
  /**
   * True when the rejection represents a forbidden EFFECT (unauthorized
   * action type or recipient) rather than fixable content. Forbidden
   * effects trigger the auto HARD_PAUSE circuit per the mode matrix.
   */
  forbiddenEffect?: boolean;
}

export function isAllowedActionType(actionType: string): actionType is TmAllowedActionType {
  return (TM_ALLOWED_ACTION_TYPES as readonly string[]).includes(actionType.trim().toLowerCase());
}

export function isAllowedRecipient(recipient: string): recipient is TmAllowedRecipient {
  return (TM_ALLOWED_RECIPIENTS as readonly string[]).includes(recipient.trim().toLowerCase());
}

/**
 * Validate a proposal before ANY effect. Checked in code before the
 * dispatch DAL is called; the DAL's own recipient assessment is a second,
 * independent layer.
 */
export function validateProposal(proposal: ActionProposal): GuardResult {
  if (!isAllowedActionType(proposal.type)) {
    return {
      allowed: false,
      forbiddenEffect: true,
      reason: `action_type_not_allowlisted: '${proposal.type}' is not a Slice 1 verb (allowed: ${TM_ALLOWED_ACTION_TYPES.join(', ')}).`,
    };
  }

  if (!isAllowedRecipient(proposal.recipient)) {
    return {
      allowed: false,
      forbiddenEffect: true,
      reason: `recipient_not_allowlisted: '${proposal.recipient}' is not a named seat the Taskmaster may address (allowed: ${TM_ALLOWED_RECIPIENTS.join(', ')}).`,
    };
  }

  if (!proposal.idempotencyKey || proposal.idempotencyKey.trim().length === 0) {
    return {
      allowed: false,
      reason: 'idempotency_key_missing: every Taskmaster effect must carry an idempotency key.',
    };
  }

  // A composer that could not build an actionable message returns a null body
  // (WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01). This is an ORDINARY skip -- an
  // incomplete message is not a safety breach, so forbiddenEffect stays false
  // and the auto-circuit (reserved for unauthorized effects) never trips.
  const rawBody: string | null | undefined = proposal.body;
  if (rawBody === null || rawBody === undefined) {
    return {
      allowed: false,
      forbiddenEffect: false,
      reason:
        'content_incomplete: proposal body is null -- the composer had no title/owner/next-action to send.',
    };
  }

  const normalized = rawBody.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return { allowed: false, reason: 'body_empty: refusing to send an empty message.' };
  }

  const match = SPEND_SEND_DEPLOY_RE.exec(normalized);
  if (match) {
    return {
      allowed: false,
      reason: `spend_send_deploy_verb_rejected: body contains forbidden verb '${match[0]}'. The Taskmaster has zero spend/send/deploy authority (M-15 tier wall).`,
    };
  }

  return { allowed: true };
}
