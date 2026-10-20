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
