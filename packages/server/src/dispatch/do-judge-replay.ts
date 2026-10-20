import type { DispatchMessage } from '@archon/core/db/dispatch';

export type ReplayAction = 'escalate_xo' | 'nudge' | 'hold' | 'failed';

export interface ReplayRecord {
  id: string;
  input: DispatchMessage;
  recordedAction: ReplayAction;
}

export interface ReplayRow {
  id: string;
  oldVerdict: ReplayAction;
  newVerdict: ReplayAction;
  agree: boolean;
}

export interface ReplayReport {
  total: number;
  agreementCount: number;
  rows: ReplayRow[];
}

/** How many real judged inputs the production replay compares. */
export const DO_JUDGE_REPLAY_STORE_LIMIT = 50;

/**
 * Newest done duty-officer rows to scan before keeping the limit above.
 * Mechanical finishes (null transport) sit in the same table and must not
 * crowd out the last 50 model verdicts.
 */
export const DO_JUDGE_REPLAY_STORE_SCAN = 500;

export const DUTY_OFFICER_JUDGE_REPLAY_SQL = `SELECT * FROM agent_dispatch_messages
WHERE recipient IN ('duty-officer', 'do')
  AND status = 'done'
  AND result_body IS NOT NULL
  AND completed_at IS NOT NULL
ORDER BY completed_at DESC
LIMIT $1`;

const REPLAY_ACTIONS = new Set<ReplayAction>(['escalate_xo', 'nudge', 'hold', 'failed']);

function invalid(detail: string): Error {
  return new Error(`do_judge_replay_fixture_invalid: ${detail}`);
}

function isReplayAction(value: unknown): value is ReplayAction {
  return typeof value === 'string' && REPLAY_ACTIONS.has(value as ReplayAction);
}

export function parseReplayFixture(value: unknown): ReplayRecord[] {
  if (!Array.isArray(value)) {
    throw invalid('expected a JSON array of records');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalid(`record ${index} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.trim() === '') {
      throw invalid(`record ${index} is missing id`);
    }
    if (!isReplayAction(record.recordedAction)) {
      throw invalid(`record ${record.id} recordedAction is invalid`);
    }
    if (!record.input || typeof record.input !== 'object' || Array.isArray(record.input)) {
      throw invalid(`record ${record.id} is missing input`);
    }
    return {
      id: record.id,
      input: record.input as DispatchMessage,
      recordedAction: record.recordedAction,
    };
  });
}

/**
 * Recorded paid-model action stored by the Duty Officer clock.
 * escalated_to_xo and cued are the only dispositions that preserve the
 * judge action, and only when transport is an OpenRouter or xAI rung.
 * Hold is a release, not a stored result, so it is never invented here.
 * A null transport is a mechanical finish and is not a grok verdict.
 */
export function recordedModelAction(resultBody: string | null): ReplayAction | null {
  if (!resultBody) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultBody) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as { disposition?: unknown; transport?: unknown };
  const transport = record.transport;
  if (typeof transport !== 'string') return null;
  if (!transport.startsWith('openrouter:') && !transport.startsWith('xai:')) return null;
  if (record.disposition === 'escalated_to_xo') return 'escalate_xo';
  if (record.disposition === 'cued') return 'nudge';
  return null;
}

/**
 * `messages` must be newest-first. Returns at most `limit` records whose
 * stored result is a paid-model escalate_xo or nudge.
 */
export function selectStoredJudgeReplayRecords(
  messages: readonly DispatchMessage[],
  limit = DO_JUDGE_REPLAY_STORE_LIMIT
): ReplayRecord[] {
  const records: ReplayRecord[] = [];
  const cap = Math.max(0, limit);
  for (const message of messages) {
    if (message.recipient !== 'duty-officer' && message.recipient !== 'do') continue;
    if (message.status !== 'done') continue;
    const recordedAction = recordedModelAction(message.result_body);
    if (!recordedAction) continue;
    records.push({
      id: message.id,
      input: message,
      recordedAction,
    });
    if (records.length >= cap) break;
  }
  return records;
}

export async function loadRecentDutyOfficerJudgeRecords(
  query: (sql: string, params: readonly unknown[]) => Promise<{ rows: DispatchMessage[] }>,
  limit = DO_JUDGE_REPLAY_STORE_LIMIT
): Promise<ReplayRecord[]> {
  const result = await query(DUTY_OFFICER_JUDGE_REPLAY_SQL, [DO_JUDGE_REPLAY_STORE_SCAN]);
  return selectStoredJudgeReplayRecords(result.rows, limit);
}

export async function runDoJudgeReplay(input: {
  records: ReplayRecord[];
  classify: (message: DispatchMessage) => ReplayAction | Promise<ReplayAction>;
}): Promise<ReplayReport> {
  const rows: ReplayRow[] = [];
  for (const record of input.records) {
    const newVerdict = await input.classify(record.input);
    if (!isReplayAction(newVerdict)) {
      throw new Error(`do_judge_replay_classifier_invalid: ${record.id}`);
    }
    rows.push({
      id: record.id,
      oldVerdict: record.recordedAction,
      newVerdict,
      agree: record.recordedAction === newVerdict,
    });
  }
  return {
    total: rows.length,
    agreementCount: rows.filter(row => row.agree).length,
    rows,
  };
}
