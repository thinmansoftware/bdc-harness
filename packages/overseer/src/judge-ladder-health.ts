/**
 * Judge ladder health: quota / credit / auth outage classification and the
 * ladder-exhausted circuit breaker (bdc-harness #847 items 1 and 2).
 *
 * THE INCIDENT (2026-09-14, every review from ~20:45Z): the reviewer posted
 * CHANGES_REQUESTED with "Reason code: model_exit_nonzero" on every push. The
 * first rung (`codex`) had hit its usage limit until Sep 20th; the second
 * (`grok`) had no xAI credits (402). Nothing in the receipt, the PR review, or
 * the event store said so -- diagnosing it took a manual probe inside the
 * container -- and every push and re-request still spawned both dead rungs and
 * rejected the PR for a reason that had nothing to do with the code.
 *
 * Two things live here:
 *  1. `classifyJudgeOutage` -- maps a rung's stderr/stdout tail (or a thrown
 *     message) to a stable reason code the evaluator carries in `lastError`.
 *  2. THE BREAKER -- a per-rung record of the last such outage. When EVERY
 *     configured rung is out, ingest parks the head instead of enqueueing.
 *
 * STORAGE (stated per the brief): process memory. `outages` is a Map keyed by
 * rung binary; `parked` is a Map of not-enqueued heads keyed by review
 * correlation id; `lastNoticeHour` is the hour of the last operator notice.
 * None of it is durable. ON RESTART all three are empty: the next review
 * spawns the ladder once more, each dead rung is re-recorded, the breaker
 * re-trips, and the operator notice is re-sent -- but its Dispatch idempotency
 * key is derived from the HOUR, so a restart inside the same hour is deduped
 * by the store. Heads parked before the restart are NOT re-enqueued
 * automatically; their durable trail is the `blocked` /
 * `judge_ladder_exhausted_until:<iso>` ingest receipt and the hourly notice,
 * and an `operator_request:ladder_restored` run_review row is the hand path.
 *
 * PURE: no IO. The operator message and the re-enqueue are injected.
 */
import type { IngestDeps } from './pr-review-ingest';

export type JudgeOutageKind =
  | 'usage_limit_until'
  | 'usage_limit'
  | 'provider_credits_exhausted'
  | 'auth_expired';

export interface JudgeOutage {
  kind: JudgeOutageKind;
  /** The `lastError` string: `usage_limit_until:<iso>` or the bare kind. */
  code: string;
  /** ISO-8601 UTC instant the provider said to come back, when it said one. */
  retryAfter?: string;
}

export interface JudgeRungOutageRecord extends JudgeOutage {
  binary: string;
  observedAt: string;
}

export interface LadderExhaustion {
  rungs: JudgeRungOutageRecord[];
  /** ISO-8601 instant the earliest rung is expected back, or 'unknown'. */
  until: string;
}

export interface ParkedReviewHead {
  correlationId: string;
  idempotencyKey: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
  author: string;
  parkedAt: string;
}

/** Ingest's view of the breaker. Bound to the live store in pr-review-wiring. */
export interface JudgeLadderBreaker {
  /** The exhaustion when EVERY configured rung is out; null otherwise. */
  check(): LadderExhaustion | null;
  /** Remember a head that was not enqueued so recovery can re-enqueue it. */
  park(head: Omit<ParkedReviewHead, 'parkedAt'>): void;
  /** Send the operator notice at most once per hour. Resolves true when sent. */
  notify(exhaustion: LadderExhaustion): Promise<boolean>;
}

/** A credit/auth outage with no stated retry time is believed for this long. */
export const JUDGE_OUTAGE_TTL_MS = 60 * 60 * 1000;

/** repeat_reason prefix an operator uses to clear the breaker and run now. */
export const LADDER_RESTORED_REASON_PREFIX = 'operator_request:ladder_restored';

/** repeat_reason stamped on a parked head re-enqueued by recovery. */
export const LADDER_RECOVERED_REASON_PREFIX = 'judge_ladder_recovered:';

const MONTHS = new Map<string, number>([
  ['jan', 0],
  ['feb', 1],
  ['mar', 2],
  ['apr', 3],
  ['may', 4],
  ['jun', 5],
  ['jul', 6],
  ['aug', 7],
  ['sep', 8],
  ['oct', 9],
  ['nov', 10],
  ['dec', 11],
]);

/**
 * The Codex CLI's wording, verified in the container 2026-09-14:
 * `... or try again at Sep 20th, 2026 1:13 PM.` The time is printed in the
 * container's local zone (UTC on archon-app-1) and is parsed as UTC.
 */
const CODEX_RETRY_AT =
  /try again at\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?)?/;

const USAGE_LIMIT = /hit your usage limit|usage limit (?:reached|exceeded)/i;
const CREDITS_EXHAUSTED =
  /insufficient[\s_-]*credits?|\b402\b|payment required|credits? (?:exhausted|depleted)/i;
