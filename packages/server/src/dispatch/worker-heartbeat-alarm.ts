import { randomUUID } from 'crypto';
import { getDatabase } from '@archon/core/db/connection';
import { getWorker, type DispatchWorker } from '@archon/core/db/dispatch';
import {
  getActionsSince,
  recordAction,
  updateActionOutcome,
  type TmActionType,
  type TmActionOutcome,
} from '@archon/core/db/taskmaster';
import { createLogger } from '@archon/paths';
import {
  githubToken,
  githubIssueInAllowList,
  parseGithubSubject,
  type DutyOfficerStaleIssue,
} from './duty-officer-clock';
import { sendCanaryTelegramAlert } from '../services/canary-telegram-alert';
import {
  ESCALATE_CLAIM_IN_FLIGHT_MS,
  escalateP0CutoffIso,
  escalationReason,
  planEscalateDelivery,
  resolveEscalateP0CooldownMs,
  type EscalateJournalRow,
} from '../taskmaster/guard';

const log = createLogger('dispatch/worker-heartbeat-alarm');

const GITHUB_API_ORIGIN = 'https://api.github.com';
const ALARM_COMMENT_MAX_PAGES = 20;
/** Cap on how many restart-evidence entries are journaled per worker per tick. */
const RESTART_EVIDENCE_MAX_ENTRIES = 20;

export interface WorkerAlarmIssueComment {
  body: string;
  created_at: string;
}

/** One reclaimed-death record a worker attaches to its registration capabilities. */
export interface WorkerRestartEvidenceEntry {
  previous_pid: number;
  previous_started_at: string;
}

/** Journal row shape the escalate_p0 cooldown scan reads. */
export interface WorkerHeartbeatEscalationRow {
  id: string;
  thread_ref: string;
  action_type: TmActionType;
  proposal_json: string;
  idempotency_key: string | null;
  outcome: TmActionOutcome;
  created_at: string;
}

/**
 * Row-first journal used by the page path. Structurally a subset of
 * packages/core/src/db/taskmaster.ts recordAction / updateActionOutcome so the
 * real functions can be wired directly and tests can inject an in-memory stub.
 */
export interface WorkerHeartbeatAlarmJournal {
  recordAction: (data: {
    thread_ref: string;
    action_type: TmActionType;
    proposal_json: string;
    idempotency_key: string;
    outcome: TmActionOutcome;
  }) => Promise<{ id: string; outcome: TmActionOutcome }>;
  updateActionOutcome: (
    id: string,
    outcome: TmActionOutcome,
    proposalJson?: string
  ) => Promise<unknown>;
  /**
   * Recent actions for one thread. Omitted by the rejected-send caller, which
   * keeps its hourly idempotency key and does not apply the cooldown.
   */
  listActions?: (threadRef: string) => Promise<WorkerHeartbeatEscalationRow[]>;
  /**
   * Cross-process cooldown claim. The read of sent/pending rows and the insert
   * of this attempt commit in one writer transaction. pageOnce sends only after
   * that claim returns disposition 'send'.
   */
  commitCooldownDecision?: (input: EscalateClaimInput) => Promise<EscalateClaimDisposition>;
}

export interface EscalateClaimInput {
  threadRef: string;
  reason: string;
  idempotencyKey: string;
  proposal: unknown;
  nowMs: number;
  cooldownMs: number;
}

export type EscalateClaimDisposition =
  | { disposition: 'send'; id: string }
  | { disposition: 'suppressed' }
  | { disposition: 'wait' }
  | { disposition: 'skip' };

export interface WorkerHeartbeatAlarmDeps {
  getWorker: (workerId: string) => Promise<DispatchWorker | null>;
  /**
   * GitHub DOWN/UP comment deps (existing behavior). Optional so the dedicated
   * page timer can wire only the page path without also driving the comment
   * cadence; the Duty Officer tick still supplies both.
   */
  postAlarmComment?: (issue: DutyOfficerStaleIssue, body: string) => Promise<void>;
  listIssueComments?: (issue: DutyOfficerStaleIssue) => Promise<WorkerAlarmIssueComment[]>;
  now?: () => Date;
  /** Pages John (Telegram). When both pageOperator and journal are set the page path runs. */
  pageOperator?: (text: string) => Promise<void>;
  /** Row-first journal for every page attempt. */
  journal?: WorkerHeartbeatAlarmJournal;
}

export interface WorkerHeartbeatAlarmConfig {
  enabled: boolean;
  workers: string[];
  staleMinutes: number;
  pageStaleMinutes: number;
  repeatHours: number;
  issue: string;
}

