/**
 * Taskmaster receipt guard (WO-HARNESS-TASKMASTER-RECEIPT-NUDGE-GUARD-01).
 *
 * The latest non-automated comment decides. hasReceiptMarker on that comment
 * suppresses nudge and escalate_p0 only. A valid owner label suppresses only
 * unclaimed-P0 escalation. Failed or budget-capped reads fail open.
 */
import { createLogger } from '@archon/paths';
import { serviceGitHubFetchWithPermissionFallback } from '@archon/core/github/request';
import { TASKMASTER_ESCALATION_MARKER } from './escalation-delivery';
import { DUTY_OFFICER_NUDGE_MARKER } from '../dispatch/duty-officer-clock';

const log = createLogger('taskmaster/receipt-guard');

/** Copied from duty-officer-security-detector.ts COMMENT_MARKER. Not the issue marker. */
const SECURITY_DETECTOR_COMMENT_MARKER = '<!-- security-detector -->';
/** Copied from worker-heartbeat-alarm.ts down/up marker prefix. */
const DISPATCH_WORKER_ALARM_PREFIX = '<!-- dispatch-worker-alarm:';

export const RECEIPT_COMMENT_PAGE_SIZE = 100;
export const RECEIPT_COMMENT_PAGE_CAP = 5;
export const RECEIPT_COMMENT_REQUEST_BUDGET = 10;

export interface ReceiptComment {
  body: string;
  created_at: string;
}

export type ReceiptCheckOutcome =
  | { failOpen: false; comments: ReceiptComment[] }
  | { failOpen: true; reason: 'budget' | 'page_cap' };

export interface ReceiptCheckState {
  requestsUsed: number;
  cache: Map<string, ReceiptCheckOutcome>;
}

export function createReceiptCheckState(): ReceiptCheckState {
  return { requestsUsed: 0, cache: new Map() };
}

function firstNonBlankLine(body: string): string | null {
  for (const line of body.split('\n')) {
    if (line.trim().length > 0) return line;
  }
  return null;
}

/**
 * True when the body carries an in-repo automated marker, or its first
 * non-blank line is a user-level Duty Officer nudge. Author identity is not
 * consulted: every seat posts as the same GitHub account.
 */
export function isAutomatedComment(body: string | null | undefined): boolean {
  if (body === null || body === undefined || body.length === 0) return false;
  if (
    body.includes(TASKMASTER_ESCALATION_MARKER) ||
    body.includes(DUTY_OFFICER_NUDGE_MARKER) ||
    body.includes(SECURITY_DETECTOR_COMMENT_MARKER) ||
    body.includes(DISPATCH_WORKER_ALARM_PREFIX)
  ) {
    return true;
  }
  const first = firstNonBlankLine(body);
  return first?.startsWith('[DO nudge') ?? false;
}

/**
 * True only when the first non-blank, unfenced, non-blockquote line, after
 * stripping leading markdown heading hashes, emphasis, and brackets, starts
 * with EXECUTED or RECEIPT. Quoted, fenced, or later-paragraph text does not
 * count. hasReceiptMarker never looks past that first candidate line.
 */
export function hasReceiptMarker(body: string | null | undefined): boolean {
  if (body === null || body === undefined || body.length === 0) return false;
  let fenced = false;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (trimmed.length === 0) continue;
    if (/^[ \t]*>/.test(line)) return false;
    const stripped = line.replace(/^[ \t#*_[\]]+/, '');
    return /^(?:EXECUTED|RECEIPT)(?:$|[^A-Za-z0-9])/i.test(stripped);
  }
  return false;
}

/** Newest comment that is not automated, or null when every comment is automated. */
export function latestSubstantiveComment(
  comments: readonly ReceiptComment[]
): ReceiptComment | null {
  let latest: ReceiptComment | null = null;
  for (const comment of comments) {
    if (isAutomatedComment(comment.body)) continue;
    if (latest === null || comment.created_at >= latest.created_at) latest = comment;
  }
  return latest;
}

function mapCommentRows(rows: unknown[]): ReceiptComment[] {
  const comments: ReceiptComment[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const createdAt = (row as { created_at?: unknown }).created_at;
    if (typeof createdAt !== 'string') continue;
    const body = (row as { body?: unknown }).body;
    comments.push({ body: typeof body === 'string' ? body : '', created_at: createdAt });
  }
  return comments;
}

function budgetExhausted(threadRef: string, reason: 'budget' | 'page_cap'): ReceiptCheckOutcome {
  log.warn({ threadRef, reason }, 'taskmaster.receipt_check_budget_exhausted');
  return { failOpen: true, reason };
}

/**
 * Read issue comments oldest-first, up to 5 pages of 100, sharing one tick
 * budget. A short page is complete. A full fifth page, or a spent request
 * budget, fails open. Invalid refs throw before a request is counted.
 */
export async function readLatestSubstantiveComment(
  threadRef: string,
  updatedAt: string,
  budget: ReceiptCheckState,
  fetchImpl: typeof fetch = fetch
): Promise<ReceiptCheckOutcome> {
  const cacheKey = `${threadRef}\n${updatedAt}`;
  const cached = budget.cache.get(cacheKey);
  if (cached) return cached;

  const match = /^gh:([^#]+)#(\d+)$/.exec(threadRef);
  if (!match) {
    throw new Error(`taskmaster_receipt_ref_invalid:${threadRef}`);
  }
  const repo = match[1];
  const issueNumber = match[2];
  const comments: ReceiptComment[] = [];

  for (let page = 1; page <= RECEIPT_COMMENT_PAGE_CAP; page += 1) {
    if (budget.requestsUsed >= RECEIPT_COMMENT_REQUEST_BUDGET) {
      const outcome = budgetExhausted(threadRef, 'budget');
      budget.cache.set(cacheKey, outcome);
      return outcome;
    }
    budget.requestsUsed += 1;
    const response = await serviceGitHubFetchWithPermissionFallback({
      service: 'taskmaster',
      fetch: fetchImpl,
      url: `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=${RECEIPT_COMMENT_PAGE_SIZE}&page=${page}`,
    });
    if (!response.ok) {
      throw new Error(`taskmaster_receipt_comment_read_failed:${response.status}`);
    }
    const json: unknown = await response.json();
    if (!Array.isArray(json)) {
      throw new Error('taskmaster_receipt_comment_read_failed:not_array');
    }
    comments.push(...mapCommentRows(json));
    if (json.length < RECEIPT_COMMENT_PAGE_SIZE) {
      const outcome: ReceiptCheckOutcome = { failOpen: false, comments };
      budget.cache.set(cacheKey, outcome);
      return outcome;
    }
    if (page === RECEIPT_COMMENT_PAGE_CAP) {
      const outcome = budgetExhausted(threadRef, 'page_cap');
      budget.cache.set(cacheKey, outcome);
      return outcome;
    }
  }

  const outcome = budgetExhausted(threadRef, 'page_cap');
  budget.cache.set(cacheKey, outcome);
  return outcome;
}
