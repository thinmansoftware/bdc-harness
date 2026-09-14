import {
  blockedResult,
  failResult,
  openOutcomeDatabase,
  passResult,
  type OutcomeCanaryDeps,
  type OutcomeCanaryResult,
} from './outcome-canary';

export interface RepeatSendEnqueueOutcome {
  readonly messageId?: string;
}

export interface RepeatSendCanaryDeps extends OutcomeCanaryDeps {
  readonly subjectKey?: string;
  /**
   * Test injection: replaces the live POST entirely. May resolve to a
   * RepeatSendEnqueueOutcome carrying the queued message id; anything else is ignored.
   */
  readonly enqueue?: () => Promise<unknown>;
  /**
   * Explicit mutation opt-in (`--c2-live-enqueue`). Without it C2 never POSTs to the
   * operator request endpoint: it only observes an already-queued run_review row for
   * the subject (exact head when `headSha` is known) and is `blocked` when there is
   * none. Enqueuing is a production mutation (a real review, model usage), so it is
   * never implied by the presence of an API URL and token.
   */
  readonly c2LiveEnqueue?: boolean;
  readonly requestUrl?: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly prNumber?: number;
  readonly headSha?: string;
  readonly reason?: string;
}

interface QueuedRow {
  readonly id: string;
  readonly correlation_id: string;
  readonly repeat_reason: string | null;
}

function subjectKeyOf(deps: RepeatSendCanaryDeps): string | undefined {
  if (deps.subjectKey) return deps.subjectKey;
  if (!deps.owner || !deps.repo || deps.prNumber === undefined) return undefined;
  return `gh:${deps.owner.toLowerCase()}/${deps.repo.toLowerCase()}#${deps.prNumber}`;
}

function missingLivePrerequisites(deps: RepeatSendCanaryDeps): string[] {
  const missing: string[] = [];
  if (!deps.requestUrl) missing.push('requestUrl');
  if (!deps.operatorToken) missing.push('operatorToken');
  if (!deps.owner) missing.push('owner');
  if (!deps.repo) missing.push('repo');
  if (deps.prNumber === undefined) missing.push('prNumber');
  if (!deps.headSha) missing.push('headSha');
  return missing;
}

async function liveEnqueue(deps: RepeatSendCanaryDeps): Promise<RepeatSendEnqueueOutcome> {
  const response = await (deps.fetcher ?? fetch)(deps.requestUrl ?? '', {
    method: 'POST',
    headers: {
      'x-archon-operator-token': deps.operatorToken ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      owner: deps.owner,
      repo: deps.repo,
      prNumber: deps.prNumber,
      headSha: deps.headSha,
      reason: deps.reason ?? 'canary_repeat_send',
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`enqueue_failed:http_${response.status}`);
  }
  let parsed: { messageId?: unknown } = {};
  try {
    parsed = (await response.json()) as { messageId?: unknown };
  } catch {
    parsed = {};
  }
  return typeof parsed.messageId === 'string' ? { messageId: parsed.messageId } : {};
}

/**
 * After a real (or injected) enqueue the row must be the one the route returned and
 * must carry the requested exact head. In observe mode the newest queued row for the
 * subject AT THE REQUESTED HEAD is reported; a queued row for another head is stale
 * work, never evidence for this head (review finding, PR #840 round 10). Only when
 * no head is requested does the subject-level newest row count.
 */
function findQueuedRow(
  db: ReturnType<typeof openOutcomeDatabase>['db'],
  subjectKey: string,
  headSha: string | undefined,
  expectedMessageId: string | undefined
): QueuedRow | null {
  if (expectedMessageId) {
    return db
      .query<QueuedRow>(
        `SELECT id, correlation_id, repeat_reason FROM agent_dispatch_messages
         WHERE id = ? AND subject_key = ? AND task_type = 'run_review' AND status = 'queued'
         LIMIT 1`
      )
      .get(expectedMessageId, subjectKey);
  }
  if (headSha) {
    return db
      .query<QueuedRow>(
        `SELECT id, correlation_id, repeat_reason FROM agent_dispatch_messages
         WHERE subject_key = ? AND task_type = 'run_review' AND status = 'queued'
           AND correlation_id LIKE ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(subjectKey, `%@${headSha}`);
  }
  return db
    .query<QueuedRow>(
      `SELECT id, correlation_id, repeat_reason FROM agent_dispatch_messages
       WHERE subject_key = ? AND task_type = 'run_review' AND status = 'queued'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(subjectKey);
}

export async function runRepeatSendCanary(
  deps: RepeatSendCanaryDeps
): Promise<OutcomeCanaryResult> {
  const liveMode = !deps.enqueue && deps.c2LiveEnqueue === true;
  const observeOnly = !deps.enqueue && !liveMode;
  if (liveMode) {
    const missing = missingLivePrerequisites(deps);
    if (missing.length > 0) {
      return blockedResult('c2_live_enqueue_prerequisites_missing', [
        `missing=${missing.join(',')}`,
      ]);
    }
  }

  let expectedMessageId: string | undefined;
  try {
    if (deps.enqueue) {
      const outcome = await deps.enqueue();
      if (outcome && typeof outcome === 'object' && 'messageId' in outcome) {
        const id = (outcome as RepeatSendEnqueueOutcome).messageId;
        expectedMessageId = typeof id === 'string' ? id : undefined;
      }
    } else if (liveMode) {
      expectedMessageId = (await liveEnqueue(deps)).messageId;
    }
  } catch (error) {
    return failResult('c2_repeat_send_refused', [`error=${(error as Error).message}`]);
  }

  const subjectKey = subjectKeyOf(deps);
  if (!subjectKey) {
    return failResult('c2_repeat_send_refused', ['subject_key_required']);
  }

  let opened: ReturnType<typeof openOutcomeDatabase>;
  try {
    opened = openOutcomeDatabase(deps, 'c2_db_path_required');
  } catch (error) {
    return failResult('c2_repeat_send_refused', [`error=${(error as Error).message}`]);
  }
  try {
    const row = findQueuedRow(opened.db, subjectKey, deps.headSha, expectedMessageId);
    const rowHead = row?.correlation_id.split('@').pop() ?? 'none';
    const headMatches =
      row === null || !deps.headSha || row.correlation_id.endsWith(`@${deps.headSha}`);
    const reason = row?.repeat_reason?.trim() ?? '';
    const scope = [
      `subject_key=${subjectKey}`,
      `requested_head=${deps.headSha ?? 'any'}`,
      `row_head=${rowHead}`,
      `expected_message_id=${expectedMessageId ?? 'none'}`,
    ];
    if (!row && observeOnly) {
      return blockedResult('c2_live_enqueue_not_enabled', [
        'flag=--c2-live-enqueue',
        ...scope,
        'queued=no',
      ]);
    }
    if (!row || !headMatches) {
      return failResult('c2_repeat_send_refused', [
        ...scope,
        row ? 'enqueued_row_head_mismatch' : 'enqueued_row_missing',
        `queued=${row ? 'yes' : 'no'}`,
      ]);
    }
    if (reason === '') {
      return failResult('c2_repeat_send_refused', [
        ...scope,
        'queued=yes',
        `repeat_reason=${row.repeat_reason ?? 'null'}`,
      ]);
    }
    return passResult([
      `message_id=${row.id}`,
      `repeat_reason=${reason}`,
      `row_head=${rowHead}`,
      `mode=${observeOnly ? 'observe' : 'enqueue'}`,
    ]);
  } finally {
    opened.close();
  }
}