const DEFAULT_WATCHED_WORKERS =
  'dispatch-worker-ASUS-ROG-DSK-2T,overseer-review-worker,inbox-reader';
const DEFAULT_ALARM_ISSUE = 'gh:thinmansoftware/bdc-xo#2489';

export function readWorkerHeartbeatAlarmConfig(): WorkerHeartbeatAlarmConfig {
  const workers = (process.env.DISPATCH_WORKER_ALARM_WORKERS ?? DEFAULT_WATCHED_WORKERS)
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
  const staleMinutes = Math.max(1, Number(process.env.DISPATCH_WORKER_ALARM_STALE_MINUTES) || 10);
  // Page threshold is deliberately shorter than the 10 minute GitHub comment
  // threshold: a worker down for 5 minutes must page John, not just comment.
  const pageStaleMinutes = Math.max(
    1,
    Number(process.env.DISPATCH_WORKER_ALARM_PAGE_STALE_MINUTES) || 5
  );
  const repeatHours = Math.max(1, Number(process.env.DISPATCH_WORKER_ALARM_REPEAT_HOURS) || 6);
  return {
    // Default ON: only the literal string 'false' disables the alarm.
    enabled: process.env.DISPATCH_WORKER_ALARM_ENABLED !== 'false',
    workers,
    staleMinutes,
    pageStaleMinutes,
    repeatHours,
    issue: process.env.DISPATCH_WORKER_ALARM_ISSUE?.trim() || DEFAULT_ALARM_ISSUE,
  };
}

/**
 * Classify each watched worker as stale or healthy based purely on the age of
 * its last heartbeat. A missing row (null) is stale -- there is no third state.
 * The worker's own status column is deliberately ignored: a hung process can
 * report 'available' while its heartbeat clock stops.
 */
export function evaluateWorkerHeartbeats(
  workers: { workerId: string; row: DispatchWorker | null }[],
  nowMs: number,
  config: { staleMinutes: number }
): Record<string, 'stale' | 'healthy'> {
  const staleMs = config.staleMinutes * 60_000;
  const result: Record<string, 'stale' | 'healthy'> = {};
  for (const { workerId, row } of workers) {
    if (!row) {
      result[workerId] = 'stale';
      continue;
    }
    const last = Date.parse(row.last_heartbeat_at);
    if (!Number.isFinite(last)) {
      result[workerId] = 'stale';
      continue;
    }
    result[workerId] = nowMs - last > staleMs ? 'stale' : 'healthy';
  }
  return result;
}

function downMarker(workerId: string): string {
  return `<!-- dispatch-worker-alarm:${workerId}:down -->`;
}

function upMarker(workerId: string): string {
  return `<!-- dispatch-worker-alarm:${workerId}:up -->`;
}

function latestMarkerTime(comments: WorkerAlarmIssueComment[], marker: string): number | null {
  let latest: number | null = null;
  for (const comment of comments) {
    if (!(comment.body ?? '').includes(marker)) continue;
    const at = Date.parse(comment.created_at);
    if (!Number.isFinite(at)) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

function restartPointer(): string {
  return "see the restart recipe in this issue's description";
}

function downBody(
  workerId: string,
  lastHeartbeatIso: string | null,
  minutesSilent: number | null
): string {
  const heartbeat =
    lastHeartbeatIso === null ? 'no heartbeat on record' : `last heartbeat ${lastHeartbeatIso} UTC`;
  const silence =
    minutesSilent === null
      ? 'the worker has never registered a heartbeat'
      : `silent for ${minutesSilent} minutes`;
  return (
    `${downMarker(workerId)}\n` +
    `ALARM: Dispatch worker \`${workerId}\` has stopped heartbeating (${silence}; ${heartbeat}). ` +
    `${restartPointer()}.`
  );
}

function upBody(workerId: string, lastHeartbeatIso: string | null): string {
  const heartbeat =
    lastHeartbeatIso === null ? 'heartbeat restored' : `last heartbeat ${lastHeartbeatIso} UTC`;
  return (
    `${upMarker(workerId)}\n` +
    `RECOVERED: Dispatch worker \`${workerId}\` is heartbeating again (${heartbeat}).`
  );
}

function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) return match[1];
  }
  return null;
}

/**
 * Fetch every comment on the alarm issue, following Link rel="next" pages.
 * GitHub lists issue comments oldest-first, so a single page would miss the
 * newest marker on a busy issue. Mirrors the pagination in
 * packages/server/src/taskmaster/escalation-delivery.ts listAllIssueComments.
 */
