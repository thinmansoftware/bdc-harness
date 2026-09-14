import {
  countConsecutiveAutoRereviews,
  isAutoRereviewReason,
  resolveMaxRereviewAttempts,
  type PriorReviewWork,
} from '@archon/overseer/pr-review-ingest';
import {
  failResult,
  openOutcomeDatabase,
  passResult,
  type OutcomeCanaryDatabase,
  type OutcomeCanaryDeps,
  type OutcomeCanaryResult,
} from './outcome-canary';

export const CONVERGING_PR_LIVE_LIMIT = 50;

export interface ConvergingPrSubject {
  readonly id: string;
  readonly prior: readonly PriorReviewWork[];
  readonly currentHead: string;
  readonly currentHeadCiGreen?: boolean;
  readonly exhaustedReceipt?: boolean;
}

export interface ConvergingPrCanaryDeps extends OutcomeCanaryDeps {
  readonly env?: Record<string, string | undefined>;
  readonly subjects?: readonly ConvergingPrSubject[];
}

interface ReviewMessageRow {
  readonly id: string;
  readonly subject_key: string | null;
  readonly status: string;
  readonly repeat_reason: string | null;
  readonly body: string;
  readonly created_at: string;
}

interface ReceiptRow {
  readonly id: string;
  readonly subject_key: string | null;
  readonly body: string;
  readonly created_at: string;
}

interface ExhaustedReceipt {
  readonly headSha: string | null;
  readonly createdAt: string;
}

/**
 * An `rereview_attempts_exhausted` ingest receipt is evidence about ONE head at ONE
 * moment. It only counts against the subject when it names the current head and no
 * non-automatic review (a hand nudge, an operator request, the initial review) has
 * been queued since it was written -- such a review re-arms the consecutive budget
 * (countConsecutiveAutoRereviews), so the receipt is stale history after it.
 * Review finding, PR #840 round 6.
 */
export function isExhaustedForCurrentHead(
  receipts: readonly ExhaustedReceipt[],
  currentHead: string,
  rows: readonly { readonly created_at: string; readonly repeat_reason: string | null }[]
): boolean {
  return receipts.some(receipt => {
    if (receipt.headSha !== currentHead) return false;
    const rearmedLater = rows.some(
      row => row.created_at > receipt.createdAt && !isAutoRereviewReason(row.repeat_reason)
    );
    return !rearmedLater;
  });
}

function isJudged(verdict: PriorReviewWork['verdict']): boolean {
  return verdict === 'approved' || verdict === 'changes_requested';
}

export function isConvergingPr(prior: readonly PriorReviewWork[]): boolean {
  const autos = prior.filter(work => work.isAutoRereview && isJudged(work.verdict));
  if (autos.length === 0) return false;
  const heads = new Set(autos.map(work => work.headSha));
  if (heads.size !== autos.length) return false;
  return autos.every(work => work.headCiGreen);
}

function classifyVerdict(disposition: string | undefined): PriorReviewWork['verdict'] {
  if (disposition === 'approved') return 'approved';
  if (disposition === 'changes_requested') return 'changes_requested';
  return 'other';
}

function parseWorkBody(body: string): { headSha: string; headCiGreen: boolean } | null {
  try {
    const value = JSON.parse(body) as { headSha?: unknown; headCiGreen?: unknown };
    if (typeof value.headSha !== 'string' || value.headSha === '') return null;
    return { headSha: value.headSha, headCiGreen: value.headCiGreen === true };
  } catch {
    return null;
  }
}

