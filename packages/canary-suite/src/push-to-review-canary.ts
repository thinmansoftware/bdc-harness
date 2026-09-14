import {
  failResult,
  openOutcomeDatabase,
  passResult,
  type OutcomeCanaryDeps,
  type OutcomeCanaryResult,
} from './outcome-canary';

export const PUSH_TO_REVIEW_WINDOW_MS = 120_000;
export const PUSH_TO_REVIEW_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface PushToReviewCanaryDeps extends OutcomeCanaryDeps {
  readonly owner?: string;
  readonly repo?: string;
  readonly prNumber?: number;
  readonly pushToReviewWindowMs?: number;
  /** Unscoped mode: only ingest receipts newer than now - lookback are evaluated. */
  readonly ingestLookbackMs?: number;
}

interface MessageRow {
  readonly id: string;
  readonly correlation_id: string;
  readonly body: string;
  readonly created_at: string;
  readonly status: string;
}

interface StatusBody {
  readonly why_no_review?: unknown;
}

interface IngestReceipt {
  readonly disposition: string;
  readonly reason: string | null;
  readonly headSha: string | null;
}

function parseIngest(body: string): IngestReceipt | null {
  try {
    const value = JSON.parse(body) as {
      kind?: unknown;
      disposition?: unknown;
      reason?: unknown;
      headSha?: unknown;
    };
    if (value.kind !== 'pr_review_ingest_receipt' || typeof value.disposition !== 'string')
      return null;
    return {
      disposition: value.disposition,
      reason: typeof value.reason === 'string' ? value.reason : null,
      headSha: typeof value.headSha === 'string' && value.headSha !== '' ? value.headSha : null,
    };
  } catch {
    return null;
  }
}

function parseWorkHead(body: string): string | null {
  try {
    const value = JSON.parse(body) as { headSha?: unknown };
    return typeof value.headSha === 'string' && value.headSha !== '' ? value.headSha : null;
  } catch {
    return null;
  }
}

function headFromCorrelation(correlationId: string): string | null {
  const match = /@([0-9a-fA-F]{40})$/.exec(correlationId);
  return match?.[1] ?? null;
}

interface PrReviewRef {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}

