import {
  failResult,
  openOutcomeDatabase,
  passResult,
  type OutcomeCanaryDeps,
  type OutcomeCanaryResult,
} from './outcome-canary';

export interface RepeatSendCanaryDeps extends OutcomeCanaryDeps {
  readonly subjectKey?: string;
  readonly enqueue?: () => Promise<void>;
  readonly requestUrl?: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly prNumber?: number;
  readonly headSha?: string;
  readonly reason?: string;
}

interface QueuedRow {
  readonly id: string;
  readonly repeat_reason: string | null;
}

function subjectKeyOf(deps: RepeatSendCanaryDeps): string | undefined {
  if (deps.subjectKey) return deps.subjectKey;
  if (!deps.owner || !deps.repo || deps.prNumber === undefined) return undefined;
  return `gh:${deps.owner.toLowerCase()}/${deps.repo.toLowerCase()}#${deps.prNumber}`;
}

async function liveEnqueue(deps: RepeatSendCanaryDeps): Promise<void> {
  if (!deps.requestUrl || !deps.operatorToken || !deps.owner || !deps.repo) return;
  if (deps.prNumber === undefined || !deps.headSha) return;
  const response = await (deps.fetcher ?? fetch)(deps.requestUrl, {
    method: 'POST',
    headers: {
      'x-archon-operator-token': deps.operatorToken,
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
}

export async function runRepeatSendCanary(
  deps: RepeatSendCanaryDeps
): Promise<OutcomeCanaryResult> {
  try {
    if (deps.enqueue) await deps.enqueue();
    else await liveEnqueue(deps);
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('repeat_reason_required')) {
      return failResult('c2_repeat_send_refused', [`error=${message}`]);
    }
    return failResult('c2_repeat_send_refused', [`error=${message}`]);
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
    const row = opened.db
      .query<QueuedRow>(
        `SELECT id, repeat_reason FROM agent_dispatch_messages
         WHERE subject_key = ? AND task_type = 'run_review' AND status = 'queued'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(subjectKey);
    const reason = row?.repeat_reason?.trim() ?? '';
    if (!row || reason === '') {
      return failResult('c2_repeat_send_refused', [
        `subject_key=${subjectKey}`,
        `queued=${row ? 'yes' : 'no'}`,
        `repeat_reason=${row?.repeat_reason ?? 'null'}`,
      ]);
    }
    return passResult([`message_id=${row.id}`, `repeat_reason=${reason}`]);
  } finally {
    opened.close();
  }
}
