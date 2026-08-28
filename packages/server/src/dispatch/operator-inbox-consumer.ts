/**
 * Operator inbox consumer (WO-HARNESS-OPERATOR-INBOX-CONSUMER-01 / bdc-xo#1455).
 *
 * Drains agent_dispatch_messages where recipient='operator' AND status='queued'
 * (listMessages also requires addressed_at IS NULL). Classifies each message,
 * surfaces needs-human items to a durable JSONL log (NOT Telegram/SMS -- that
 * gate stays dark per #1456), and marks handled via the existing DAL
 * acknowledgeMessage + addressMessage primitives.
 *
 * Scheduler skeleton cloned from packages/server/src/taskmaster/loop.ts
 * startTaskmaster (singleton timer, inFlight guard, env interval, 0 = off)
 * and the api.ts NODE_ENV !== 'test' gate at the call site.
 */
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  acknowledgeMessage,
  addressMessage,
  getOperatorInboxBacklogStatus,
  listUnwatermarkedOperatorInboxMessages,
  markOperatorInboxWatermark,
  retireStaleOperatorInboxMessages,
  type DispatchMessage,
  type DispatchMailboxResult,
  type OperatorInboxBacklogStatus,
} from '@archon/core/db/dispatch';
import {
  advanceRateLimitBackoff,
  classifyGitHubRateLimit,
  createRateLimitBackoffState,
  DEFAULT_RATE_LIMIT_BASE_MS,
  resetRateLimitBackoff,
} from '@archon/overseer/adapters/github-rate-limit-classifier';
import { createLogger, getArchonHome } from '@archon/paths';

const log = createLogger('dispatch/operator-inbox-consumer');

export const OPERATOR_INBOX_PRINCIPAL = 'operator';
export const DEFAULT_OPERATOR_INBOX_INTERVAL_MS = 60_000;

// WO-HARNESS-OPERATOR-INBOX-BACKPRESSURE-01 env knobs (see xo-wiki
// modules/archon/operator-inbox-backpressure.md). All have safe defaults.
/** Max operator rows one drain pass reads + processes. 0 or invalid -> default. */
export const DEFAULT_OPERATOR_INBOX_BATCH_CAP = 50;
/** Age past which an unaddressed operator row is retired. Default 14 days. */
export const DEFAULT_OPERATOR_INBOX_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Backlog size at/above which the episode-deduped alarm fires. */
export const DEFAULT_OPERATOR_INBOX_ALARM_THRESHOLD = 200;
/** Max rows retired per sweep (bounds a single pass's write volume). */
export const OPERATOR_INBOX_RETIREMENT_SWEEP_CAP = 200;

/** Minimal message shape the consumer needs (full DispatchMessage also works). */
export interface OperatorInboxMessage {
  id: string;
  task_type: string;
  sender: string;
  recipient: string;
  body: string;
  status: string;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  addressed_at: string | null;
  addressed_by: string | null;
}

export type ClassificationKind = 'digest_only' | 'code_actionable' | 'needs_human';

export interface Classification {
  kind: ClassificationKind;
  reason: string;
  /** Best-effort WO id extracted from body, if any. */
  woId: string | null;
  /** Best-effort GitHub issue ref like owner/repo#N, if any. */
  issueRef: string | null;
}

export interface SurfaceEntry {
  messageId: string;
  classification: ClassificationKind;
  reason: string;
  sender: string;
  taskType: string;
  createdAt: string;
  originalBody: string;
  woId: string | null;
  issueRef: string | null;
  surfacedAt: string;
}

export interface OperatorInboxAlarm {
  count: number;
  oldestCreatedAt: string | null;
  oldestAgeMs: number | null;
  topSender: string | null;
  topSenderCount: number | null;
  threshold: number;
}