export async function listWorkerAlarmIssueComments(
  issue: DutyOfficerStaleIssue
): Promise<WorkerAlarmIssueComment[]> {
  const token = await githubToken();
  if (!token) throw new Error('worker_heartbeat_alarm_token_missing');
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'bdc-harness-worker-heartbeat-alarm',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  let url: string | null =
    `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.number}/comments?per_page=100`;
  const all: WorkerAlarmIssueComment[] = [];
  let pages = 0;
  while (url) {
    if (pages >= ALARM_COMMENT_MAX_PAGES) {
      throw new Error('worker_heartbeat_alarm_comment_pages_exceeded');
    }
    pages += 1;
    const response: Response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      throw new Error(`worker_heartbeat_alarm_http_${response.status}`);
    }
    const page: unknown = await response.json();
    if (!Array.isArray(page)) throw new Error('worker_heartbeat_alarm_comments_not_array');
    for (const raw of page) {
      const comment = (raw ?? {}) as { body?: unknown; created_at?: unknown };
      all.push({
        body: typeof comment.body === 'string' ? comment.body : '',
        created_at: typeof comment.created_at === 'string' ? comment.created_at : '',
      });
    }
    url = page.length > 0 ? parseNextLink(response.headers.get('link')) : null;
  }
  return all;
}

/**
 * Post a comment on the alarm issue directly via the GitHub API. Unlike
 * postGithubIssueComment in duty-officer-clock.ts this does NOT consult
 * DUTY_OFFICER_GH_NUDGE and does NOT dedupe against the nudge marker; dedup for
 * the alarm is handled by runWorkerHeartbeatAlarm via listWorkerAlarmIssueComments.
 * The repo allowlist check is preserved.
 */
export async function postWorkerAlarmComment(
  issue: DutyOfficerStaleIssue,
  body: string
): Promise<void> {
  if (!githubIssueInAllowList(issue)) {
    log.warn({ issue }, 'worker_heartbeat_alarm_repo_refused');
    return;
  }
  const token = await githubToken();
  if (!token) throw new Error('worker_heartbeat_alarm_token_missing');
  const response = await fetch(
    `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.number}/comments`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'bdc-harness-worker-heartbeat-alarm',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!response.ok) {
    throw new Error(`worker_heartbeat_alarm_http_${response.status}`);
  }
}

/**
 * Real deps for the dedicated page timer. Wires ONLY the page path
 * (pageOperator -> Telegram, journal -> tm_journal). The GitHub DOWN/UP comment
 * path stays owned by the Duty Officer tick, which builds its own deps, so the
 * comment cadence and 10 minute threshold are unchanged by this timer.
 */
export function createRealWorkerHeartbeatAlarmDeps(): WorkerHeartbeatAlarmDeps {
  return {
    getWorker,
    now: () => new Date(),
    pageOperator: (text: string) => sendCanaryTelegramAlert(text),
    journal: {
      recordAction,
      updateActionOutcome,
      listActions: (threadRef: string): Promise<WorkerHeartbeatEscalationRow[]> =>
        getActionsSince(escalateP0CutoffIso(Date.now()), threadRef),
      commitCooldownDecision: input => commitCooldownDecisionAtomic(input),
    },
  };
}

/**
 * Parse a worker's capabilities.restart_evidence into the valid death entries.
 * Defensive: a non-array, malformed entries, a missing previous_pid, or a
 * non-string previous_started_at are ignored (never thrown). At most the first
 * 20 entries are considered. reclaimed_at is intentionally NOT read -- the page
 * idempotency key must be built only from worker-supplied identity fields, never
 * from a clock, so a clock-skewed worker cannot change the key.
 */
export function parseWorkerRestartEvidence(
  capabilities: Record<string, unknown> | null | undefined
): WorkerRestartEvidenceEntry[] {
  if (!capabilities || typeof capabilities !== 'object') return [];
  const raw = capabilities.restart_evidence;
  if (!Array.isArray(raw)) return [];
  const entries: WorkerRestartEvidenceEntry[] = [];
  for (const item of raw.slice(0, RESTART_EVIDENCE_MAX_ENTRIES)) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const pid = obj.previous_pid;
    const startedAt = obj.previous_started_at;
    if (typeof pid !== 'number' || !Number.isInteger(pid)) continue;
    if (typeof startedAt !== 'string' || startedAt.length === 0) continue;
    entries.push({ previous_pid: pid, previous_started_at: startedAt });
  }
  return entries;
}

function isProposalRecord(proposal: unknown): proposal is Record<string, unknown> {
  return typeof proposal === 'object' && proposal !== null && !Array.isArray(proposal);
}