const AUTH_EXPIRED =
  /\b401\b|unauthori[sz]ed|authentication required|invalid api key|api key (?:is )?(?:invalid|expired|missing)/i;

/** Exported for the unit test; parses the Codex retry date to ISO-8601 UTC. */
export function parseCodexRetryAt(text: string): string | null {
  const match = CODEX_RETRY_AT.exec(text);
  if (!match) return null;
  const month = MONTHS.get((match[1] ?? '').toLowerCase());
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  let hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const meridiem = match[6]?.toUpperCase();
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const instant = Date.UTC(year, month, day, hour, minute);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

/**
 * Map a rung's failure text to a reason code, or null when unrecognized.
 *
 * Only ever called for a rung that FAILED (non-zero exit or throw), so verdict
 * JSON can never be classified. Order matters: the Codex usage-limit text is
 * checked first because it also mentions "credits".
 */
export function classifyJudgeOutage(text: string): JudgeOutage | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  if (USAGE_LIMIT.test(text)) {
    const retryAfter = parseCodexRetryAt(text);
    return retryAfter
      ? { kind: 'usage_limit_until', code: `usage_limit_until:${retryAfter}`, retryAfter }
      : { kind: 'usage_limit', code: 'usage_limit' };
  }
  if (CREDITS_EXHAUSTED.test(text)) {
    return { kind: 'provider_credits_exhausted', code: 'provider_credits_exhausted' };
  }
  if (AUTH_EXPIRED.test(text)) {
    return { kind: 'auth_expired', code: 'auth_expired' };
  }
  return null;
}

const outages = new Map<string, JudgeRungOutageRecord>();
const parked = new Map<string, ParkedReviewHead>();
let lastNoticeHour: string | null = null;

/**
 * Record (or clear, with `null`) the last outage seen on one rung. The
 * evaluator calls this with a classified outage when a rung is refused and
 * with `null` when a rung exits 0 -- proof it has quota, credits, and
 * credentials again.
 */
export function recordJudgeRungOutage(
  binary: string,
  outage: JudgeOutage | null,
  now: Date = new Date()
): void {
  const key = binary.trim();
  if (key.length === 0) return;
  if (outage === null) {
    outages.delete(key);
    return;
  }
  outages.set(key, { ...outage, binary: key, observedAt: now.toISOString() });
}

/** Epoch ms the record stops being believed: stated retry time, else TTL. */
export function judgeOutageExpiresAt(record: JudgeRungOutageRecord): number {
  const stated = record.retryAfter ? Date.parse(record.retryAfter) : Number.NaN;
  if (Number.isFinite(stated)) return stated;
  return Date.parse(record.observedAt) + JUDGE_OUTAGE_TTL_MS;
}

/**
 * Null unless EVERY configured rung has a record still in force. One healthy
 * (or unknown) rung keeps the ladder open -- the breaker never blocks on a
 * partial outage, because a partial outage still produces real verdicts.
 */
export function evaluateJudgeLadder(
  ladder: readonly string[],
  now: Date = new Date()
): LadderExhaustion | null {
  const rungs = ladder.map(binary => binary.trim()).filter(binary => binary.length > 0);
  if (rungs.length === 0) return null;
  const records: JudgeRungOutageRecord[] = [];
  for (const binary of rungs) {
    const record = outages.get(binary);
    if (!record) return null;
    const expires = judgeOutageExpiresAt(record);
    if (!Number.isFinite(expires) || expires <= now.getTime()) return null;
    records.push(record);
  }
  const expiries = records.map(judgeOutageExpiresAt).filter(ms => Number.isFinite(ms));
  const until = expiries.length > 0 ? new Date(Math.min(...expiries)).toISOString() : 'unknown';
  return { rungs: records, until };
}

/** Forget every rung outage and the notice hour. Parked heads are kept. */
export function clearJudgeOutages(): void {
  outages.clear();
  lastNoticeHour = null;
}

export function isLadderRestoredRequest(repeatReason: string | null | undefined): boolean {
  return (
    typeof repeatReason === 'string' &&
    repeatReason.trim().startsWith(LADDER_RESTORED_REASON_PREFIX)
  );
}

/**
 * The operator override. A run_review row whose repeat_reason starts with
 * `operator_request:ladder_restored` clears the records so the judge runs
 * (that row bypasses ingest anyway) AND the next recovery pass re-enqueues
 * every parked head. Returns whether anything was cleared.
 */
export function applyLadderRestoredRequest(repeatReason: string | null | undefined): boolean {
  if (!isLadderRestoredRequest(repeatReason)) return false;
  clearJudgeOutages();
  return true;
}

/** Test seam and restart semantics in one place: everything empty. */
export function resetJudgeLadderHealth(): void {
  outages.clear();
  parked.clear();
  lastNoticeHour = null;
}