export interface DrainResult {
  found: number;
  processed: number;
  failed: number;
  digests: number;
  codeActionable: number;
  needsHuman: number;
  errors: string[];
  /** Rows retired by this pass's retention sweep. */
  retired: number;
  /** External (commentOnIssue) calls actually attempted this pass. */
  externalCalls: number;
  /** Backlog status observed after the pass (drives alarm + status read). */
  backlog: OperatorInboxBacklogStatus | null;
  /** True when this pass emitted the episode-deduped alarm. */
  alarmEmitted: boolean;
}

export interface OperatorInboxDeps {
  /**
   * Bounded, oldest-first read of un-watermarked operator rows. Replaces the
   * former full-backlog `listMessages(..., limit: 500)` read: a stale backlog is
   * never re-read in full every pass. Injectable for hermetic tests.
   */
  listUnwatermarked?: (limit: number) => Promise<OperatorInboxMessage[]>;
  /** Idempotent per-row watermark; breaks the reprocessing loop. */
  markWatermark?: (id: string) => Promise<boolean>;
  /** Retention sweep -> retired ids (terminal, non-draining, not deleted). */
  retireStale?: (retentionMs: number, limit: number) => Promise<string[]>;
  /** Backlog status read (count / oldest / top senders). */
  getBacklogStatus?: () => Promise<OperatorInboxBacklogStatus>;
  /** One deduped alarm per episode. Default: structured log only (no notifiers). */
  emitAlarm?: (alarm: OperatorInboxAlarm) => void;
  /**
   * Read the durable "an alarm episode is currently active" latch. Default:
   * a JSON file under ARCHON_HOME so a process RESTART while the backlog is
   * still above threshold does NOT re-emit the alarm for the same episode.
   * Injectable for hermetic tests.
   */
  loadAlarmEpisodeActive?: () => Promise<boolean>;
  /** Persist the alarm-episode latch durably. Default: the same JSON file. */
  saveAlarmEpisodeActive?: (active: boolean) => Promise<void>;
  /** Batch cap for the bounded read. Default DEFAULT_OPERATOR_INBOX_BATCH_CAP. */
  batchCap?: number;
  /** Retention window. Default DEFAULT_OPERATOR_INBOX_RETENTION_MS. */
  retentionMs?: number;
  /** Alarm threshold. Default DEFAULT_OPERATOR_INBOX_ALARM_THRESHOLD. */
  alarmThreshold?: number;
  acknowledgeMessage?: (data: {
    id: string;
    principal_id: string;
  }) => Promise<
    | DispatchMailboxResult
    | { ok: true; message: OperatorInboxMessage }
    | { ok: false; reason: string }
  >;
  addressMessage?: (data: {
    id: string;
    principal_id: string;
  }) => Promise<
    | DispatchMailboxResult
    | { ok: true; message: OperatorInboxMessage }
    | { ok: false; reason: string }
  >;
  surface?: (entry: SurfaceEntry) => Promise<void>;
  principalId?: string;
  now?: () => Date;
  /**
   * Optional code-actionable hook: comment/link on a findable GitHub issue.
   * Failures here must NOT prevent durable surface + address (conservative).
   */
  commentOnIssue?: (issueRef: string, body: string) => Promise<void>;
}

export interface OperatorInboxRuntime {
  intervalMs: number;
  lastDrainResult: DrainResult | null;
  ticks: number;
}

// ---------------------------------------------------------------------------
// Classification -- conservative: when in doubt, needs_human.
// ---------------------------------------------------------------------------

const KNOWN_ACTIONABLE_PATTERNS: { re: RegExp; reason: string }[] = [
  {
    re: /judge[_ ]?daily[_ ]?budget[_ ]?e(xceeded)?/i,
    reason: 'known_pattern:judge_daily_budget_exceeded',
  },
  {
    re: /judge health failure/i,
    reason: 'known_pattern:judge_health_failure',
  },
  {
    re: /pr[- ]?lookup|pull request.*(fail|error|creation)|quote-wrap/i,
    reason: 'known_pattern:pr_lookup_or_creation',
  },
  {
    re: /evidence_unavailable/i,
    reason: 'known_pattern:evidence_unavailable',
  },
];