function loadSubjectsFromDb(db: OutcomeCanaryDatabase): ConvergingPrSubject[] {
  const messages = db
    .query<ReviewMessageRow>(
      `SELECT id, subject_key, status, repeat_reason, body, created_at
       FROM agent_dispatch_messages
       WHERE task_type = 'run_review'
       ORDER BY created_at DESC`
    )
    .all();
  const receipts = db
    .query<ReceiptRow>(
      `SELECT id, subject_key, body, created_at
       FROM agent_dispatch_messages
       WHERE task_type = 'run_report' AND recipient = 'operator'`
    )
    .all();
  const verdictByMessageId = new Map<
    string,
    { verdict: PriorReviewWork['verdict']; verdictId: string }
  >();
  const exhaustedBySubject = new Map<string, ExhaustedReceipt[]>();
  for (const receipt of receipts) {
    try {
      const body = JSON.parse(receipt.body) as {
        kind?: string;
        messageId?: string;
        disposition?: string;
        reason?: string | null;
        headSha?: unknown;
      };
      if (
        body.kind === 'pr_review_submit_receipt' &&
        body.messageId &&
        !verdictByMessageId.has(body.messageId)
      ) {
        verdictByMessageId.set(body.messageId, {
          verdict: classifyVerdict(body.disposition),
          verdictId: receipt.id,
        });
      }
      if (
        body.kind === 'pr_review_ingest_receipt' &&
        typeof body.reason === 'string' &&
        body.reason.includes('rereview_attempts_exhausted') &&
        receipt.subject_key
      ) {
        const list = exhaustedBySubject.get(receipt.subject_key) ?? [];
        list.push({
          headSha: typeof body.headSha === 'string' ? body.headSha : null,
          createdAt: receipt.created_at,
        });
        exhaustedBySubject.set(receipt.subject_key, list);
      }
    } catch {
      // Unrelated operator reports are not verdict evidence.
    }
  }
  const grouped = new Map<string, ReviewMessageRow[]>();
  for (const message of messages) {
    const key = message.subject_key ?? message.id;
    const list = grouped.get(key) ?? [];
    list.push(message);
    grouped.set(key, list);
  }
  const newest = [...grouped.entries()]
    .map(([id, rows]) => ({ id, rows, newestAt: rows[0]?.created_at ?? '' }))
    .sort((left, right) => right.newestAt.localeCompare(left.newestAt))
    .slice(0, CONVERGING_PR_LIVE_LIMIT);
  return newest.map(group => {
    const prior: PriorReviewWork[] = group.rows
      .map(message => {
        const parsed = parseWorkBody(message.body);
        const verdict = verdictByMessageId.get(message.id);
        return {
          messageId: message.id,
          headSha: parsed?.headSha ?? '',
          status: message.status as PriorReviewWork['status'],
          verdict: verdict?.verdict ?? null,
          verdictId: verdict?.verdictId ?? null,
          isAutoRereview: isAutoRereviewReason(message.repeat_reason),
          headCiGreen: parsed?.headCiGreen === true,
        };
      })
      .filter(work => work.headSha !== '');
    const currentHead = prior[0]?.headSha ?? '';
    return {
      id: group.id,
      prior,
      currentHead,
      currentHeadCiGreen: prior[0]?.headCiGreen ?? false,
      exhaustedReceipt: isExhaustedForCurrentHead(
        exhaustedBySubject.get(group.id) ?? [],
        currentHead,
        group.rows
      ),
    };
  });
}

export async function runConvergingPrCanary(
  deps: ConvergingPrCanaryDeps
): Promise<OutcomeCanaryResult> {
  const env = deps.env ?? process.env;
  const maxAttempts = resolveMaxRereviewAttempts(env);
  let subjects = deps.subjects ? [...deps.subjects] : undefined;
  let opened: ReturnType<typeof openOutcomeDatabase> | undefined;
  try {
    if (!subjects) {
      try {
        opened = openOutcomeDatabase(deps, 'c1_db_path_required');
        subjects = loadSubjectsFromDb(opened.db);
      } catch (error) {
        return failResult('c1_budget_exhausted_on_converging_pr', [
          `error=${(error as Error).message}`,
        ]);
      }
    }
    const evidenceRefs: string[] = [`max_attempts=${maxAttempts}`, `subjects=${subjects.length}`];
    for (const subject of subjects) {
      if (!isConvergingPr(subject.prior)) continue;
      const currentHeadCiGreen = subject.currentHeadCiGreen ?? true;
      const consecutive = countConsecutiveAutoRereviews(
        [...subject.prior],
        subject.currentHead,
        currentHeadCiGreen
      );
      evidenceRefs.push(
        `subject=${subject.id}`,
        `consecutive=${consecutive}`,
        `exhausted_receipt=${subject.exhaustedReceipt === true}`
      );
      if (consecutive >= maxAttempts || subject.exhaustedReceipt === true) {
        return failResult('c1_budget_exhausted_on_converging_pr', [
          ...evidenceRefs,
          `subject=${subject.id}`,
        ]);
      }
    }
    return passResult(evidenceRefs);
  } finally {
    opened?.close();
  }
}
