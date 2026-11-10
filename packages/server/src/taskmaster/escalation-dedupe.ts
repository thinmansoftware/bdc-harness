/**
 * Containment for the escalate_p0 flood (WO-HARNESS-TASKMASTER-ESCALATE-P0-FLOOD-01).
 *
 * Pure decision only: the caller looks up the latest sent journal row and
 * journals a suppressed repeat. This module does not touch the database.
 * The cooldown is per (thread, reason). A failed or pending row does not
 * start a cooldown; the caller passes null when no sent row matches.
 */
import { canonicalizeThreadRef } from './thread-ref';

/** Default escalate_p0 cooldown. A repeat inside this window is suppressed. */
export const DEFAULT_ESCALATE_P0_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Production cooldown override. The loop, the page claim, and the journal
 * lookback all read this same value. Unset, blank, or non-positive input
 * keeps the default so a bad config cannot open the flood.
 */
export const ESCALATE_P0_COOLDOWN_ENV = 'TASKMASTER_ESCALATE_P0_COOLDOWN_MS';

/**
 * A pending row younger than this still belongs to a live delivery. Another
 * idempotency key must not page over it and must not rewrite it.
 */
export const ESCALATE_CLAIM_IN_FLIGHT_MS = 2 * 60 * 1000;

export function resolveEscalateP0CooldownMs(
  raw: string | undefined = process.env[ESCALATE_P0_COOLDOWN_ENV]
): number {
  if (raw === undefined) return DEFAULT_ESCALATE_P0_COOLDOWN_MS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_ESCALATE_P0_COOLDOWN_MS;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_ESCALATE_P0_COOLDOWN_MS;
  return parsed;
}

/** ISO lower bound for the journal scan. Pass the same cooldown the decision uses. */
export function escalateP0CutoffIso(
  nowMs: number,
  cooldownMs: number = resolveEscalateP0CooldownMs()
): string {
  return new Date(nowMs - cooldownMs).toISOString();
}

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
  const cooldownMs = input.cooldownMs ?? resolveEscalateP0CooldownMs();
  if (input.priorSentAtMs === null) return { send: true, suppressed: null };
  const ageMs = input.nowMs - input.priorSentAtMs;
  if (ageMs >= cooldownMs) return { send: true, suppressed: null };
  return { send: false, suppressed: 'cooldown' };
}

export interface EscalateJournalRow {
  thread_ref: string;
  action_type: string;
  proposal_json: string;
  idempotency_key: string | null;
  outcome: string;
  created_at: string;
}

export type EscalateDeliveryPlan = 'send' | 'suppress' | 'wait' | 'skip';

function sameThread(left: string, right: string): boolean {
  return canonicalizeThreadRef(left) === canonicalizeThreadRef(right);
}

function rowReason(row: EscalateJournalRow, threadRef: string): string | null {
  if (!sameThread(row.thread_ref, threadRef)) return null;
  if (row.action_type !== 'escalate_p0') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.proposal_json);
  } catch {
    return null;
  }
  return escalationReason(parsed, row.thread_ref);
}

/**
 * Decide one delivery attempt from the journal rows already read.
 * `wait` means this key's pending row, or another key for this thread and
 * reason, is still in flight. Do not page, and do not rewrite that pending
 * row. The caller journals a different key that waits so the attempt is not
 * dropped if the in-flight send succeeds. `skip` means this key is already
 * terminal. `suppress` means a sent row is still inside the cooldown. Failed
 * and expired rows do not open or extend that window. The caller journals the
 * suppression without touching a pending, sent, or failed row.
 */
export function planEscalateDelivery(input: {
  rows: readonly EscalateJournalRow[];
  threadRef: string;
  reason: string;
  idempotencyKey: string;
  nowMs: number;
  cooldownMs?: number;
  inFlightMs?: number;
}): EscalateDeliveryPlan {
  const inFlightMs = input.inFlightMs ?? ESCALATE_CLAIM_IN_FLIGHT_MS;
  const own = input.rows.find(row => row.idempotency_key === input.idempotencyKey);
  if (
    own &&
    (own.outcome === 'sent' ||
      own.outcome === 'expired' ||
      own.outcome === 'rejected' ||
      own.outcome === 'parked' ||
      own.outcome === 'deferred')
  ) {
    return 'skip';
  }

  // An in-flight row for this same key is already being delivered. It is not
  // permission for a second process to send.
  if (own?.outcome === 'pending') {
    const ownAtMs = Date.parse(own.created_at);
    if (Number.isFinite(ownAtMs) && input.nowMs - ownAtMs < inFlightMs) return 'wait';
  }

  for (const row of input.rows) {
    if (row.idempotency_key === input.idempotencyKey) continue;
    if (row.outcome !== 'pending') continue;
    if (rowReason(row, input.threadRef) !== input.reason) continue;
    const atMs = Date.parse(row.created_at);
    if (!Number.isFinite(atMs)) continue;
    if (input.nowMs - atMs < inFlightMs) return 'wait';
  }

  let priorSentAtMs: number | null = null;
  for (const row of input.rows) {
    if (row.outcome !== 'sent') continue;
    if (rowReason(row, input.threadRef) !== input.reason) continue;
    const atMs = Date.parse(row.created_at);
    if (!Number.isFinite(atMs)) continue;
    if (priorSentAtMs === null || atMs > priorSentAtMs) priorSentAtMs = atMs;
  }

  const decision = decideEscalateP0({
    threadRef: input.threadRef,
    reason: input.reason,
    nowMs: input.nowMs,
    priorSentAtMs,
    cooldownMs: input.cooldownMs ?? resolveEscalateP0CooldownMs(),
  });
  return decision.send ? 'send' : 'suppress';
}