const DIGEST_PATTERNS: RegExp[] = [/taskmaster daily digest/i, /no actions in the last 24h/i];

function extractWoId(text: string): string | null {
  const match = /\bWO-[A-Z0-9][A-Z0-9-]{2,}\b/i.exec(text);
  return match ? match[0].toUpperCase() : null;
}

function extractIssueRef(text: string): string | null {
  const full = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/.exec(text);
  if (full) return `${full[1]}#${full[2]}`;
  // Bare #N is not enough to comment safely without a default repo.
  return null;
}

function bodyText(message: OperatorInboxMessage): string {
  return message.body;
}

export function classifyOperatorMessage(message: OperatorInboxMessage): Classification {
  const text = bodyText(message);
  const woId = extractWoId(text);
  const issueRef = extractIssueRef(text);

  // Taskmaster digests and similar agent_message no-action traffic.
  if (message.task_type === 'agent_message') {
    const isDigest =
      DIGEST_PATTERNS.some(re => re.test(text)) ||
      (message.sender === 'taskmaster' && /digest/i.test(text));
    if (isDigest) {
      return {
        kind: 'digest_only',
        reason: 'taskmaster_or_daily_digest_no_action',
        woId,
        issueRef,
      };
    }
  }

  for (const pattern of KNOWN_ACTIONABLE_PATTERNS) {
    if (pattern.re.test(text)) {
      return {
        kind: 'code_actionable',
        reason: pattern.reason,
        woId,
        issueRef,
      };
    }
  }

  // A run_report with an explicit WO id is still needs_human unless the
  // blocker matches a known pattern -- we link the WO when surfacing but do
  // not auto-resolve unknown failures.
  return {
    kind: 'needs_human',
    reason: 'unrecognized_or_ambiguous_blocker',
    woId,
    issueRef,
  };
}

// ---------------------------------------------------------------------------
// Durable human surface (JSONL under ARCHON_HOME/operator-inbox/)
// ---------------------------------------------------------------------------

export function defaultOperatorInboxSurfacePath(): string {
  return join(getArchonHome(), 'operator-inbox', 'surface.jsonl');
}

