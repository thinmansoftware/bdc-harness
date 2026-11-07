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
import { RECIPIENT_ROUTES } from './recipients';

/** Complete WO tokens: uppercase alphanumeric segments and a 2+ digit ordinal. */
export const WO_ID_RE = /\b(?<!-)WO-(?:[A-Z0-9]+-)+\d{2,}\b(?!-)/;

/** The complete Slice 1 effect allowlist. Anything else is unauthorized. */
export const TM_ALLOWED_ACTION_TYPES = [
  'deliver_ruling',
  'nudge',
  'escalate_p0',
  'digest',
  'fire_cauldron',
  'blocker_report',
] as const;
export type TmAllowedActionType = (typeof TM_ALLOWED_ACTION_TYPES)[number];

/**
 * Named seats the Taskmaster may address. 'operator' is the John-facing
 * drain used for escalations and the daily digest (the 'john' dispatch
 * principal is seeded inactive). No broadcast, no 'board', no customers.
 *
 * 'duty-officer' (WO-HARNESS-TASKMASTER-BLOCKER-REPORT-TO-DO-01) is admitted
 * ONLY for the blocker_report verb -- the Duty Officer clock is its sole
 * consumer, relaying to the XO. The pairing is enforced in validateProposal:
 * a blocker_report to any other seat, or any other verb to 'duty-officer', is
 * a forbidden EFFECT (not fixable content).
 *
 * 't3-desktop' (WO-HARNESS-DISPATCH-ROUTING-CUTOFF-01) is admitted ONLY for
 * the escalate_p0 verb, and escalate_p0 may ONLY address 't3-desktop' (the
 * desktop results queue replaced the dead operator mailbox for escalations).
 */
export type TmAllowedRecipient = keyof typeof RECIPIENT_ROUTES;
export const TM_ALLOWED_RECIPIENTS = Object.keys(RECIPIENT_ROUTES) as TmAllowedRecipient[];

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

/**
 * Structural content contract for blocker reports
 * (WO-HARNESS-TASKMASTER-BLOCKER-REPORT-TO-DO-01). A content-complete body
 * (composeBlockerReportBody) always carries:
 *   - a quoted item title,
 *   - an explicit owner slot ("owner: <login-or-UNASSIGNED>"),
 *   - a "Blocked: ..." clause,
 *   - a GitHub issue URL (https://github.com/...),
 *   - a "for <duration>" clause ("for 3h" / "for 5 days").
 * A body missing any part is an ORDINARY content_incomplete rejection (not a
 * forbidden effect), exactly like an incomplete nudge.
 */
const BLOCKER_REPORT_TITLE_RE = /"[^"]+"/;
const BLOCKER_REPORT_OWNER_RE = /\bowner:\s*\S+/i;
const BLOCKER_REPORT_BLOCKED_RE = /\bBlocked:\s*\S/i;
// Match the same owner/repo/positive-number shape as the GitHub thread-ref parser.
const BLOCKER_REPORT_ISSUE_PATH_RE =
  /^\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/;
const BLOCKER_REPORT_DURATION_RE = /\bfor\s+\d+\s*(?:h|days?)\b/i;

function hasGitHubIssueUrl(body: string): boolean {
  // The composer emits a complete whitespace-delimited URL. Do not count GitHub
  // text embedded in another URL's host, path, query or fragment as that URL.
  return body.split(/\s+/).some(token => {
    try {
      const url = new URL(token);
      return (
        url.protocol === 'https:' &&
        url.hostname === 'github.com' &&
        url.username === '' &&
        url.password === '' &&
        url.port === '' &&
        BLOCKER_REPORT_ISSUE_PATH_RE.test(url.pathname)
      );
    } catch {
      return false;
    }
  });
}