/** Journal marker for an attempt that did not page. */
function proposalJsonWithMarker(proposal: unknown, marker: 'cooldown' | 'in_flight'): string {
  try {
    const marked: Record<string, unknown> = isProposalRecord(proposal)
      ? { ...proposal, suppressed: marker }
      : { proposal, suppressed: marker };
    const text = JSON.stringify(marked);
    if (typeof text === 'string') return text;
  } catch {
    // A circular proposal still has to leave a journal row.
  }
  return JSON.stringify({ suppressed: marker });
}

interface JournalIdRow {
  id: string;
  outcome: TmActionOutcome;
}

type JournalQuery = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: readonly JournalIdRow[]; rowCount: number }>;

interface EscalateClaimStore {
  recordAction: WorkerHeartbeatAlarmJournal['recordAction'];
  updateActionOutcome: WorkerHeartbeatAlarmJournal['updateActionOutcome'];
  /**
   * Cross-process lease for an existing pending or failed row. Absent on the
   * in-memory journal; the production claim sets it inside the writer
   * transaction. False means another process owns the row.
   */
  exclusivePendingSend?: (id: string) => Promise<boolean>;
  exclusiveFailedRetry?: (id: string) => Promise<boolean>;
}

/** Postgres serializes cooldown claims; SQLite uses BEGIN IMMEDIATE instead. */
const ESCALATE_COOLDOWN_ADVISORY_LOCK = 88145001;

const escalateLocks = new Map<string, Promise<void>>();

async function withEscalateLock(key: string, fn: () => Promise<void>): Promise<void> {
  const previous = escalateLocks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.then(
    () => current,
    () => current
  );
  escalateLocks.set(key, tail);
  await previous.then(
    () => undefined,
    () => undefined
  );
  try {
    await fn();
  } finally {
    if (release) release();
    if (escalateLocks.get(key) === tail) escalateLocks.delete(key);
  }
}

async function insertJournalRow(
  query: JournalQuery,
  data: {
    thread_ref: string;
    action_type: TmActionType;
    proposal_json: string;
    idempotency_key: string;
    outcome: TmActionOutcome;
  },
  nowMs: number
): Promise<{ id: string; outcome: TmActionOutcome; inserted: boolean }> {
  const inserted = await query(
    `INSERT INTO tm_journal
     (id, created_at, thread_ref, action_type, proposal_json, idempotency_key,
      before_hash, proof_predicate, proof_deadline_at, outcome)
     SELECT $1, $2, $3, $4, $5, $6, NULL, NULL, NULL, $7
     WHERE NOT EXISTS (SELECT 1 FROM tm_journal WHERE idempotency_key = $6)
     RETURNING id, outcome`,
    [
      randomUUID(),
      new Date(nowMs).toISOString(),
      data.thread_ref,
      data.action_type,
      data.proposal_json,
      data.idempotency_key,
      data.outcome,
    ]
  );
  const created = inserted.rows[0];
  if (created) return { id: created.id, outcome: created.outcome, inserted: true };
  const existing = await query(
    'SELECT id, outcome FROM tm_journal WHERE idempotency_key = $1 ORDER BY created_at ASC LIMIT 1',
    [data.idempotency_key]
  );
  const found = existing.rows[0];
  if (!found) throw new Error('worker_heartbeat_page_journal_missing');
  return { id: found.id, outcome: found.outcome, inserted: false };
}

/**
 * Journal a suppression. A pending, sent, or failed row already belongs to a
 * delivery or a retry, so it is left unchanged.
 */
async function journalMarkedSuppression(
  journal: Pick<WorkerHeartbeatAlarmJournal, 'recordAction' | 'updateActionOutcome'>,
  input: EscalateClaimInput,
  marker: 'cooldown' | 'in_flight'
): Promise<void> {
  const proposalJson = proposalJsonWithMarker(input.proposal, marker);
  const row = await journal.recordAction({
    thread_ref: input.threadRef,
    action_type: 'escalate_p0',
    proposal_json: proposalJson,
    idempotency_key: input.idempotencyKey,
    outcome: 'expired',
  });
  if (
    row.outcome === 'pending' ||
    row.outcome === 'sent' ||
    row.outcome === 'failed' ||
    row.outcome === 'expired'
  ) {
    return;
  }
  await journal.updateActionOutcome(row.id, 'expired', proposalJson);
}