export async function appendDurableSurfaceLog(entry: SurfaceEntry): Promise<void> {
  const path = defaultOperatorInboxSurfacePath();
  await mkdir(join(getArchonHome(), 'operator-inbox'), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  log.info(
    {
      messageId: entry.messageId,
      classification: entry.classification,
      woId: entry.woId,
      path,
    },
    'operator_inbox.surfaced'
  );
}

// ---------------------------------------------------------------------------
// Drain tick
// ---------------------------------------------------------------------------

function toInboxMessage(message: DispatchMessage | OperatorInboxMessage): OperatorInboxMessage {
  return {
    id: message.id,
    task_type: message.task_type,
    sender: message.sender,
    recipient: message.recipient,
    body: message.body,
    status: message.status,
    created_at: message.created_at,
    acknowledged_at: message.acknowledged_at,
    acknowledged_by: message.acknowledged_by,
    addressed_at: message.addressed_at,
    addressed_by: message.addressed_by,
  };
}

// ---------------------------------------------------------------------------
// Secondary-rate-limit guard for the (optional) GitHub comment hook.
//
// The drain as wired at api.ts passes NO commentOnIssue, so this path makes zero
// GitHub calls in production today. This guard is defense-in-depth: if the hook
// is ever wired with a real GitHub client, a SECONDARY rate limit here must back
// off with increasing delay rather than hammer the shared token every pass --
// the exact 2026-08-27 failure this WO exists to prevent.
// ---------------------------------------------------------------------------

const commentRateLimitState = createRateLimitBackoffState();
let commentRateLimitLastLoggedAt = 0;

/**
 * Invoke commentOnIssue behind the secondary-rate-limit classifier + increasing
 * backoff. Returns true iff a live call was actually attempted (for external-call
 * accounting). While a backoff window is open, the call is skipped entirely.
 */
async function guardedCommentOnIssue(
  commentOnIssue: (issueRef: string, body: string) => Promise<void>,
  issueRef: string,
  body: string,
  messageId: string,
  nowMs: number
): Promise<boolean> {
  if (nowMs < commentRateLimitState.backoffUntil) {
    return false;
  }
  try {
    await commentOnIssue(issueRef, body);
    resetRateLimitBackoff(commentRateLimitState);
    commentRateLimitLastLoggedAt = 0;
    return true;
  } catch (error) {
    const rateLimitClass = classifyGitHubRateLimit(error);
    if (rateLimitClass !== 'not_rate_limited') {
      const { backoffMs } = advanceRateLimitBackoff(commentRateLimitState, nowMs);
      if (
        nowMs - commentRateLimitLastLoggedAt >= DEFAULT_RATE_LIMIT_BASE_MS ||
        commentRateLimitLastLoggedAt === 0
      ) {
        commentRateLimitLastLoggedAt = nowMs;
        log.warn(
          {
            err: error as Error,
            messageId,
            issueRef,
            backoffMs,
            // SECONDARY limiting reads /rate_limit FULL; never call it quota loss.
            rateLimitClass,
            consecutiveHits: commentRateLimitState.consecutiveHits,
          },
          'operator_inbox.github_comment_rate_limited'
        );
      }
      return true;
    }
    // Best-effort only -- durable surface already written.
    log.warn({ err: error as Error, messageId, issueRef }, 'operator_inbox.github_comment_failed');
    return true;
  }
}

/**
 * A row failed at the DURABLE-SURFACE step -- the human-facing record was never
 * written. This is the ONE failure the drain must NOT watermark: watermarking it
 * would strand the message forever (no durable record AND excluded from every
 * future read). Every OTHER failure (ack/address) happens AFTER the durable
 * surface exists, so watermarking those is safe and is what breaks the
 * reprocessing loop (per WO-HARNESS-OPERATOR-INBOX-BACKPRESSURE-01). A
 * surface-failed row is re-read next pass (bounded by the batch cap) and, unlike
 * the incident loop, never reaches an external GitHub call because surfacing
 * precedes the comment hook.
 */
export class OperatorInboxSurfaceError extends Error {
  constructor(
    readonly messageId: string,
    readonly cause: Error
  ) {
    super(`surface_failed:${cause.message}:${messageId}`);
    this.name = 'OperatorInboxSurfaceError';
  }
}

async function processOne(
  message: OperatorInboxMessage,
  deps: Required<
    Pick<
      OperatorInboxDeps,
      'acknowledgeMessage' | 'addressMessage' | 'surface' | 'principalId' | 'now'
    >
  > &
    Pick<OperatorInboxDeps, 'commentOnIssue'>
): Promise<{ classification: ClassificationKind; externalCallMade: boolean }> {
  const classification = classifyOperatorMessage(message);
  const principalId = deps.principalId;
  const nowDate = deps.now();
  const surfacedAt = nowDate.toISOString();
  let externalCallMade = false;

  if (classification.kind !== 'digest_only') {
    const entry: SurfaceEntry = {
      messageId: message.id,
      classification: classification.kind,
      reason: classification.reason,
      sender: message.sender,
      taskType: message.task_type,
      createdAt: message.created_at,
      originalBody: message.body,
      woId: classification.woId,
      issueRef: classification.issueRef,
      surfacedAt,
    };
    try {
      await deps.surface(entry);
    } catch (error) {
      // Do NOT watermark on a surface failure -- see OperatorInboxSurfaceError.
      throw new OperatorInboxSurfaceError(message.id, error as Error);
    }

    if (
      classification.kind === 'code_actionable' &&
      classification.issueRef &&
      deps.commentOnIssue
    ) {
      externalCallMade = await guardedCommentOnIssue(
        deps.commentOnIssue,
        classification.issueRef,
        [
          '## Operator inbox auto-classification',
          '',
          `- message_id: \`${message.id}\``,
          `- classification: \`${classification.kind}\``,
          `- reason: ${classification.reason}`,
          `- wo_id: ${classification.woId ?? 'n/a'}`,
          `- created_at: ${message.created_at}`,
          '',
          '### Original body',
          '```',
          message.body.slice(0, 4000),
          '```',
          '',
          '_Surfaced by operator-inbox-consumer (WO-HARNESS-OPERATOR-INBOX-CONSUMER-01). Telegram/SMS gate stays dark (#1456)._',
        ].join('\n'),
        message.id,
        nowDate.getTime()
      );
    }
  }

  const ack = await deps.acknowledgeMessage({ id: message.id, principal_id: principalId });
  if (!ack.ok) {
    throw new Error(`acknowledge_failed:${ack.reason}:${message.id}`);
  }
  const addressed = await deps.addressMessage({ id: message.id, principal_id: principalId });
  if (!addressed.ok) {
    throw new Error(`address_failed:${addressed.reason}:${message.id}`);
  }

  log.info(
    {
      messageId: message.id,
      classification: classification.kind,
      reason: classification.reason,
      woId: classification.woId,
    },
    'operator_inbox.message_processed'
  );

  return { classification: classification.kind, externalCallMade };
}

/**
 * Parse a non-negative-integer env knob; 0 or invalid falls back to `fallback`.
 * (Shared shape with resolveOperatorInboxIntervalMs, but 0 is NOT meaningful for
 * these knobs -- a batch cap / retention / threshold of 0 would be nonsense.)
 */
function resolvePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}