function parseCorrelationRef(correlationId: string): PrReviewRef | null {
  const match = /^pr-review:([^/]+)\/([^#]+)#(\d+)@([0-9a-fA-F]{40})$/.exec(correlationId);
  const owner = match?.[1];
  const repo = match?.[2];
  const prRaw = match?.[3];
  if (!owner || !repo || !prRaw) return null;
  return { owner, repo, prNumber: Number(prRaw) };
}

function parseBodyPrRef(body: string): Partial<PrReviewRef> {
  try {
    const value = JSON.parse(body) as {
      owner?: unknown;
      repo?: unknown;
      prNumber?: unknown;
    };
    return {
      owner: typeof value.owner === 'string' && value.owner !== '' ? value.owner : undefined,
      repo: typeof value.repo === 'string' && value.repo !== '' ? value.repo : undefined,
      prNumber:
        typeof value.prNumber === 'number' && Number.isInteger(value.prNumber) && value.prNumber > 0
          ? value.prNumber
          : undefined,
    };
  } catch {
    return {};
  }
}

function resolvePrReviewRef(row: MessageRow): PrReviewRef | null {
  const fromCorr = parseCorrelationRef(row.correlation_id);
  const fromBody = parseBodyPrRef(row.body);
  const owner = fromCorr?.owner ?? fromBody.owner;
  const repo = fromCorr?.repo ?? fromBody.repo;
  const prNumber = fromCorr?.prNumber ?? fromBody.prNumber;
  if (!owner || !repo || prNumber === undefined) return null;
  return { owner, repo, prNumber };
}

function samePr(left: PrReviewRef, right: PrReviewRef): boolean {
  return left.owner === right.owner && left.repo === right.repo && left.prNumber === right.prNumber;
}

function prLabel(ref: PrReviewRef): string {
  return `${ref.owner}/${ref.repo}#${ref.prNumber}`;
}

function namedCorrelationPrefix(deps: PushToReviewCanaryDeps): string | null {
  if (!deps.owner || !deps.repo || deps.prNumber === undefined) return null;
  return `pr-review:${deps.owner}/${deps.repo}#${deps.prNumber}@`;
}

function whyNoReview(input: {
  pendingId: string | null;
  blockedReason: string | null;
  currentHead: string | null;
}): string {
  if (input.pendingId) return `review queued, id ${input.pendingId}`;
  if (input.blockedReason) return `blocked: ${input.blockedReason}`;
  if (input.currentHead) return `no pull_request event received since ${input.currentHead}`;
  return 'no pull_request event received';
}

async function fetchWhyNoReview(
  deps: PushToReviewCanaryDeps,
  ref: PrReviewRef | null
): Promise<string | null> {
  const owner = ref?.owner ?? deps.owner;
  const repo = ref?.repo ?? deps.repo;
  const prNumber = ref?.prNumber ?? deps.prNumber;
  if (!deps.statusUrl || !deps.operatorToken || !owner || !repo || prNumber === undefined) {
    return null;
  }
  const url = new URL(deps.statusUrl);
  url.searchParams.set('owner', owner);
  url.searchParams.set('repo', repo);
  url.searchParams.set('prNumber', String(prNumber));
  try {
    const response = await (deps.fetcher ?? fetch)(url, {
      headers: { 'x-archon-operator-token': deps.operatorToken },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return `status_http=${response.status}`;
    const body = (await response.json()) as StatusBody;
    return typeof body.why_no_review === 'string' ? body.why_no_review : null;
  } catch (error) {
    return `status_error=${(error as Error).message}`;
  }
}

/**
 * The round-3 rule for ONE ingest receipt: the matching run_review row must carry the
 * same owner/repo/PR and head, and must have been created at or after the receipt.
 * `unscopedPr` labels the failure when several PRs are evaluated in one pass.
 */
async function evaluateReceipt(
  deps: PushToReviewCanaryDeps,
  newestRow: MessageRow,
  ingest: IngestReceipt,
  reviews: readonly MessageRow[],
  unscopedPr: string | null
): Promise<OutcomeCanaryResult> {
  if (
    ingest.disposition === 'ignored_event' ||
    ingest.disposition === 'ignored_draft' ||
    ingest.disposition === 'rejected_signature'
  ) {
    return passResult([`disposition=${ingest.disposition}`]);
  }
  const headSha = ingest.headSha ?? headFromCorrelation(newestRow.correlation_id);
  const ingestAt = Date.parse(newestRow.created_at);
  const ingestRef = resolvePrReviewRef(newestRow);
  const match = reviews.find(row => {
    const reviewRef = resolvePrReviewRef(row);
    const workHead = parseWorkHead(row.body) ?? headFromCorrelation(row.correlation_id);
    const queuedAt = Date.parse(row.created_at);
    return (
      ingestRef !== null &&
      reviewRef !== null &&
      samePr(ingestRef, reviewRef) &&
      headSha !== null &&
      workHead === headSha &&
      Number.isFinite(queuedAt) &&
      Number.isFinite(ingestAt) &&
      queuedAt >= ingestAt
    );
  });
  const windowMs = deps.pushToReviewWindowMs ?? PUSH_TO_REVIEW_WINDOW_MS;
  const nowMs = (deps.now ?? Date.now)();
  const pending = reviews.find(row => {
    const reviewRef = resolvePrReviewRef(row);
    return (
      ingestRef !== null &&
      reviewRef !== null &&
      samePr(ingestRef, reviewRef) &&
      (row.status === 'queued' || row.status === 'claimed')
    );
  });
  const blockedReason = ingest.disposition === 'blocked' ? (ingest.reason ?? 'blocked') : null;
  const localWhy = whyNoReview({
    pendingId: pending?.id ?? null,
    blockedReason,
    currentHead: headSha,
  });
  const failCode = (why: string): string =>
    unscopedPr ? `c4_review_not_queued:${unscopedPr}:${why}` : `c4_review_not_queued:${why}`;
  if (!match) {
    const why = (await fetchWhyNoReview(deps, ingestRef)) ?? localWhy;
    return failResult(failCode(why), [
      `ingest_id=${newestRow.id}`,
      `head_sha=${headSha ?? 'null'}`,
      `why_no_review=${why}`,
    ]);
  }
  const queuedAt = Date.parse(match.created_at);
  const delayMs =
    Number.isFinite(ingestAt) && Number.isFinite(queuedAt) ? queuedAt - ingestAt : nowMs - ingestAt;
  if (delayMs < 0) {
    const why = (await fetchWhyNoReview(deps, ingestRef)) ?? localWhy;
    return failResult(failCode(why), [
      `ingest_id=${newestRow.id}`,
      `head_sha=${headSha ?? 'null'}`,
      `why_no_review=${why}`,
    ]);
  }
  if (delayMs > windowMs) {
    const why = (await fetchWhyNoReview(deps, ingestRef)) ?? localWhy;
    return failResult(failCode(why), [
      `ingest_id=${newestRow.id}`,
      `run_review_id=${match.id}`,
      `delay_ms=${delayMs}`,
      `window_ms=${windowMs}`,
    ]);
  }
  return passResult([
    `ingest_id=${newestRow.id}`,
    `run_review_id=${match.id}`,
    `delay_ms=${delayMs}`,
  ]);
}

export async function runPushToReviewCanary(
  deps: PushToReviewCanaryDeps
): Promise<OutcomeCanaryResult> {
  let opened: ReturnType<typeof openOutcomeDatabase>;
  try {
    opened = openOutcomeDatabase(deps, 'c4_db_path_required');
  } catch (error) {
    return failResult('c4_review_not_queued:db_unreachable', [`error=${(error as Error).message}`]);
  }
  try {
    const nowMs = (deps.now ?? Date.now)();
    const receipts = opened.db
      .query<MessageRow>(
        `SELECT id, correlation_id, body, created_at, status
         FROM agent_dispatch_messages
         WHERE task_type = 'run_report' AND recipient = 'operator'
         ORDER BY created_at DESC`
      )
      .all();
    const reviews = opened.db
      .query<MessageRow>(
        `SELECT id, correlation_id, body, created_at, status
         FROM agent_dispatch_messages
         WHERE task_type = 'run_review'
         ORDER BY created_at DESC`
      )
      .all();
    // Named PR: only that PR's receipts can decide the result.
    const prefix = namedCorrelationPrefix(deps);
    if (prefix) {
      const newest = receipts
        .filter(row => row.correlation_id.startsWith(prefix))
        .map(row => ({ row, ingest: parseIngest(row.body) }))
        .find(item => item.ingest !== null);
      if (!newest?.ingest) return passResult(['ingest_receipts=0']);
      return await evaluateReceipt(deps, newest.row, newest.ingest, reviews, null);
    }
    // Unscoped: every PR with a receipt inside the lookback, newest receipt per PR.
    const lookbackMs = deps.ingestLookbackMs ?? PUSH_TO_REVIEW_LOOKBACK_MS;
    const cutoff = nowMs - lookbackMs;
    const newestByPr = new Map<
      string,
      { row: MessageRow; ingest: IngestReceipt; ref: PrReviewRef }
    >();
    for (const row of receipts) {
      const ingest = parseIngest(row.body);
      if (!ingest) continue;
      const created = Date.parse(row.created_at);
      if (!Number.isFinite(created) || created < cutoff) continue;
      const ref = resolvePrReviewRef(row);
      if (!ref) continue;
      const key = prLabel(ref);
      if (newestByPr.has(key)) continue;
      newestByPr.set(key, { row, ingest, ref });
    }
    if (newestByPr.size === 0) return passResult(['ingest_receipts=0']);
    for (const item of newestByPr.values()) {
      const result = await evaluateReceipt(deps, item.row, item.ingest, reviews, prLabel(item.ref));
      if (result.verdict === 'failed') return result;
    }
    return passResult([`prs_evaluated=${newestByPr.size}`]);
  } finally {
    opened.close();
  }
}
