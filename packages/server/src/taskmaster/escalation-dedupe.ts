/**
 * Containment for the escalate_p0 flood (WO-HARNESS-TASKMASTER-ESCALATE-P0-FLOOD-01).
 *
 * Pure decision only: the caller looks up the latest sent journal row and
 * journals a suppressed repeat. This module does not touch the database.
 * The cooldown is per (thread, reason). A failed or pending row does not
 * start a cooldown; the caller passes null when no sent row matches.
 */

/** Default escalate_p0 cooldown. A repeat inside this window is suppressed. */
export const DEFAULT_ESCALATE_P0_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const PROBE_TOKEN = 'P0-INJECTED-PROBE';

function isProposalRecord(proposal: unknown): proposal is Record<string, unknown> {
  return typeof proposal === 'object' && proposal !== null && !Array.isArray(proposal);
}

/** Serialize for the probe-token scan. Non-serializable values yield null. */
function serializedProposal(proposal: unknown): string | null {
  if (typeof proposal === 'string') return proposal;
  try {
    const text: unknown = JSON.stringify(proposal);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * Reason key for cooldown grouping.
 * Precedence: probe token, worker_death identity, other kind, remediation
 * thread, then unclaimed_p0.
 */
export function escalationReason(proposal: unknown, threadRef: string): string {
  const serialized = serializedProposal(proposal);
  if (serialized?.includes(PROBE_TOKEN)) return PROBE_TOKEN;

  if (isProposalRecord(proposal)) {
    const kind = proposal.kind;
    const previousPid = proposal.previous_pid;
    const previousStartedAt = proposal.previous_started_at;
    if (
      kind === 'worker_death' &&
      typeof previousPid === 'number' &&
      Number.isFinite(previousPid) &&
      typeof previousStartedAt === 'string'
    ) {
      return `worker_death:${String(previousPid)}:${previousStartedAt}`;
    }
    if (typeof kind === 'string' && kind.length > 0) return kind;
  }

  if (threadRef.startsWith('remediation:')) return 'unroutable_remediation';
  return 'unclaimed_p0';
}

export function decideEscalateP0(input: {
  threadRef: string;
  reason: string;
  nowMs: number;
  priorSentAtMs: number | null;
  cooldownMs?: number;
}): { send: boolean; suppressed: 'cooldown' | null } {
  const cooldownMs = input.cooldownMs ?? DEFAULT_ESCALATE_P0_COOLDOWN_MS;
  if (input.priorSentAtMs === null) return { send: true, suppressed: null };
  const ageMs = input.nowMs - input.priorSentAtMs;
  if (ageMs >= cooldownMs) return { send: true, suppressed: null };
  return { send: false, suppressed: 'cooldown' };
}