export function resolveOperatorInboxBatchCapacity(raw: string | undefined): number {
  return resolvePositiveIntEnv(raw, DEFAULT_OPERATOR_INBOX_BATCH_CAP);
}

export function resolveOperatorInboxRetentionMs(raw: string | undefined): number {
  return resolvePositiveIntEnv(raw, DEFAULT_OPERATOR_INBOX_RETENTION_MS);
}

export function resolveOperatorInboxAlarmThreshold(raw: string | undefined): number {
  return resolvePositiveIntEnv(raw, DEFAULT_OPERATOR_INBOX_ALARM_THRESHOLD);
}

// Episode-dedupe state: the alarm fires ONCE when the backlog crosses the
// threshold and stays silent every subsequent pass until the backlog drops back
// under the threshold (which re-arms it). Not one alarm per tick.
//
// The latch is DURABLE (a JSON file under ARCHON_HOME) so a process restart
// while the backlog is still above threshold does not re-emit the alarm for the
// same episode -- an in-memory boolean alone would re-fire on every restart. The
// in-process value below is a per-process cache of that durable state; it is
// undefined until seeded from the file on the first drain of a process (which is
// how a restart re-reads the durable latch).
let alarmEpisodeActiveCache: boolean | undefined;

function defaultAlarmEpisodeStatePath(): string {
  return join(getArchonHome(), 'operator-inbox', 'alarm-episode.json');
}

