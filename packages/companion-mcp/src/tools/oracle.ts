import { ORACLE_TIMEOUT_MS } from '../constants';
import { ToolFailure } from '../errors';
import { scrub } from '../scrub';

export interface OracleAnswer {
  answer: string;
  top_score: number;
  needs_human: boolean;
}

function isOracleAnswer(
  value: unknown
): value is { answer: string; top_score: number; needs_human: boolean } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.answer === 'string' &&
    typeof record.top_score === 'number' &&
    Number.isFinite(record.top_score) &&
    typeof record.needs_human === 'boolean'
  );
}

export async function oracleQuery(
  oracleUrl: string,
  companionId: string,
  question: string
): Promise<OracleAnswer> {
  if (question.trim() === '') {
    throw new ToolFailure('refused', 'query_required');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, ORACLE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(oracleUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: `companion-${companionId}`,
          message: question,
          page_url: '',
          conversation_history: [],
        }),
        signal: controller.signal,
      });
    } catch {
      throw new ToolFailure('error', 'oracle_unavailable');
    }
    if (!response.ok) {
      throw new ToolFailure('error', 'oracle_unavailable');
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ToolFailure('error', 'oracle_unavailable');
    }
    if (!isOracleAnswer(payload)) {
      throw new ToolFailure('error', 'oracle_unavailable');
    }
    return {
      answer: scrub(payload.answer),
      top_score: payload.top_score,
      needs_human: payload.needs_human,
    };
  } finally {
    clearTimeout(timer);
  }
}