async function finishEscalateClaim(
  journal: EscalateClaimStore,
  rows: readonly EscalateJournalRow[],
  input: EscalateClaimInput
): Promise<EscalateClaimDisposition> {
  const plan = planEscalateDelivery({
    rows,
    threadRef: input.threadRef,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    nowMs: input.nowMs,
    cooldownMs: input.cooldownMs,
  });
  if (plan === 'wait') {
    const own = rows.find(row => row.idempotency_key === input.idempotencyKey);
    // The live pending row is the record. A different key must be journaled
    // or the attempt disappears when the in-flight send succeeds.
    if (own?.outcome === 'pending') return { disposition: 'wait' };
    await journalMarkedSuppression(journal, input, 'in_flight');
    return { disposition: 'suppressed' };
  }
  if (plan === 'skip') return { disposition: 'skip' };
  if (plan === 'suppress') {
    await journalMarkedSuppression(journal, input, 'cooldown');
    return { disposition: 'suppressed' };
  }
  const entry = await journal.recordAction({
    thread_ref: input.threadRef,
    action_type: 'escalate_p0',
    proposal_json: JSON.stringify(input.proposal),
    idempotency_key: input.idempotencyKey,
    outcome: 'pending',
  });
  if (entry.outcome === 'pending') {
    // Inserting the pending row wins the claim. An existing pending row is
    // not permission to send: only a stale-lease update that this transaction
    // wins may retry it. Anyone else waits.
    if (journal.exclusivePendingSend && !(await journal.exclusivePendingSend(entry.id))) {
      return { disposition: 'wait' };
    }
    const preexisting = rows.find(row => row.idempotency_key === input.idempotencyKey);
    if (!journal.exclusivePendingSend && preexisting?.outcome === 'pending') {
      const atMs = Date.parse(preexisting.created_at);
      const inFlight = Number.isFinite(atMs) && input.nowMs - atMs < ESCALATE_CLAIM_IN_FLIGHT_MS;
      if (inFlight) return { disposition: 'wait' };
    }
    return { disposition: 'send', id: entry.id };
  }
  if (entry.outcome === 'failed') {
    if (journal.exclusiveFailedRetry && !(await journal.exclusiveFailedRetry(entry.id))) {
      return { disposition: 'wait' };
    }
    return { disposition: 'send', id: entry.id };
  }
  return { disposition: 'skip' };
}

/**
 * Read the cooldown window and insert this attempt in one writer transaction.
 * A second process cannot also observe "no sent row" and insert a sendable claim.
 */
async function commitCooldownDecisionAtomic(
  input: EscalateClaimInput
): Promise<EscalateClaimDisposition> {
  const db = getDatabase();
  const sinceIso = escalateP0CutoffIso(input.nowMs, input.cooldownMs);
  return db.withTransaction(
    async query => {
      if (db.dialect === 'postgres') {
        await query('SELECT pg_advisory_xact_lock($1)', [ESCALATE_COOLDOWN_ADVISORY_LOCK]);
      }
      const selected = await query<WorkerHeartbeatEscalationRow>(
        `SELECT id, thread_ref, action_type, proposal_json, idempotency_key, outcome, created_at
         FROM tm_journal
         WHERE thread_ref = $1 AND action_type = 'escalate_p0' AND created_at >= $2
         ORDER BY created_at ASC`,
        [input.threadRef, sinceIso]
      );
      const leaseUntil = new Date(input.nowMs + ESCALATE_CLAIM_IN_FLIGHT_MS).toISOString();
      const nowIso = new Date(input.nowMs).toISOString();
      let claimedByInsert = false;
      const store: EscalateClaimStore = {
        recordAction: async data => {
          const row = await insertJournalRow(query, data, input.nowMs);
          if (row.inserted && row.outcome === 'pending') claimedByInsert = true;
          return row;
        },
        updateActionOutcome: async (id, outcome, proposalJson) => {
          // Never let a suppression overwrite a live or finished delivery.
          if (proposalJson === undefined) {
            await query(
              `UPDATE tm_journal SET outcome = $1
               WHERE id = $2 AND outcome NOT IN ('pending', 'sent', 'failed')`,
              [outcome, id]
            );
          } else {
            await query(
              `UPDATE tm_journal SET outcome = $1, proposal_json = $2
               WHERE id = $3 AND outcome NOT IN ('pending', 'sent', 'failed')`,
              [outcome, proposalJson, id]
            );
          }
          return null;
        },
        // One writer wins the lease. A pending row this transaction did not
        // insert, or a failed row another process already claimed, does not send.
        exclusivePendingSend: async (id: string): Promise<boolean> => {
          if (claimedByInsert) return true;
          const updated = await query(
            `UPDATE tm_journal SET proof_deadline_at = $1
             WHERE id = $2 AND outcome = 'pending'
               AND (proof_deadline_at IS NULL OR proof_deadline_at <= $3)`,
            [leaseUntil, id, nowIso]
          );
          return updated.rowCount === 1;
        },
        exclusiveFailedRetry: async (id: string): Promise<boolean> => {
          const updated = await query(
            `UPDATE tm_journal SET proof_deadline_at = $1
             WHERE id = $2 AND outcome = 'failed'
               AND (proof_deadline_at IS NULL OR proof_deadline_at <= $3)`,
            [leaseUntil, id, nowIso]
          );
          return updated.rowCount === 1;
        },
      };
      return finishEscalateClaim(store, selected.rows, input);
    },
    { immediate: true }
  );
}

