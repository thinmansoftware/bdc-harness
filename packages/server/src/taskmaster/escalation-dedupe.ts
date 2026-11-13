/**
 * escalate_p0 dedupe per (thread, reason) with settable cooldown windows
 * (WO-HARNESS-TASKMASTER-ESCALATE-P0-FLOOD-01, Amendments 1-6).
 *
 * The cooldown rules, in one place:
 *   - The SENT window (default 24 h, settable 24 to 168 h) starts ONLY from the
 *     last escalate_p0 journal row for the same thread and reason whose outcome
 *     is 'sent'. No other row starts or renews it (parked, pending, expired,
 *     rejected, deferred, and the recent_escalation skip rows never do).
 *   - The FAILED-delivery retry backoff (default 6 h, settable 1 to 168 h)
 *     applies when the last attempt (the newest 'sent' or 'failed' row) is a
 *     'failed' row.
 *   - The GitHub marker cooldown of escalation-delivery.ts (default 72 h,
 *     settable 1 to 168 h) is read here too, so all three windows share one
 *     reader and one fallback rule.
 *   - A row with no valid reason gets one from its thread_ref (Amendment 6, F3):
 *     a `remediation:` prefix is unroutable_remediation; a `dispatch-worker:`
 *     prefix is the heartbeat alarm's page (worker-heartbeat-alarm.ts) and is
 *     EXCLUDED from every window (F2); any other ref is unclaimed_p0.
 *
 * The production idempotency key `tm:escalate_p0:<ref>:<24h bucket>` is not
 * changed (Amendment 5, C2). The 24 h floor of the sent window is what keeps
 * the window and the bucket key consistent.
 */

export type EscalationReason = 'unclaimed_p0' | 'unroutable_remediation';

export const ESCALATION_REASONS: readonly EscalationReason[] = [
  'unclaimed_p0',
  'unroutable_remediation',
];

export const SENT_WINDOW_ENV = 'TASKMASTER_ESCALATE_P0_SENT_WINDOW_HOURS';
export const FAILED_BACKOFF_ENV = 'TASKMASTER_ESCALATE_P0_FAILED_BACKOFF_HOURS';
export const MARKER_WINDOW_ENV = 'TASKMASTER_ESCALATION_MARKER_WINDOW_HOURS';
export const MAX_EFFECTS_ENV = 'TASKMASTER_MAX_EFFECTS_PER_TICK';

export const DEFAULT_SENT_WINDOW_HOURS = 24;
export const DEFAULT_FAILED_BACKOFF_HOURS = 6;
export const DEFAULT_MARKER_WINDOW_HOURS = 72;
export const DEFAULT_MAX_EFFECTS_PER_TICK = 10;

const HOUR_MS = 60 * 60 * 1000;
const HEARTBEAT_REF_PREFIX = 'dispatch-worker:';
const REMEDIATION_REF_PREFIX = 'remediation:';

/** Called once per invalid setting read: (variable, raw value, fallback used). */
export type CooldownConfigWarn = (variable: string, raw: string, fallback: number) => void;

function readIntegerSetting(
  variable: string,
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
  warn: CooldownConfigWarn
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const text = raw.trim();
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
  }
  warn(variable, raw, fallback);
  return fallback;
}

export interface EscalationCooldownSettings {
  sentWindowMs: number;
  failedBackoffMs: number;
  markerWindowMs: number;
}

/**
 * Read the three cooldown windows. Unset gives the default with no warning; a
 * value that is not an integer number of hours, or is outside its range, gives
 * the default and one call to `warn`.
 */
export function resolveEscalationCooldowns(
  env: Record<string, string | undefined>,
  warn: CooldownConfigWarn
): EscalationCooldownSettings {
  const sent = readIntegerSetting(
    SENT_WINDOW_ENV,
    env[SENT_WINDOW_ENV],
    24,
    168,
    DEFAULT_SENT_WINDOW_HOURS,
    warn
  );
  const backoff = readIntegerSetting(
    FAILED_BACKOFF_ENV,
    env[FAILED_BACKOFF_ENV],
    1,
    168,
    DEFAULT_FAILED_BACKOFF_HOURS,
    warn
  );
  const marker = readIntegerSetting(
    MARKER_WINDOW_ENV,
    env[MARKER_WINDOW_ENV],
    1,
    168,
    DEFAULT_MARKER_WINDOW_HOURS,
    warn
  );
  return {
    sentWindowMs: sent * HOUR_MS,
    failedBackoffMs: backoff * HOUR_MS,
    markerWindowMs: marker * HOUR_MS,
  };
}

