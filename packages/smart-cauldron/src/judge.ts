/**
 * judge.ts -- 4-condition gate for Smart Cauldron v1.0.
 *
 * Implements the "good enough?" gate from the Cauldron-Fire skill's 4-condition
 * fallback triage. The cascade REUSES this logic -- it does NOT invent a new judge.
 *
 * Gate conditions:
 *   1. Terminal status: "completed" passes; "failed" or "cancelled" fails.
 *   2. Validator verdict: "satisfied" passes; "needs_revision" fails; "unknown" abstains.
 *   3. PR opened: if completed but no PR URL and no matching pushed-head SHA, fails.
 *   4. PR mergeable: if prMergeable === false, fails.
 *
 * Integrity separation: infra-errors (auth/transport) are classified separately
 * by classifyAttemptOutcome using @archon/overseer/classify -- they are NOT
 * counted as "too hard" (gate failures). They trigger alert escalation instead.
 */

import { classifyError } from '@archon/overseer/classify';
import type { GateVerdict, PollResult, FireResult, TierOutcome } from './types.js';

const SHA40 = /^[0-9a-f]{40}$/i;

/** The one gate reason that a conflict-only verdict consists of (condition 4 below). */
const NOT_MERGEABLE_REASON = 'PR is not mergeable';

/**
 * A completed run counts as having opened a PR when its pushed head SHA equals
 * the head of exactly one open WO PR. Both values must be 40 hex digits.
 * Equality does not override any other gate condition.
 */
function runPushedShaMatchesOpenPr(poll: PollResult): boolean {
  const pushed = poll.runPushedHeadSha;
  const open = poll.openWoPrHeadSha;
  if (typeof pushed !== 'string' || typeof open !== 'string') return false;
  if (!SHA40.test(pushed) || !SHA40.test(open)) return false;
  return pushed.toLowerCase() === open.toLowerCase();
}

/**
 * Judge whether a run passed the gate.
 *
 * @param poll PollResult from pollForTerminal.
 * @returns GateVerdict with pass/fail and the failing condition reason.
 */
export function judgeGate(poll: PollResult): GateVerdict {
  const { terminalStatus, validatorVerdict, prUrl, prMergeable } = poll;

  const prOpened = prUrl !== null || runPushedShaMatchesOpenPr(poll);

  // Cancelled is NOT a climb signal (Motion M-86). A human deliberately stopped
  // this run -- climbing to a more expensive tier is the opposite of intent.
  // Early-return before any other condition so the verdict can NEVER compute
  // pass:true for a cancelled run (a realistic cancelled PollResult -- prUrl:null,
  // prMergeable:null, validatorVerdict:'unknown' -- would otherwise fall through
  // conditions 2/3/4 with an empty failingReasons list and be judged a WIN).
  if (terminalStatus === 'cancelled') {
    return {
      pass: false,
      reason: 'run was cancelled externally (not a climb signal)',
      cancelled: true,
      validatorVerdict,
      prOpened,
      prMergeable: prMergeable ?? null,
      terminalStatus,
    };
  }

  const failingReasons: string[] = [];

  // Condition 1: terminal status.
  // 'escalated' is a re-label applied to a PRIOR rejected run after a successor
  // fired. If cascaded code ever polls a run already marked escalated, treat it
  // as a non-success (same ladder-climb signal as failed).
  if (terminalStatus === 'failed') {
    failingReasons.push('terminal status: failed');
  } else if (terminalStatus === 'escalated') {
    failingReasons.push('terminal status: escalated');
  }

  // Condition 2: validator verdict (only if it has an opinion)
  if (validatorVerdict === 'needs_revision') {
    failingReasons.push('validator verdict: needs_revision');
  }

  // Condition 3: PR opened (only relevant when terminal status was completed)
  if (terminalStatus === 'completed' && !prOpened) {
    failingReasons.push('no PR opened after completed run');
  }

  // Condition 4: PR mergeable
  if (prMergeable === false) {
    failingReasons.push(NOT_MERGEABLE_REASON);
  }

  const pass = failingReasons.length === 0;
  const reason = pass ? 'all gate conditions passed' : failingReasons.join('; ');
  const conflictOnly =
    !pass &&
    terminalStatus === 'completed' &&
    prOpened &&
    validatorVerdict !== 'needs_revision' &&
    failingReasons.length === 1 &&
    failingReasons[0] === NOT_MERGEABLE_REASON;

  return {
    pass,
    reason,
    cancelled: false,
    validatorVerdict,
    prOpened,
    prMergeable: prMergeable ?? null,
    terminalStatus,
    ...(conflictOnly ? { conflictOnly: true } : {}),
  };
}

/**
 * Classify the outcome of a cascade attempt.
 *
 * Distinguishes infra-errors (auth/transport) from gate failures.
 * Uses @archon/overseer/classify to detect auth_failed / service_unavailable.
 *
 * @param fireResult Result from fireTier.
 * @param gateVerdict Gate verdict (null if fire failed before polling).
 * @returns TierOutcome: "infra-error", "cancelled", "gate-failed", or "won".
 */
export function classifyAttemptOutcome(
  fireResult: FireResult,
  gateVerdict: GateVerdict | null,
  pollResult?: PollResult
): TierOutcome {
  // Check for infra-error first (fire failed to produce a run)
  if (!fireResult.ok && fireResult.infraError !== null) {
    const errorClass = classifyError({
      message: fireResult.infraError,
      statusCode: extractStatusCode(fireResult.infraError),
    });

    if (errorClass === 'auth_failed' || errorClass === 'service_unavailable') {
      return 'infra-error';
    }

    // Discovery timeout or other network error -- also infra
    if (
      fireResult.infraError.includes('network error') ||
      fireResult.infraError.includes('discovery timeout') ||
      fireResult.infraError.includes('ECONNREFUSED') ||
      fireResult.infraError.includes('ENOTFOUND')
    ) {
      return 'infra-error';
    }

    // Unknown fire error -- treat as infra-error (not "work too hard")
    return 'infra-error';
  }

  // Gate verdict determines outcome
  if (gateVerdict === null) {
    // This should not happen in normal flow (fire ok but no verdict)
    return 'gate-failed';
  }

  // Cancelled is checked before pass so it is never derived indirectly via
  // !pass (which would misclassify it as 'gate-failed' and lose the honesty
  // distinction Motion M-86 requires). Defense-in-depth: judgeGate already
  // guarantees pass:false for a cancelled verdict.
  if (gateVerdict.cancelled) {
    return 'cancelled';
  }

  // Only the evidence gate emits ENVIRONMENT_UNAVAILABLE: after checking a
  // declared capability. Never infer missing services from test output text.
  if (
    pollResult?.terminalStatus === 'failed' &&
    typeof pollResult.rawMetadata.error === 'string' &&
    pollResult.rawMetadata.error.includes('ENVIRONMENT_UNAVAILABLE:')
  ) {
    return 'environment-unavailable';
  }

  return gateVerdict.pass ? 'won' : 'gate-failed';
}

/**
 * Extract HTTP status code from an infraError string like "HTTP 401: ..."
 */
function extractStatusCode(infraError: string): number | undefined {
  const match = /HTTP\s+(\d{3})/.exec(infraError);
  if (match?.[1]) {
    const code = parseInt(match[1], 10);
    return isNaN(code) ? undefined : code;
  }
  return undefined;
}
