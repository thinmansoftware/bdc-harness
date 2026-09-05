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
  'fire_cauldron',
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

/**
 * Structural content contract for ordinary nudges (M-155 WO 3). A
 * content-complete nudge body (composeNudgeBody) always carries:
 *   - a quoted item title,
 *   - an explicit owner slot ("owner: <login-or-UNKNOWN>"),
 *   - a blocker or next-action clause ("Blocked: ..." / "Next action: ...").
 * The guard verifies these parts mechanically instead of trusting callers to
 * self-report via `contentIncomplete` -- a nudge body missing any part is
 * rejected content_incomplete no matter how it was constructed.
 */
const NUDGE_TITLE_RE = /"[^"]+"/;
const NUDGE_OWNER_RE = /\bowner:\s*\S+/i;
const NUDGE_WHY_RE = /\b(?:Blocked|Next action):\s*\S+/i;

export function isContentCompleteNudgeBody(body: string): boolean {
  return NUDGE_TITLE_RE.test(body) && NUDGE_OWNER_RE.test(body) && NUDGE_WHY_RE.test(body);
}

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

  // M-155 WO 3: a proposal whose body is null/absent or that is flagged
  // content-incomplete is an ORDINARY rejection (journal-only skip), NOT a
  // forbiddenEffect -- the auto HARD_PAUSE circuit is reserved for
  // unauthorized effects, and an incomplete message is a normal skip, not a
  // safety breach.
  if (proposal.contentIncomplete === true || typeof proposal.body !== 'string') {
    return {
      allowed: false,
      reason:
        'content_incomplete: the message lacks the item content (title, owner, ' +
        'blocker or next action) required for a send; the item stays on the register.',
    };
  }

  if (!proposal.idempotencyKey || proposal.idempotencyKey.trim().length === 0) {
    return {
      allowed: false,
      reason: 'idempotency_key_missing: every Taskmaster effect must carry an idempotency key.',
    };
  }

  if (proposal.type === 'fire_cauldron') {
    const evidence = proposal.fireEvidence;
    if (
      !evidence ||
      !/^WO-[A-Z][A-Z0-9-]*-\d+$/.test(evidence.woId) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(evidence.targetRepo) ||
      typeof evidence.project !== 'string' ||
      !evidence.project.trim() ||
      !Number.isFinite(Date.parse(evidence.specVerifiedAt)) ||
      !evidence.noOpenOrMergedPr
    ) {
      return {
        allowed: false,
        reason:
          'fire_evidence_invalid: fire_cauldron requires a valid WO id, target repo, project, spec verification timestamp, and no-PR proof.',
      };
    }
  }

  const normalized = proposal.body.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return { allowed: false, reason: 'body_empty: refusing to send an empty message.' };
  }

  // Ignore balanced double-quoted spans such as WO titles when checking for
  // forbidden verbs. An unclosed quote is left in the scan target so it cannot
  // hide spend/send/deploy instructions in the remaining prose.
  const scanTarget = normalized.replace(/"[^"]*"/g, ' ');
  const match = SPEND_SEND_DEPLOY_RE.exec(scanTarget);
  if (match) {
    return {
      allowed: false,
      reason: `spend_send_deploy_verb_rejected: body contains forbidden verb '${match[0]}'. The Taskmaster has zero spend/send/deploy authority (M-15 tier wall).`,
    };
  }

  // M-155 WO 3: ordinary nudges must be content-complete. Verified
  // structurally here (title + owner + blocker/next-action parts), not by
  // trusting the contentIncomplete flag -- an ORDINARY reject, never a
  // HARD_PAUSE circuit.
  if (proposal.type.trim().toLowerCase() === 'nudge' && !isContentCompleteNudgeBody(normalized)) {
    return {
      allowed: false,
      reason:
        'content_incomplete: the nudge body lacks the required item content ' +
        '(quoted title, owner, and blocker or next action); the item stays on the register.',
    };
  }

  return { allowed: true };
}