export function snapshotJudgeLadderHealth(): {
  outages: JudgeRungOutageRecord[];
  parked: ParkedReviewHead[];
} {
  return { outages: [...outages.values()], parked: [...parked.values()] };
}

/** `2026-09-14T21` -- the hour bucket the operator notice is deduped on. */
export function noticeHourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

/** Dispatch idempotency key for the hourly operator notice. */
export function ladderExhaustedNoticeKey(now: Date): string {
  return `judge-ladder-exhausted:${noticeHourKey(now)}`;
}

function isoOrUnknown(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown';
}

export function buildLadderExhaustedNotice(
  exhaustion: LadderExhaustion,
  parkedHeads: readonly ParkedReviewHead[]
): string {
  const rungs = exhaustion.rungs.map(
    rung =>
      `- ${rung.binary}: ${rung.code} (observed ${rung.observedAt}, believed out until ${isoOrUnknown(judgeOutageExpiresAt(rung))})`
  );
  const heads =
    parkedHeads.length === 0
      ? 'none yet'
      : parkedHeads
          .map(head => `${head.owner}/${head.repo}#${head.prNumber}@${head.headSha.slice(0, 7)}`)
          .join(', ');
  return [
    `Overseer judge ladder exhausted: every configured rung is out of quota, credits, or credentials. Independent PR reviews are PARKED (no run_review queued, nothing posted on the PR) until ${exhaustion.until}.`,
    ...rungs,
    `Parked heads (${parkedHeads.length}): ${heads}.`,
    `Parked heads re-enter the queue automatically once the earliest retry time passes. To run now, enqueue a run_review for the PR with a repeat_reason starting '${LADDER_RESTORED_REASON_PREFIX}'; that clears these records.`,
  ].join('\n');
}

export interface JudgeLadderBreakerOptions {
  ladder: readonly string[];
  /** Real binding: a Dispatch agent_message to `operator`, keyed by the hour. */
  sendOperatorMessage(input: { idempotencyKey: string; body: string }): Promise<void>;
  now?: () => Date;
}

export function createJudgeLadderBreaker(options: JudgeLadderBreakerOptions): JudgeLadderBreaker {
  const now = options.now ?? ((): Date => new Date());
  return {
    check(): LadderExhaustion | null {
      return evaluateJudgeLadder(options.ladder, now());
    },
    park(head): void {
      if (parked.has(head.correlationId)) return;
      parked.set(head.correlationId, { ...head, parkedAt: now().toISOString() });
    },
    async notify(exhaustion): Promise<boolean> {
      const at = now();
      const hour = noticeHourKey(at);
      if (lastNoticeHour === hour) return false;
      await options.sendOperatorMessage({
        idempotencyKey: ladderExhaustedNoticeKey(at),
        body: buildLadderExhaustedNotice(exhaustion, [...parked.values()]),
      });
      // Only after a successful send, so a failed send is retried next ingest.
      lastNoticeHour = hour;
      return true;
    },
  };
}

/**
 * Re-enqueue parked heads once the ladder is open again. Called from the
 * review worker tick after the queue drain (alongside the stale-verdict
 * sweep). Never throws into the tick; a head whose enqueue fails stays parked
 * for the next pass.
 */
export async function recoverParkedJudgeHeads(
  deps: Pick<IngestDeps, 'enqueueReviewWork' | 'recordReceipt'>,
  ladder: readonly string[],
  now: Date = new Date()
): Promise<{ recovered: string[]; stillParked: number }> {
  if (parked.size === 0) return { recovered: [], stillParked: 0 };
  if (evaluateJudgeLadder(ladder, now) !== null) {
    return { recovered: [], stillParked: parked.size };
  }
  const recovered: string[] = [];
  for (const head of [...parked.values()]) {
    let messageId: string;
    try {
      const enqueued = await deps.enqueueReviewWork({
        correlationId: head.correlationId,
        idempotencyKey: head.idempotencyKey,
        owner: head.owner,
        repo: head.repo,
        prNumber: head.prNumber,
        headSha: head.headSha,
        baseRef: head.baseRef,
        author: head.author,
        // Non-automatic reason: satisfies Dispatch's repeat_reason rule on a
        // PR with terminal prior rows without spending the re-review budget.
        repeatReason: `${LADDER_RECOVERED_REASON_PREFIX}${head.headSha}`,
        headCiGreen: false,
      });
      messageId = enqueued.messageId;
    } catch {
      continue;
    }
    parked.delete(head.correlationId);
    recovered.push(head.correlationId);
    try {
      await deps.recordReceipt({
        correlationId: head.correlationId,
        deliveryId: `judge-ladder-recovery:${head.correlationId}`,
        owner: head.owner,
        repo: head.repo,
        prNumber: head.prNumber,
        headSha: head.headSha,
        disposition: 'queued',
        reason: 'judge_ladder_recovered',
        messageId,
      });
    } catch {
      // The work is queued; a missing receipt must not re-park the head.
    }
  }
  return { recovered, stillParked: parked.size };
}