/**
 * Journal one page attempt ROW-FIRST, then page, then flip the outcome. The row
 * is keyed by idempotencyKey: recordAction returns the existing row when the key
 * is already present, so a row already 'sent' is skipped (no duplicate page).
 * A pending row still inside the in-flight window belongs to the process that
 * inserted it; a second process waits. A stale pending row or a failed row is
 * retried by whichever transaction wins the lease. The alarm therefore holds
 * no state -- a restart after the lease simply re-reads the row and continues.
 *
 * The in-process lock is held across the claim and the send, so two alarm runs
 * in this process cannot both page the same thread and reason. The production
 * journal's commitCooldownDecision repeats that claim inside one writer
 * transaction, so a second process sees the pending row and does not page.
 * A suppression never rewrites a pending, sent, or failed row.
 *
 * Without listActions and without commitCooldownDecision the cooldown is
 * skipped and the idempotency key alone dedupes.
 *
 * Exported so the Taskmaster's rejected-send alarm pages through this same
 * journal-first path (one row per idempotency key, so one page per key).
 */
export async function pageOnce(
  deps: { pageOperator: (text: string) => Promise<void>; journal: WorkerHeartbeatAlarmJournal },
  args: { idempotencyKey: string; threadRef: string; text: string; proposal: unknown },
  nowMs: number = Date.now()
): Promise<void> {
  const reason = escalationReason(args.proposal, args.threadRef);
  const cooldownMs = resolveEscalateP0CooldownMs();
  const claimInput: EscalateClaimInput = {
    threadRef: args.threadRef,
    reason,
    idempotencyKey: args.idempotencyKey,
    proposal: args.proposal,
    nowMs,
    cooldownMs,
  };
  await withEscalateLock(`${args.threadRef}\0${reason}`, async () => {
    const claim = await claimEscalateAttempt(deps.journal, claimInput);
    if (claim.disposition === 'suppressed') {
      log.info(
        { threadRef: args.threadRef, reason, idempotencyKey: args.idempotencyKey },
        'worker_heartbeat_page_suppressed'
      );
    }
    if (claim.disposition !== 'send') return;
    try {
      await deps.pageOperator(args.text);
      await deps.journal.updateActionOutcome(claim.id, 'sent');
    } catch (error) {
      log.error(
        { err: error, idempotencyKey: args.idempotencyKey },
        'worker_heartbeat_page_failed'
      );
      await deps.journal.updateActionOutcome(claim.id, 'failed');
    }
  });
}

async function claimEscalateAttempt(
  journal: WorkerHeartbeatAlarmJournal,
  input: EscalateClaimInput
): Promise<EscalateClaimDisposition> {
  if (journal.commitCooldownDecision) return journal.commitCooldownDecision(input);
  if (!journal.listActions) {
    const entry = await journal.recordAction({
      thread_ref: input.threadRef,
      action_type: 'escalate_p0',
      proposal_json: JSON.stringify(input.proposal),
      idempotency_key: input.idempotencyKey,
      outcome: 'pending',
    });
    if (entry.outcome === 'pending' || entry.outcome === 'failed') {
      return { disposition: 'send', id: entry.id };
    }
    return { disposition: 'skip' };
  }
  const rows = await journal.listActions(input.threadRef);
  return finishEscalateClaim(journal, rows, input);
}

/**
 * Page path: journal + page a dead worker, independent of GitHub and of
 * heartbeat freshness for restart evidence. Runs only when pageOperator AND
 * journal are both wired (the dedicated timer), so the Duty Officer tick -- which
 * wires neither -- is unaffected.
 */