/**
 * The per-tick effect cap (Amendment 1 D): integers 1 to 10, default 10. It can
 * only lower the cap; it can never raise it above 10 or turn it off.
 */
export function resolveMaxEffectsPerTick(
  raw: string | undefined,
  warn: CooldownConfigWarn
): number {
  return readIntegerSetting(
    MAX_EFFECTS_ENV,
    raw,
    1,
    DEFAULT_MAX_EFFECTS_PER_TICK,
    DEFAULT_MAX_EFFECTS_PER_TICK,
    warn
  );
}

function isEscalationReason(value: unknown): value is EscalationReason {
  return value === 'unclaimed_p0' || value === 'unroutable_remediation';
}

/** Reason derived from a thread ref alone; null for a heartbeat page. */
export function reasonForThreadRef(threadRef: string): EscalationReason | null {
  if (threadRef.startsWith(HEARTBEAT_REF_PREFIX)) return null;
  if (threadRef.startsWith(REMEDIATION_REF_PREFIX)) return 'unroutable_remediation';
  return 'unclaimed_p0';
}

/**
 * The reason of a journal row: the row's own valid `reason`, else the one its
 * thread_ref gives (Amendment 6, F3). Null means the row is excluded from the
 * window (a `dispatch-worker:` heartbeat page, F2).
 */
export function reasonOfRow(row: {
  thread_ref: string;
  proposal_json: string;
}): EscalationReason | null {
  if (row.thread_ref.startsWith(HEARTBEAT_REF_PREFIX)) return null;
  try {
    const parsed = JSON.parse(row.proposal_json) as { reason?: unknown } | null;
    if (parsed && isEscalationReason(parsed.reason)) return parsed.reason;
  } catch {
    // A malformed proposal_json still has a thread_ref; fall through.
  }
  return reasonForThreadRef(row.thread_ref);
}

export interface EscalationJournalRow {
  thread_ref: string;
  action_type: string;
  proposal_json: string;
  outcome: string;
  created_at: string;
}

export type EscalationDecision =
  | { action: 'send' }
  | { action: 'skip'; basis: 'sent_window' | 'failed_backoff'; windowStartIso: string };

/**
 * Decide whether an escalate_p0 for (threadRef, reason) may be sent now.
 * `threadRef` must already be canonical; `canonicalize` is applied to each row.
 */
export function decideEscalation(input: {
  threadRef: string;
  reason: EscalationReason;
  nowMs: number;
  rows: readonly EscalationJournalRow[];
  settings: EscalationCooldownSettings;
  canonicalize?: (ref: string) => string;
}): EscalationDecision {
  const canonicalize = input.canonicalize ?? ((ref: string): string => ref);
  let lastSentMs = Number.NEGATIVE_INFINITY;
  let lastSentIso = '';
  let lastAttemptMs = Number.NEGATIVE_INFINITY;
  let lastAttemptIso = '';
  let lastAttemptFailed = false;
  for (const row of input.rows) {
    if (row.action_type !== 'escalate_p0') continue;
    if (row.outcome !== 'sent' && row.outcome !== 'failed') continue;
    if (canonicalize(row.thread_ref) !== input.threadRef) continue;
    if (reasonOfRow(row) !== input.reason) continue;
    const atMs = Date.parse(row.created_at);
    if (!Number.isFinite(atMs)) continue;
    if (row.outcome === 'sent' && atMs > lastSentMs) {
      lastSentMs = atMs;
      lastSentIso = row.created_at;
    }
    if (atMs > lastAttemptMs) {
      lastAttemptMs = atMs;
      lastAttemptIso = row.created_at;
      lastAttemptFailed = row.outcome === 'failed';
    }
  }
  if (lastSentIso && input.nowMs - lastSentMs < input.settings.sentWindowMs) {
    return { action: 'skip', basis: 'sent_window', windowStartIso: lastSentIso };
  }
  if (
    lastAttemptIso &&
    lastAttemptFailed &&
    input.nowMs - lastAttemptMs < input.settings.failedBackoffMs
  ) {
    return { action: 'skip', basis: 'failed_backoff', windowStartIso: lastAttemptIso };
  }
  return { action: 'send' };
}

/**
 * Key of the ONE skip row per (thread, reason, window). The row it names is
 * journaled once, on the first skip after the window's starting row; later
 * ticks inside the same window find it and write nothing (Amendment 2, B2).
 * The `_skip` suffix keeps it out of the `tm:escalate_p0:` send-key prefix.
 */
export function escalationSkipKey(
  threadRef: string,
  reason: EscalationReason,
  windowStartIso: string
): string {
  return `tm:escalate_p0_skip:${threadRef}:${reason}:${windowStartIso}`;
}
