/**
 * Operator read/enqueue surface for PR review work.
 * Reuses createRealIngestDeps().enqueueReviewWork -- no second queue.
 */
import { getDatabase } from '@archon/core/db/connection';
import * as dispatch from '@archon/core/db/dispatch';
import type { DispatchMessage, DispatchMessageStatus } from '@archon/core/db/dispatch';
import {
  countConsecutiveAutoRereviews,
  countTotalAutoRereviews,
  resolveMaxRereviewAttempts,
  resolveMaxTotalRereviews,
  reviewCorrelationId,
} from './pr-review-ingest';
import type { PriorReviewWork } from './pr-review-ingest';
import {
  createRealIngestDeps,
  fetchCurrentPullHead,
  parseReviewWorkBody,
  resolveReviewRouteConfig,
  REVIEW_RECIPIENT,
  reviewCorrelationPrefix,
  reviewSubjectKey,
} from './pr-review-wiring';
import type { IngestDeps } from './pr-review-ingest';

const OPERATOR_REQUEST_KIND = 'operator_request';
const INGEST_RECEIPT_KIND = 'pr_review_ingest_receipt';
const REVIEW_CORRELATION = /^pr-review:([^/]+)\/([^#]+)#([1-9][0-9]*)@([0-9a-fA-F]{40})$/;
const QUEUE_STATUSES = ['queued', 'claimed', 'failed'] as const;
const ORPHAN_QUEUED_AFTER_MS = 24 * 60 * 60 * 1000;
const DUMMY_OPERATOR_WEBHOOK_SECRET = 'operator-pr-review';
const DUMMY_OPERATOR_REVIEWER_IDENTITY = 'thinman-overseer[bot]';

export type PrReviewQueueStatus = (typeof QUEUE_STATUSES)[number];

export interface PrReviewStatusQuery {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface PrReviewRequestInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  reason: string;
}

export interface PrReviewRequestAccepted {
  ok: true;
  messageId: string;
  alreadyExisted: boolean;
  correlationId: string;
}

export type PrReviewRequestRejected =
  | { ok: false; error: 'head_lookup_failed' }
  | { ok: false; error: 'head_not_current'; currentHead: string };

export type PrReviewRequestResult = PrReviewRequestAccepted | PrReviewRequestRejected;

export interface ResolvedPrHead {
  currentHead: string;
  baseRef: string;
  author: string;
}

export type ResolveCurrentHeadFn = (input: {
  owner: string;
  repo: string;
  prNumber: number;
}) => Promise<ResolvedPrHead>;

export interface PrReviewLastReview {
  messageId: string;
  headSha: string;
  verdict: PriorReviewWork['verdict'];
  verdictId: string | null;
}

export interface PrReviewLatestIngest {
  /** An IngestDisposition when the receipt was written by this code; kept open for older receipts. */
  disposition: string;
  reason: string | null;
  headSha: string | null;
}

export interface PrReviewStatusResult {
  owner: string;
  repo: string;
  prNumber: number;
  current_head: string | null;
  last_review: PrReviewLastReview | null;
  last_judged_head: string | null;
  head_moved: boolean;
  consecutive_auto_rereviews: number;
  max_consecutive_auto_rereviews: number;
  total_auto_rereviews: number;
  max_total_auto_rereviews: number;
  latest_ingest: PrReviewLatestIngest | null;
  why_no_review: string;
}

export interface PrReviewQueueItem {
  id: string;
  status: DispatchMessageStatus;
  age_seconds: number;
  owner: string | null;
  repo: string | null;
  prNumber: number | null;
  headSha: string | null;
  repeat_reason: string | null;
  correlation_id: string;
}

export interface PrReviewOrphanedRecipient {
  recipient: string;
  count: number;
  oldest_age_seconds: number;
}

export interface PrReviewQueueResult {
  items: PrReviewQueueItem[];
  orphaned: PrReviewOrphanedRecipient[];
}

interface IngestReceiptBody {
  kind?: string;
  disposition?: string;
  reason?: string | null;
  headSha?: string | null;
  messageId?: string | null;
}

interface QueuedRecipientAgeRow {
  recipient: string;
  count: number | string;
  oldest_created_at: string;
}

let cachedReviewWorkDeps: IngestDeps | undefined;
let injectedResolveCurrentHead: ResolveCurrentHeadFn | undefined;
let injectedNow: (() => number) | undefined;
let injectedStaleAfterMs: number | undefined;

function reviewWorkDeps(): IngestDeps {
  if (!cachedReviewWorkDeps) {
    const configured = resolveReviewRouteConfig();
    cachedReviewWorkDeps = createRealIngestDeps(
      configured ?? {
        webhookSecret: DUMMY_OPERATOR_WEBHOOK_SECRET,
        reviewerIdentity: DUMMY_OPERATOR_REVIEWER_IDENTITY,
      }
    );
  }
  return cachedReviewWorkDeps;
}

export function setResolveCurrentHead(resolver: ResolveCurrentHeadFn | undefined): void {
  injectedResolveCurrentHead = resolver;
}

export function setPrReviewOperatorClock(
  input: { now?: () => number; staleAfterMs?: number } | undefined
): void {
  injectedNow = input?.now;
  injectedStaleAfterMs = input?.staleAfterMs;
}

async function defaultResolveCurrentHead(input: {
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<ResolvedPrHead> {
  return fetchCurrentPullHead(input);
}

export function operatorRequestIdempotencyKey(input: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}): string {
  return `${reviewCorrelationId(input)}:${OPERATOR_REQUEST_KIND}`;
}

export function operatorRequestRepeatReason(reason: string): string {
  return `${OPERATOR_REQUEST_KIND}:${reason}`;
}

export function parseReviewCorrelationId(
  correlationId: string
): { owner: string; repo: string; prNumber: number; headSha: string } | null {
  const match = REVIEW_CORRELATION.exec(correlationId);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null;
  return {
    owner: match[1],
    repo: match[2],
    prNumber: Number(match[3]),
    headSha: match[4],
  };
}

function ageSecondsSince(isoTimestamp: string, nowMs: number): number {
  const createdMs = Date.parse(isoTimestamp);
  if (!Number.isFinite(createdMs)) return 0;
  return Math.max(0, Math.floor((nowMs - createdMs) / 1000));
}

function parseIngestReceipt(message: DispatchMessage): PrReviewLatestIngest | null {
  try {
    const body = JSON.parse(message.body) as IngestReceiptBody;
    if (body.kind !== INGEST_RECEIPT_KIND || typeof body.disposition !== 'string') {
      return null;
    }
    const parsed = parseReviewCorrelationId(message.correlation_id);
    return {
      disposition: body.disposition,
      reason: body.reason ?? null,
      headSha:
        typeof body.headSha === 'string' && body.headSha !== ''
          ? body.headSha
          : (parsed?.headSha ?? null),
    };
  } catch {
    return null;
  }
}

async function latestIngestReceipt(input: PrReviewStatusQuery): Promise<{
  receipt: PrReviewLatestIngest | null;
  createdAt: string | null;
}> {
  const messages = await dispatch.listMessagesByCorrelationPrefixWithoutSubjectKey({
    recipient: 'operator',
    correlationPrefix: reviewCorrelationPrefix(input.owner, input.repo, input.prNumber),
    limit: 200,
  });
  for (const message of messages) {
    const receipt = parseIngestReceipt(message);
    if (receipt) return { receipt, createdAt: message.created_at };
  }
  return { receipt: null, createdAt: null };
}

function whyNoReview(input: {
  pending: PriorReviewWork | undefined;
  latestIngest: PrReviewLatestIngest | null;
  currentHead: string | null;
}): string {
  if (input.pending) return `review queued, id ${input.pending.messageId}`;
  if (input.latestIngest?.disposition === 'blocked') {
    const reason = input.latestIngest.reason?.trim();
    return reason ? `blocked: ${reason}` : 'blocked';
  }
  if (input.currentHead) return `no pull_request event received since ${input.currentHead}`;
  return 'no pull_request event received';
}

export async function getPrReviewStatus(input: PrReviewStatusQuery): Promise<PrReviewStatusResult> {
  const deps = reviewWorkDeps();
  const prior = await deps.listPriorReviewWork(input);
  const newestWork = prior[0];
  const { receipt: latestIngest, createdAt: receiptCreatedAt } = await latestIngestReceipt(input);
  const workMessages = await dispatch.listMessages({
    recipient: REVIEW_RECIPIENT,
    subject_key: reviewSubjectKey(input.owner, input.repo, input.prNumber),
    limit: 500,
  });
  const newestWorkCreatedAt = workMessages[0]?.created_at ?? null;
  const receiptIsNewer =
    latestIngest?.headSha &&
    receiptCreatedAt &&
    (!newestWorkCreatedAt || Date.parse(receiptCreatedAt) >= Date.parse(newestWorkCreatedAt));
  const currentHead = receiptIsNewer
    ? latestIngest.headSha
    : newestWork?.headSha || latestIngest?.headSha || null;
  const lastReview = prior.find(work => work.verdict !== null) ?? null;
  const lastJudgedHead = lastReview?.headSha ?? null;
  const pending = prior.find(work => work.status === 'queued' || work.status === 'claimed');
  const consecutive = countConsecutiveAutoRereviews(prior, currentHead ?? undefined, false);
  const total = countTotalAutoRereviews(prior);

  return {
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    current_head: currentHead,
    last_review: lastReview
      ? {
          messageId: lastReview.messageId,
          headSha: lastReview.headSha,
          verdict: lastReview.verdict,
          verdictId: lastReview.verdictId,
        }
      : null,
    last_judged_head: lastJudgedHead,
    head_moved: Boolean(currentHead && lastJudgedHead && currentHead !== lastJudgedHead),
    consecutive_auto_rereviews: consecutive,
    max_consecutive_auto_rereviews: resolveMaxRereviewAttempts(),
    total_auto_rereviews: total,
    max_total_auto_rereviews: resolveMaxTotalRereviews(),
    latest_ingest: latestIngest,
    why_no_review: whyNoReview({ pending, latestIngest, currentHead }),
  };
}

export async function requestPrReview(
  input: PrReviewRequestInput,
  options?: { resolveCurrentHead?: ResolveCurrentHeadFn }
): Promise<PrReviewRequestResult> {
  const resolver =
    options?.resolveCurrentHead ?? injectedResolveCurrentHead ?? defaultResolveCurrentHead;
  let resolved: ResolvedPrHead;
  try {
    resolved = await resolver({
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
    });
  } catch {
    return { ok: false, error: 'head_lookup_failed' };
  }
  if (typeof resolved.currentHead !== 'string' || resolved.currentHead === '') {
    return { ok: false, error: 'head_lookup_failed' };
  }
  if (input.headSha.toLowerCase() !== resolved.currentHead.toLowerCase()) {
    return { ok: false, error: 'head_not_current', currentHead: resolved.currentHead };
  }
  const correlationId = reviewCorrelationId(input);
  const idempotencyKey = operatorRequestIdempotencyKey(input);
  const subjectKey = reviewSubjectKey(input.owner, input.repo, input.prNumber);
  const prior = await dispatch.listMessages({
    recipient: REVIEW_RECIPIENT,
    subject_key: subjectKey,
    limit: 500,
  });
  const existing = prior.find(message => message.idempotency_key === idempotencyKey);
  const enqueued = await reviewWorkDeps().enqueueReviewWork({
    correlationId,
    idempotencyKey,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    baseRef: resolved.baseRef,
    author: resolved.author,
    repeatReason: operatorRequestRepeatReason(input.reason),
    headCiGreen: false,
  });
  return {
    ok: true,
    messageId: enqueued.messageId,
    alreadyExisted: existing !== undefined,
    correlationId,
  };
}

async function listReviewWorkPages(status: PrReviewQueueStatus): Promise<DispatchMessage[]> {
  const items: DispatchMessage[] = [];
  let afterSeq: number | undefined;
  for (;;) {
    const page = await dispatch.listMessagesBySeqCursor({
      recipient: REVIEW_RECIPIENT,
      task_type: 'run_review',
      status,
      afterSeq,
      limit: 500,
    });
    if (page.length === 0) break;
    items.push(...page);
    afterSeq = page[page.length - 1]?.cursor_seq;
    if (page.length < 500) break;
  }
  return items;
}

function toQueueItem(message: DispatchMessage, nowMs: number): PrReviewQueueItem {
  const parsed = parseReviewCorrelationId(message.correlation_id);
  const body = parseReviewWorkBody(message.body);
  return {
    id: message.id,
    status: message.status,
    age_seconds: ageSecondsSince(message.created_at, nowMs),
    owner: body?.owner ?? parsed?.owner ?? null,
    repo: body?.repo ?? parsed?.repo ?? null,
    prNumber: body?.prNumber ?? parsed?.prNumber ?? null,
    headSha: body?.headSha ?? parsed?.headSha ?? null,
    repeat_reason: message.repeat_reason,
    correlation_id: message.correlation_id,
  };
}

interface DispatchWorkerOrphanRow {
  worker_id: string;
  status: string;
  last_heartbeat_at: string;
  capabilities: unknown;
}

function parseWorkerCapabilities(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function workerCoversRecipient(
  worker: { worker_id: string; capabilities: Record<string, unknown> },
  recipient: string
): boolean {
  const principal = worker.capabilities.principal;
  const principalId = typeof principal === 'string' ? principal.trim().toLowerCase() : '';
  const workerId = worker.worker_id.trim().toLowerCase();
  return principalId === recipient || workerId === recipient;
}

function workerHeartbeatIsFresh(
  lastHeartbeatAt: string,
  nowMs: number,
  staleAfterMs: number
): boolean {
  const heartbeatMs = Date.parse(lastHeartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return false;
  return nowMs - heartbeatMs <= staleAfterMs;
}

async function listOrphanedRecipients(
  nowMs: number,
  staleAfterMs: number
): Promise<PrReviewOrphanedRecipient[]> {
  const result = await getDatabase().query<QueuedRecipientAgeRow>(
    `SELECT recipient, COUNT(*) AS count, MIN(created_at) AS oldest_created_at
     FROM agent_dispatch_messages
     WHERE status = 'queued'
     GROUP BY recipient`
  );
  const workers = await getDatabase().query<DispatchWorkerOrphanRow>(
    'SELECT worker_id, status, last_heartbeat_at, capabilities FROM agent_dispatch_workers'
  );
  const liveWorkers = workers.rows.filter(worker => {
    if (worker.status !== 'available') return false;
    return workerHeartbeatIsFresh(worker.last_heartbeat_at, nowMs, staleAfterMs);
  });
  const orphaned: PrReviewOrphanedRecipient[] = [];
  for (const row of result.rows) {
    const oldestMs = Date.parse(row.oldest_created_at);
    if (!Number.isFinite(oldestMs) || nowMs - oldestMs < ORPHAN_QUEUED_AFTER_MS) continue;
    const recipient = row.recipient.trim().toLowerCase();
    const hasLiveWorker = liveWorkers.some(worker =>
      workerCoversRecipient(
        { worker_id: worker.worker_id, capabilities: parseWorkerCapabilities(worker.capabilities) },
        recipient
      )
    );
    if (hasLiveWorker) continue;
    orphaned.push({
      recipient: row.recipient,
      count: Number(row.count),
      oldest_age_seconds: ageSecondsSince(row.oldest_created_at, nowMs),
    });
  }
  return orphaned;
}

export async function listPrReviewQueue(input: {
  status?: PrReviewQueueStatus;
  now?: number;
  staleAfterMs?: number;
}): Promise<PrReviewQueueResult> {
  const nowMs = input.now ?? injectedNow?.() ?? Date.now();
  const staleAfterMs =
    input.staleAfterMs ?? injectedStaleAfterMs ?? dispatch.DEFAULT_WORKER_STALE_AFTER_MS;
  const statuses: PrReviewQueueStatus[] = input.status ? [input.status] : [...QUEUE_STATUSES];
  const items: PrReviewQueueItem[] = [];
  for (const status of statuses) {
    const messages = await listReviewWorkPages(status);
    for (const message of messages) {
      items.push(toQueueItem(message, nowMs));
    }
  }
  return {
    items,
    orphaned: await listOrphanedRecipients(nowMs, staleAfterMs),
  };
}
