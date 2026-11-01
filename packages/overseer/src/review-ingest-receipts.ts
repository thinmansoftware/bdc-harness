/**
 * Read-only lookups over existing PR-review ingest receipts.
 *
 * Receipts already live on the pr-review-log recipient (see
 * docs/dispatch-receipts.md). These helpers do not add tables, columns, or
 * core database functions. Owner and repository casing is preserved: the
 * correlation id is the one ingest wrote, not a lowercased policy key.
 *
 * The delivery GUID is the x-github-delivery value. It is not GitHub's
 * numeric App webhook delivery id.
 */
import { getDatabase } from '@archon/core/db/connection';
import {
  listMessages,
  listMessagesByCorrelationPrefixWithoutSubjectKey,
} from '@archon/core/db/dispatch';
import { PR_REVIEW_LOG_RECIPIENT } from '@archon/core/db/dispatch-routing';
import { reviewCorrelationId } from './pr-review-ingest';
import { reviewSubjectKey } from './pr-review-wiring';

const RECEIPT_KEY_PREFIX = 'pr-review-receipt:';

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

function parseBody(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * True when pr-review-log has an ingest receipt whose body names this head.
 */
export async function hasIngestReceiptForHead(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string
): Promise<boolean> {
  const messages = await listMessagesByCorrelationPrefixWithoutSubjectKey({
    recipient: PR_REVIEW_LOG_RECIPIENT,
    correlationPrefix: reviewCorrelationId({ owner, repo, prNumber, headSha }),
    limit: 50,
  });
  for (const message of messages) {
    const body = parseBody(message.body);
    if (body?.kind === 'pr_review_ingest_receipt' && body.headSha === headSha) return true;
  }
  return false;
}

/**
 * True when any ingest receipt was recorded for this x-github-delivery GUID.
 * One database read. LIKE metacharacters in the GUID are escaped.
 */
export async function hasIngestReceiptForDelivery(guid: string): Promise<boolean> {
  const pattern = `${RECEIPT_KEY_PREFIX}${escapeLikeLiteral(guid)}:%`;
  const result = await getDatabase().query<{ present: number }>(
    `SELECT 1 AS present FROM agent_dispatch_messages
     WHERE idempotency_key LIKE $1 ESCAPE '\\'
     LIMIT 1`,
    [pattern]
  );
  return result.rows.length > 0;
}

/**
 * created_at of the newest ingest receipt, or null when none exists or the
 * stamp cannot be parsed. Ordering is seq, the insertion counter.
 */
export async function latestIngestReceiptAt(): Promise<Date | null> {
  const result = await getDatabase().query<{ created_at: string | null }>(
    `SELECT created_at FROM agent_dispatch_messages
     WHERE idempotency_key LIKE $1 ESCAPE '\\'
     ORDER BY seq DESC
     LIMIT 1`,
    [`${RECEIPT_KEY_PREFIX}%`]
  );
  const raw = result.rows[0]?.created_at;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed);
}

function loginFromReviewBody(body: Record<string, unknown>): string {
  const direct = body.login;
  if (typeof direct === 'string') return direct;
  const user = body.user;
  if (!user || typeof user !== 'object' || Array.isArray(user)) return '';
  const login = (user as { login?: unknown }).login;
  return typeof login === 'string' ? login : '';
}

/**
 * Dispositions written only after GitHub accepts the review. Deferrals and
 * failed submissions also store a `pr_review_submit_receipt`, and those must
 * not count: the gap sweeper would otherwise skip the head forever.
 */
const LANDED_REVIEW_DISPOSITIONS: ReadonlySet<string> = new Set(['approved', 'changes_requested']);

/**
 * True when this submit receipt records a review GitHub accepted.
 * `blocked_required_contexts_unavailable` is stored either way; only the
 * success reason means the COMMENT review landed.
 */
function submitReceiptLandedReview(body: Record<string, unknown>): boolean {
  if (body.kind !== 'pr_review_submit_receipt') return false;
  const disposition = body.disposition;
  if (typeof disposition !== 'string') return false;
  if (LANDED_REVIEW_DISPOSITIONS.has(disposition)) return true;
  if (disposition === 'blocked_required_contexts_unavailable') {
    return body.reason === 'required_contexts_unavailable_blocked';
  }
  return false;
}

/**
 * True when pr-review-log already has a submitted Overseer review or a stored
 * GitHub review for this exact head from the reviewer identity.
 *
 * A submit receipt counts only when GitHub accepted a review. `checks_pending`,
 * `transport_error`, `rate_limited`, and failed submissions did not land one.
 */
export async function hasOverseerReviewForHead(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  reviewerIdentity: string
): Promise<boolean> {
  const identity = reviewerIdentity.trim().toLowerCase();
  if (!identity) return false;
  const messages = await listMessages({
    recipient: PR_REVIEW_LOG_RECIPIENT,
    subject_key: reviewSubjectKey(owner, repo, prNumber),
    limit: 200,
  });
  for (const message of messages) {
    const body = parseBody(message.body);
    if (!body) continue;
    if (submitReceiptLandedReview(body) && body.headSha === headSha) return true;
    const login = loginFromReviewBody(body);
    if (body.commit_id === headSha && login.toLowerCase() === identity) return true;
  }
  return false;
}
