import type { DispatchMessage } from '@archon/core/db/dispatch';

export type InboxClass = 'INFO_DUPLICATE' | 'NUDGE' | 'ACTIONABLE';
export type InboxMessage = Pick<
  DispatchMessage,
  | 'id'
  | 'sender'
  | 'task_type'
  | 'recipient'
  | 'body'
  | 'subject_key'
  | 'created_at'
  | 'status'
  | 'acknowledged_at'
  | 'addressed_at'
  | 'route_disposition'
> & { priority?: string };

export interface InboxClassification {
  class: InboxClass;
  rule_id: string;
  reason: string;
  collapse_key: string | null;
}

export const ACTIONABLE_KEYWORDS =
  /\?|\bblock(er|ers|ed|ing)?\b|\bdecisions?\b|\bP[01]\b|\bcustomers?\b|\bproduction\b|\bprod\b|\burgent\b|\brefunds?\b|\bcharge[ds]?\b/i;

export const INBOX_READER_RULES = Object.freeze([
  { id: 'info_review_posted', class: 'INFO_DUPLICATE', number: 'R1' },
  { id: 'info_submit_intermediate', class: 'INFO_DUPLICATE', number: 'R2' },
  { id: 'info_ingest_receipt', class: 'INFO_DUPLICATE', number: 'R3' },
  { id: 'nudge_taskmaster_daily', class: 'NUDGE', number: 'R4' },
  { id: 'nudge_duty_officer_pass', class: 'NUDGE', number: 'R5' },
] as const satisfies readonly { id: string; class: InboxClass; number: string }[]);

const allowedPairs = new Set([
  'overseer/run_report',
  'overseer-review-route/run_report',
  'taskmaster/agent_message',
  'duty-officer/agent_message',
]);

function result(
  kind: InboxClass,
  rule_id: string,
  reason: string,
  collapse_key: string | null = null
): InboxClassification {
  return { class: kind, rule_id, reason, collapse_key };
}

export function classifyInboxMessage(message: InboxMessage): InboxClassification {
  if (message.priority === 'blocker') {
    return result('ACTIONABLE', 'blocker_priority', 'blocker priority requires human action');
  }
  if (!allowedPairs.has(`${message.sender}/${message.task_type}`)) {
    return result('ACTIONABLE', 'unknown_sender', 'sender and task type are not allow-listed');
  }
  if (ACTIONABLE_KEYWORDS.test(message.body)) {
    return result('ACTIONABLE', 'keyword', 'body contains an actionable keyword');
  }

  if (
    (message.sender === 'overseer' || message.sender === 'overseer-review-route') &&
    message.task_type === 'run_report'
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.body);
    } catch {
      return result('ACTIONABLE', 'body_not_json', 'overseer report body is not JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return result('ACTIONABLE', 'body_not_json', 'overseer report body is not a JSON object');
    }
    const body = parsed as Record<string, unknown>;
    if (
      body.kind === 'pr_review_submit_receipt' &&
      ['approved', 'changes_requested'].includes(String(body.disposition)) &&
      ['APPROVE', 'REQUEST_CHANGES'].includes(String(body.event))
    ) {
      return result(
        'INFO_DUPLICATE',
        'info_review_posted',
        'verdict already posted as a GitHub PR review'
      );
    }
    if (
      body.kind === 'pr_review_submit_receipt' &&
      ['checks_pending', 'stale_head', 'superseded_head'].includes(String(body.disposition))
    ) {
      return result(
        'INFO_DUPLICATE',
        'info_submit_intermediate',
        'intermediate review receipt, superseded by the terminal receipt for the same head'
      );
    }
    if (
      body.kind === 'pr_review_ingest_receipt' &&
      [
        'queued',
        'ignored_event',
        'ignored_draft',
        'duplicate_delivery',
        'superseded_head',
      ].includes(String(body.disposition))
    ) {
      return result('INFO_DUPLICATE', 'info_ingest_receipt', 'webhook ingest bookkeeping');
    }
  }
  if (
    message.sender === 'taskmaster' &&
    message.task_type === 'agent_message' &&
    /^Taskmaster daily (digest|canary)\b/.test(message.body)
  ) {
    return result(
      'NUDGE',
      'nudge_taskmaster_daily',
      'collapsed Taskmaster daily reminder',
      message.subject_key ?? 'taskmaster-daily'
    );
  }
  if (
    message.sender === 'duty-officer' &&
    message.task_type === 'agent_message' &&
    message.body.startsWith('DO pass ')
  ) {
    return result(
      'NUDGE',
      'nudge_duty_officer_pass',
      'collapsed duty officer pass reminder',
      'duty-officer-pass'
    );
  }
  return result('ACTIONABLE', 'no_rule_matched', 'no informational rule matched');
}