/** Durable read of the alarm-episode latch (cold start reads the file). */
async function defaultLoadAlarmEpisodeActive(): Promise<boolean> {
  if (alarmEpisodeActiveCache !== undefined) return alarmEpisodeActiveCache;
  try {
    const raw = await readFile(defaultAlarmEpisodeStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as { active?: unknown };
    alarmEpisodeActiveCache = parsed.active === true;
  } catch {
    // Missing / unreadable file = no active episode. Fail toward re-arming
    // (worst case one extra alarm) rather than silently suppressing forever.
    alarmEpisodeActiveCache = false;
  }
  return alarmEpisodeActiveCache;
}

/** Durable write of the alarm-episode latch. */
async function defaultSaveAlarmEpisodeActive(active: boolean): Promise<void> {
  alarmEpisodeActiveCache = active;
  try {
    await mkdir(join(getArchonHome(), 'operator-inbox'), { recursive: true });
    await writeFile(defaultAlarmEpisodeStatePath(), JSON.stringify({ active }), 'utf8');
  } catch (error) {
    // A persistence failure must not crash the drain; the in-process cache still
    // dedupes within this process, only cross-restart dedupe is degraded.
    log.warn({ err: error as Error }, 'operator_inbox.alarm_episode_persist_failed');
  }
}

/** Default alarm sink: a structured log event ONLY. Never wires notifiers.ts. */
function defaultEmitAlarm(alarm: OperatorInboxAlarm): void {
  log.warn(
    {
      count: alarm.count,
      threshold: alarm.threshold,
      oldestCreatedAt: alarm.oldestCreatedAt,
      oldestAgeMs: alarm.oldestAgeMs,
      topSender: alarm.topSender,
      topSenderCount: alarm.topSenderCount,
    },
    'operator_inbox.backlog_alarm'
  );
}

/**
 * Reset the in-process alarm-episode cache so the next drain re-seeds from the
 * durable latch (used by stopOperatorInboxConsumer + tests). Does NOT clear the
 * durable file: a restart must still honor an active episode.
 */
export function resetOperatorInboxAlarmEpisode(): void {
  alarmEpisodeActiveCache = undefined;
}

/**
 * One drain tick: bounded (batch-capped, oldest-first) read of UN-watermarked
 * operator messages; classify, surface, ack+address; ALWAYS watermark each row
 * (even on ack/address failure) so no row is ever re-read/re-processed; then run
 * the retention sweep, read backlog status, and fire the episode-deduped alarm.
 * Per-message failures are collected so a single bad row cannot stop the drain.
 */
export async function drainOperatorInbox(deps: OperatorInboxDeps = {}): Promise<DrainResult> {
  const batchCap = deps.batchCap ?? DEFAULT_OPERATOR_INBOX_BATCH_CAP;
  const retentionMs = deps.retentionMs ?? DEFAULT_OPERATOR_INBOX_RETENTION_MS;
  const alarmThreshold = deps.alarmThreshold ?? DEFAULT_OPERATOR_INBOX_ALARM_THRESHOLD;

  const list =
    deps.listUnwatermarked ??
    (async (limit: number): Promise<OperatorInboxMessage[]> => {
      const rows = await listUnwatermarkedOperatorInboxMessages(limit);
      return rows.map(toInboxMessage);
    });
  const markWatermark = deps.markWatermark ?? markOperatorInboxWatermark;
  const retireStale = deps.retireStale ?? retireStaleOperatorInboxMessages;
  const getBacklogStatus = deps.getBacklogStatus ?? getOperatorInboxBacklogStatus;
  const emitAlarm = deps.emitAlarm ?? defaultEmitAlarm;
  const loadAlarmEpisode = deps.loadAlarmEpisodeActive ?? defaultLoadAlarmEpisodeActive;
  const saveAlarmEpisode = deps.saveAlarmEpisodeActive ?? defaultSaveAlarmEpisodeActive;
  const ack =
    deps.acknowledgeMessage ??
    ((data: { id: string; principal_id: string }): Promise<DispatchMailboxResult> =>
      acknowledgeMessage(data));
  const address =
    deps.addressMessage ??
    ((data: { id: string; principal_id: string }): Promise<DispatchMailboxResult> =>
      addressMessage(data));
  const surface = deps.surface ?? appendDurableSurfaceLog;
  const principalId = deps.principalId ?? OPERATOR_INBOX_PRINCIPAL;
  const now = deps.now ?? ((): Date => new Date());

  const result: DrainResult = {
    found: 0,
    processed: 0,
    failed: 0,
    digests: 0,
    codeActionable: 0,
    needsHuman: 0,
    errors: [],
    retired: 0,
    externalCalls: 0,
    backlog: null,
    alarmEmitted: false,
  };

  let messages: OperatorInboxMessage[];
  try {
    messages = await list(batchCap);
  } catch (error) {
    const err = error as Error;
    log.error({ err }, 'operator_inbox.list_failed');
    result.failed = 1;
    result.errors.push(`list_failed:${err.message}`);
    return result;
  }

  result.found = messages.length;

  for (const message of messages) {
    // Already addressed elsewhere -- the bounded read should exclude these, but
    // keep the guard for injected/stale views.
    if (message.addressed_at !== null) continue;

    // Watermark UNLESS the durable surface write itself failed. A surface
    // failure means the human record was never written, so watermarking would
    // strand the row permanently; every other failure (ack/address) happens
    // after a successful surface, so watermarking those is what breaks the
    // reprocessing loop. Defaults to true so digest_only rows (no surface) and
    // fully-successful rows are always watermarked.
    let durableSurfaceOk = true;
    try {
      const { classification, externalCallMade } = await processOne(message, {
        acknowledgeMessage: ack,
        addressMessage: address,
        surface,
        principalId,
        now,
        commentOnIssue: deps.commentOnIssue,
      });
      result.processed += 1;
      if (externalCallMade) result.externalCalls += 1;
      if (classification === 'digest_only') result.digests += 1;
      else if (classification === 'code_actionable') result.codeActionable += 1;
      else result.needsHuman += 1;
    } catch (error) {
      const err = error as Error;
      if (error instanceof OperatorInboxSurfaceError) durableSurfaceOk = false;
      result.failed += 1;
      result.errors.push(`${message.id}:${err.message}`);
      log.error({ err, messageId: message.id }, 'operator_inbox.message_process_failed');
    } finally {
      if (durableSurfaceOk) {
        // Watermark: a watermarked row is excluded from the next bounded read,
        // so it is never re-classified and never makes another external call.
        try {
          await markWatermark(message.id);
        } catch (error) {
          log.warn(
            { err: error as Error, messageId: message.id },
            'operator_inbox.watermark_failed'
          );
        }
      } else {
        // Deliberately NOT watermarked: the durable surface never landed, so the
        // row must be retried on a later pass (bounded by the batch cap, and
        // never reaching an external call before it surfaces).
        log.warn({ messageId: message.id }, 'operator_inbox.watermark_skipped_surface_failed');
      }
    }
  }

  // Retention sweep: retire rows aged past the window (terminal, non-draining,
  // NOT cancelled, NOT deleted). Bounded per pass.
  try {
    const retiredIds = await retireStale(
      retentionMs,
      Math.min(OPERATOR_INBOX_RETIREMENT_SWEEP_CAP, Math.max(batchCap, 1) * 4)
    );
    result.retired = retiredIds.length;
    if (retiredIds.length > 0) {
      log.info(
        { retired: retiredIds.length, retentionMs },
        'operator_inbox.retirement_sweep_completed'
      );
    }
  } catch (error) {
    log.warn({ err: error as Error }, 'operator_inbox.retirement_sweep_failed');
  }

  // Backlog status read + episode-deduped alarm. The latch is loaded from (and
  // saved to) durable state so a restart mid-episode does not re-emit.
  try {
    const backlog = await getBacklogStatus();
    result.backlog = backlog;
    const episodeActive = await loadAlarmEpisode();
    if (backlog.count >= alarmThreshold) {
      if (!episodeActive) {
        await saveAlarmEpisode(true);
        const top = backlog.topSenders[0] ?? null;
        const oldestAgeMs = backlog.oldestCreatedAt
          ? Math.max(0, now().getTime() - new Date(backlog.oldestCreatedAt).getTime())
          : null;
        emitAlarm({
          count: backlog.count,
          oldestCreatedAt: backlog.oldestCreatedAt,
          oldestAgeMs,
          topSender: top ? top.sender : null,
          topSenderCount: top ? top.count : null,
          threshold: alarmThreshold,
        });
        result.alarmEmitted = true;
      }
    } else if (episodeActive) {
      // Backlog dropped back under threshold -- re-arm for the next episode.
      await saveAlarmEpisode(false);
    }
  } catch (error) {
    log.warn({ err: error as Error }, 'operator_inbox.backlog_status_failed');
  }

  if (result.processed > 0 || result.failed > 0 || result.retired > 0) {
    log.info(
      {
        found: result.found,
        processed: result.processed,
        failed: result.failed,
        digests: result.digests,
        codeActionable: result.codeActionable,
        needsHuman: result.needsHuman,
        retired: result.retired,
        externalCalls: result.externalCalls,
        backlogCount: result.backlog?.count ?? null,
      },
      'operator_inbox.drain_completed'
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scheduler singleton (cloned from taskmaster/loop.ts startTaskmaster)
// ---------------------------------------------------------------------------

let operatorInboxTimer: ReturnType<typeof setInterval> | undefined;
let operatorInboxRuntime: OperatorInboxRuntime | undefined;

/**
 * Parse OPERATOR_INBOX_INTERVAL_MS: integer > 0 enables at that interval;
 * 0 disables (KILLED); anything else falls back to 60000.
 */
export function resolveOperatorInboxIntervalMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  return DEFAULT_OPERATOR_INBOX_INTERVAL_MS;
}

export function stopOperatorInboxConsumer(): void {
  if (operatorInboxTimer) clearInterval(operatorInboxTimer);
  operatorInboxTimer = undefined;
  operatorInboxRuntime = undefined;
  resetOperatorInboxAlarmEpisode();
}

export function getOperatorInboxRuntime(): OperatorInboxRuntime | undefined {
  return operatorInboxRuntime;
}

/**
 * Start the operator inbox consumer. Module-scope singleton: subsequent calls
 * while a timer exists are no-ops. OPERATOR_INBOX_INTERVAL_MS=0 disables.
 */
export function startOperatorInboxConsumer(deps: OperatorInboxDeps = {}): void {
  if (operatorInboxTimer !== undefined) return;
  const intervalMs = resolveOperatorInboxIntervalMs(process.env.OPERATOR_INBOX_INTERVAL_MS);
  if (intervalMs === 0) {
    log.info({}, 'operator_inbox.disabled_by_interval_env');
    return;
  }
  const runtime: OperatorInboxRuntime = {
    intervalMs,
    lastDrainResult: null,
    ticks: 0,
  };
  operatorInboxRuntime = runtime;
  // Merge env-resolved backpressure knobs, letting explicit deps win (tests).
  const effectiveDeps: OperatorInboxDeps = {
    batchCap: resolveOperatorInboxBatchCapacity(process.env.OPERATOR_INBOX_BATCH_CAP),
    retentionMs: resolveOperatorInboxRetentionMs(process.env.OPERATOR_INBOX_RETENTION_MS),
    alarmThreshold: resolveOperatorInboxAlarmThreshold(process.env.OPERATOR_INBOX_ALARM_THRESHOLD),
    ...deps,
  };
  let inFlight = false;
  const runTick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const drainResult = await drainOperatorInbox(effectiveDeps);
      runtime.lastDrainResult = drainResult;
      runtime.ticks += 1;
    } catch (error) {
      // Outer guard: drainOperatorInbox already isolates per-message errors;
      // this catches unexpected top-level throws so the timer keeps firing.
      log.error({ err: error as Error }, 'operator_inbox.tick_failed');
    } finally {
      inFlight = false;
    }
  };
  operatorInboxTimer = setInterval(() => void runTick(), intervalMs);
  operatorInboxTimer.unref?.();
  void runTick();
}