export function isContentCompleteBlockerReportBody(body: string): boolean {
  return (
    BLOCKER_REPORT_TITLE_RE.test(body) &&
    BLOCKER_REPORT_OWNER_RE.test(body) &&
    BLOCKER_REPORT_BLOCKED_RE.test(body) &&
    hasGitHubIssueUrl(body) &&
    BLOCKER_REPORT_DURATION_RE.test(body)
  );
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

  // blocker_report <-> duty-officer is an exclusive pairing (M-blocker-report):
  // blocker_report may ONLY address 'duty-officer', and 'duty-officer' may ONLY
  // receive a blocker_report. Any other pairing is a forbidden EFFECT (the DO
  // clock is the sole consumer of that mailbox for this verb), so it trips the
  // auto HARD_PAUSE circuit rather than being a fixable content skip.
  const isBlockerReport = proposal.type.trim().toLowerCase() === 'blocker_report';
  const toDutyOfficer = proposal.recipient.trim().toLowerCase() === 'duty-officer';
  if (isBlockerReport && !toDutyOfficer) {
    return {
      allowed: false,
      forbiddenEffect: true,
      reason: `blocker_report_recipient_invalid: blocker_report must address 'duty-officer', not '${proposal.recipient}'.`,
    };
  }
  if (toDutyOfficer && !isBlockerReport) {
    return {
      allowed: false,
      forbiddenEffect: true,
      reason: `duty_officer_recipient_restricted: only blocker_report may address 'duty-officer', not '${proposal.type}'.`,
    };
  }

  // escalate_p0 <-> t3-desktop is an exclusive pairing, same shape as the
  // blocker_report/duty-officer pairing above: any other pairing is a forbidden
  // EFFECT.
  const isEscalateP0 = proposal.type.trim().toLowerCase() === 'escalate_p0';
  const toT3Desktop = proposal.recipient.trim().toLowerCase() === 't3-desktop';
  if (isEscalateP0 && !toT3Desktop) {
    return {
      allowed: false,
      forbiddenEffect: true,
      reason: `escalate_p0_recipient_invalid: escalate_p0 must address 't3-desktop', not '${proposal.recipient}'.`,
    };
  }
  if (toT3Desktop && !isEscalateP0) {
    return {
      allowed: false,
      forbiddenEffect: true,
      reason: `t3_desktop_recipient_restricted: only escalate_p0 may address 't3-desktop', not '${proposal.type}'.`,
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

  // Exclude only complete WO identifiers, quoted or not. Word boundaries and
  // hyphen checks prevent matching part of a longer token. Keep all other
  // content, including title suffixes, visible to the verb scan (#764 round 4).
  const contentGuard = validateForbiddenActionContent(normalized);
  if (!contentGuard.allowed) return contentGuard;

  if (proposal.recipient.trim().toLowerCase() === 't3-desk-local') {
    try {
      const body = JSON.parse(proposal.body) as Record<string, unknown>;
      if (
        proposal.type !== 'nudge' ||
        body.schema !== 't3-thread-nudge/v1' ||
        body.reason !== 'approval-stall' ||
        !['thread_id', 'request_id', 'text'].every(
          key => typeof body[key] === 'string' && body[key].trim()
        )
      ) {
        return { allowed: false, reason: 'relay_contract_invalid' };
      }
      // Scan decoded text too: JSON escapes must not hide forbidden verbs.
      const textMatch = SPEND_SEND_DEPLOY_RE.exec(
        (body.text as string).replace(/\s+/g, ' ').replace(new RegExp(WO_ID_RE.source, 'g'), '')
      );
      if (textMatch)
        return { allowed: false, reason: `spend_send_deploy_verb_rejected: '${textMatch[0]}'` };
      return { allowed: true };
    } catch {
      return { allowed: false, reason: 'relay_contract_invalid' };
    }
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

  // blocker_report bodies are content-gated the same way (ORDINARY reject, not
  // a HARD_PAUSE circuit): a body missing the quoted title, owner, Blocked
  // clause, GitHub URL or "for <duration>" clause is a journal-only skip.
  if (isBlockerReport && !isContentCompleteBlockerReportBody(normalized)) {
    return {
      allowed: false,
      reason:
        'content_incomplete: the blocker_report body lacks the required item content ' +
        '(quoted title, owner, Blocked clause, GitHub URL, and a "for <duration>" clause); ' +
        'the item stays on the register.',
    };
  }

  return { allowed: true };
}

/** Shared authority restriction for every outbound Taskmaster transport leg. */
export function validateForbiddenActionContent(body: string): GuardResult {
  const normalized = body.replace(/\s+/g, ' ').trim();
  const scanTarget = normalized.replace(new RegExp(WO_ID_RE.source, 'g'), '');
  const match = SPEND_SEND_DEPLOY_RE.exec(scanTarget);
  if (match) {
    return {
      allowed: false,
      reason: `spend_send_deploy_verb_rejected: body contains forbidden verb '${match[0]}'. The Taskmaster has zero spend/send/deploy authority (M-15 tier wall).`,
    };
  }

  return { allowed: true };
}