async function runWorkerPagePath(
  deps: {
    getWorker: WorkerHeartbeatAlarmDeps['getWorker'];
    pageOperator: (text: string) => Promise<void>;
    journal: WorkerHeartbeatAlarmJournal;
  },
  config: WorkerHeartbeatAlarmConfig,
  nowMs: number
): Promise<void> {
  const pageStaleMs = config.pageStaleMinutes * 60_000;
  const repeatMs = config.repeatHours * 60 * 60 * 1000;

  for (const workerId of config.workers) {
    let row: DispatchWorker | null;
    try {
      row = await deps.getWorker(workerId);
    } catch (error) {
      log.error({ err: error, workerId }, 'worker_heartbeat_page_get_worker_failed');
      continue;
    }
    const threadRef = `dispatch-worker:${workerId}`;

    // 1) Restart-evidence deaths: paged regardless of heartbeat freshness. Each
    //    death is keyed only by previous_pid + previous_started_at.
    for (const entry of parseWorkerRestartEvidence(row?.capabilities)) {
      await pageOnce(
        deps,
        {
          idempotencyKey: `dispatch-worker-death:${workerId}:${entry.previous_pid}:${entry.previous_started_at}`,
          threadRef,
          text:
            `[DISPATCH WORKER DEATH] ${workerId} pid ${entry.previous_pid} ` +
            `(started ${entry.previous_started_at}) died and was reclaimed on restart.`,
          proposal: {
            kind: 'worker_death',
            worker_id: workerId,
            previous_pid: entry.previous_pid,
            previous_started_at: entry.previous_started_at,
          },
        },
        nowMs
      );
    }

    // 2) Heartbeat-age page: a worker whose last heartbeat is older than the
    //    page threshold. Keyed by the last heartbeat ISO plus a repeat bucket so
    //    it pages once per repeat window and retries a failed attempt in-window.
    if (!row) continue;
    const last = Date.parse(row.last_heartbeat_at);
    if (!Number.isFinite(last)) continue;
    if (nowMs - last <= pageStaleMs) continue;
    const bucket = Math.floor((nowMs - last) / repeatMs);
    const minutesSilent = Math.max(0, Math.floor((nowMs - last) / 60_000));
    await pageOnce(
      deps,
      {
        idempotencyKey: `dispatch-worker-page:${workerId}:${row.last_heartbeat_at}:${bucket}`,
        threadRef,
        text:
          `[DISPATCH WORKER DOWN] ${workerId} silent for ${minutesSilent} minutes ` +
          `(last heartbeat ${row.last_heartbeat_at}). No heartbeat past the ${config.pageStaleMinutes} minute page threshold.`,
        proposal: {
          kind: 'worker_down',
          worker_id: workerId,
          last_heartbeat_at: row.last_heartbeat_at,
          minutes_silent: minutesSilent,
        },
      },
      nowMs
    );
  }
}

/**
 * Evaluate every watched Dispatch worker and post DOWN / UP alarm comments on
 * the configured issue. Reads env config each call. Never throws: per-worker
 * failures are caught and logged so one bad worker cannot block the others or
 * break the Duty Officer tick.
 */
export async function runWorkerHeartbeatAlarm(deps: WorkerHeartbeatAlarmDeps): Promise<void> {
  const config = readWorkerHeartbeatAlarmConfig();
  if (!config.enabled) {
    log.info('worker_heartbeat_alarm_disabled');
    return;
  }
  if (config.workers.length === 0) {
    log.info('worker_heartbeat_alarm_no_workers');
    return;
  }

  const now = deps.now?.() ?? new Date();
  const nowMs = now.getTime();

  // Page path: pages John and journals row-first, independent of GitHub. Runs
  // BEFORE the token/allowlist gates below so a page fires even with no token.
  if (deps.pageOperator && deps.journal) {
    try {
      await runWorkerPagePath(
        { getWorker: deps.getWorker, pageOperator: deps.pageOperator, journal: deps.journal },
        config,
        nowMs
      );
    } catch (error) {
      log.error({ err: error }, 'worker_heartbeat_page_path_failed');
    }
  }

  // Comment path (existing GitHub DOWN/UP behavior, unchanged). Skipped unless
  // both comment deps are wired -- the page timer wires neither.
  const postAlarmComment = deps.postAlarmComment;
  const listIssueComments = deps.listIssueComments;
  if (!postAlarmComment || !listIssueComments) return;

  const issue = parseGithubSubject(config.issue);
  if (!issue) {
    log.warn({ issue: config.issue }, 'worker_heartbeat_alarm_issue_invalid');
    return;
  }
  if (!githubIssueInAllowList(issue)) {
    log.warn({ issue }, 'worker_heartbeat_alarm_repo_refused');
    return;
  }
  if (!(await githubToken())) {
    // Loud, not silent: without a token no comment alarm can fire.
    log.error('worker_heartbeat_alarm_no_token');
    return;
  }

  const rows = await Promise.all(
    config.workers.map(async workerId => ({
      workerId,
      row: await deps.getWorker(workerId),
    }))
  );
  const rowByWorker = new Map(rows.map(entry => [entry.workerId, entry.row] as const));
  const states = evaluateWorkerHeartbeats(rows, nowMs, { staleMinutes: config.staleMinutes });

  let comments: WorkerAlarmIssueComment[];
  try {
    comments = await listIssueComments(issue);
  } catch (error) {
    log.error({ err: error, issue }, 'worker_heartbeat_alarm_list_comments_failed');
    return;
  }

  const repeatMs = config.repeatHours * 60 * 60 * 1000;

  for (const workerId of config.workers) {
    const state = states[workerId];
    const lastDown = latestMarkerTime(comments, downMarker(workerId));
    const lastUp = latestMarkerTime(comments, upMarker(workerId));
    // A DOWN cycle is "open" when the most recent DOWN marker is newer than the
    // most recent UP marker (or there is no UP yet).
    const activeDown = lastDown !== null && (lastUp === null || lastDown > lastUp);

    try {
      if (state === 'stale') {
        const withinRepeatWindow =
          lastDown !== null &&
          (lastUp === null || lastDown > lastUp) &&
          nowMs - lastDown <= repeatMs;
        if (withinRepeatWindow) continue;
        const row = rowByWorker.get(workerId) ?? null;
        const lastHeartbeatIso = row ? row.last_heartbeat_at : null;
        const minutesSilent = row
          ? Math.max(0, Math.floor((nowMs - Date.parse(row.last_heartbeat_at)) / 60_000))
          : null;
        await postAlarmComment(issue, downBody(workerId, lastHeartbeatIso, minutesSilent));
        log.warn({ workerId, issue }, 'worker_heartbeat_alarm_down_posted');
      } else {
        // Healthy: post one recovery comment only if a DOWN is still open.
        if (!activeDown) continue;
        const row = rowByWorker.get(workerId) ?? null;
        await postAlarmComment(issue, upBody(workerId, row ? row.last_heartbeat_at : null));
        log.info({ workerId, issue }, 'worker_heartbeat_alarm_up_posted');
      }
    } catch (error) {
      log.error({ err: error, workerId, issue }, 'worker_heartbeat_alarm_post_failed');
    }
  }
}

const DEFAULT_ALARM_INTERVAL_MS = 60_000;
const MIN_ALARM_INTERVAL_MS = 5_000;

let alarmTimerHandle: unknown = null;
let alarmClearFn: ((handle: unknown) => void) | null = null;
let alarmTickInFlight = false;

export interface WorkerHeartbeatAlarmTimerOptions {
  /** Injected for tests; defaults to the global setInterval. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  /** Injected for tests; defaults to the global clearInterval. */
  clearIntervalFn?: (handle: unknown) => void;
  /** Injected for tests; defaults to createRealWorkerHeartbeatAlarmDeps(). */
  deps?: WorkerHeartbeatAlarmDeps;
}

/**
 * Start the dedicated worker-heartbeat page timer. Runs runWorkerHeartbeatAlarm
 * on its own short interval (default 60s, min 5s) so a dead worker pages John
 * within ~1 minute rather than waiting on the 15-minute Duty Officer tick. Never
 * starts under NODE_ENV=test; a second start with a live timer is a no-op; the
 * handle is unref-ed so it cannot keep the process alive.
 */
export function startWorkerHeartbeatAlarmTimer(
  options: WorkerHeartbeatAlarmTimerOptions = {}
): void {
  if (process.env.NODE_ENV === 'test') return;
  if (alarmTimerHandle !== null) return;

  const intervalMs = Math.max(
    MIN_ALARM_INTERVAL_MS,
    Number(process.env.DISPATCH_WORKER_ALARM_INTERVAL_MS) || DEFAULT_ALARM_INTERVAL_MS
  );
  const setIntervalFn: (fn: () => void, ms: number) => unknown =
    options.setIntervalFn ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms));
  const clearIntervalFn: (handle: unknown) => void =
    options.clearIntervalFn ??
    ((handle: unknown): void => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });
  const deps = options.deps ?? createRealWorkerHeartbeatAlarmDeps();

  const handle = setIntervalFn(() => {
    if (alarmTickInFlight) return;
    alarmTickInFlight = true;
    void runWorkerHeartbeatAlarm(deps)
      .catch((error: unknown) => {
        log.error({ err: error }, 'worker_heartbeat_alarm_timer_failed');
      })
      .finally(() => {
        alarmTickInFlight = false;
      });
  }, intervalMs);
  (handle as { unref?: () => void })?.unref?.();

  alarmTimerHandle = handle;
  alarmClearFn = clearIntervalFn;
}

/** Stop the page timer if running. Idempotent. */
export function stopWorkerHeartbeatAlarmTimer(): void {
  if (alarmTimerHandle !== null && alarmClearFn) {
    alarmClearFn(alarmTimerHandle);
  }
  alarmTimerHandle = null;
  alarmClearFn = null;
}
