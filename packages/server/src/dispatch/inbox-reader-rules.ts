import type { DispatchMessage } from '@archon/core/db/dispatch';
import { routeOpsEvent } from './ops-event-routing';

export type InboxClass = 'INFO_DUPLICATE' | 'NUDGE' | 'ACTIONABLE';
export type InboxAction = 'DROP' | 'DIGEST' | 'COLLAPSE' | 'BRING';
export type InboxMessage = Pick<
  DispatchMessage,
  | 'id'
  | 'sender'
  | 'task_type'
  | 'recipient'
  | 'body'
  | 'correlation_id'
  | 'subject_key'
  | 'created_at'
  | 'status'
  | 'acknowledged_at'
  | 'addressed_at'
  | 'route_disposition'
> & { priority?: string; subject_state?: 'OPEN' | 'CLOSED' | 'MERGED' | null };

export interface InboxClassification {
  class: InboxClass;
  rule_id: string;
  action: InboxAction;
  reason: string;
  collapse_key: string | null;
}

export const ACTIONABLE_KEYWORDS =
  /\?|\bblock(er|ers|ed|ing)?\b|\bdecisions?\b|\bP[01]\b|\bcustomers?\b|\bproduction\b|\bprod\b|\burgent\b|\brefunds?\b|\bcharge[ds]?\b/i;

export const INBOX_READER_RULES = Object.freeze(['X1','X2','X3a','X3b','X3c','X4a','X4b','X5a','X5b','X5c','O1','O2','O3a','O3b','O4a','O4b','O5a','O5b','O6','O7','O8','O9a','O9b','O10']);

const allowedPairs = new Set([
  'overseer/run_report',
  'overseer-review-route/run_report',
  'taskmaster/agent_message',
  'taskmaster/blocker_report',
  'duty-officer/agent_message',
  'do/agent_message',
  'dispatch/agent_message',
  'dispatch/xo_escalation_handoff',
  'xo/agent_message',
  'xo-board/agent_message',
  'codex/agent_message',
  'cursor/agent_message',
  'claude/agent_message',
  'grok/agent_message',
  'desktop-claude/agent_message',
  'codex-desktop/agent_message',
  'codex-voice/agent_message',
]);

function result(
  kind: InboxClass,
  rule_id: string,
  reason: string,
  collapse_key: string | null = null,
  action: InboxAction = kind === 'ACTIONABLE' ? 'BRING' : kind === 'NUDGE' ? 'COLLAPSE' : 'DROP'
): InboxClassification {
  return { class: kind, rule_id, action, reason, collapse_key };
}

const parsedBody = (body: string): Record<string, unknown> => {
  try { const value = JSON.parse(body); return value && typeof value === 'object' ? value : {}; }
  catch { return {}; }
};
const olderThan14Days = (message: InboxMessage) => Date.now() - Date.parse(message.created_at) > 14 * 86_400_000;
const terminalSubject = (message: InboxMessage) => message.subject_state === 'CLOSED' || message.subject_state === 'MERGED';
const benign = new Set(['ignored_event','ignored_draft','queued','approved','checks_pending','superseded_head','stale_head','duplicate_delivery']);
const receiptFailures = new Set(['merge_custody_conflict','submission_failed','rejected_signature']);
const blockedReceipts = new Set(['changes_requested','blocked','blocked_required_contexts_unavailable','custody']);

export function classifyInboxMessage(message: InboxMessage): InboxClassification {
  if (message.priority === 'blocker') {
    return result('ACTIONABLE', 'blocker_priority', 'blocker priority requires human action');
  }
  if (!allowedPairs.has(`${message.sender}/${message.task_type}`)) {
    return result('ACTIONABLE', 'unknown_sender', 'sender and task type are not allow-listed');
  }
  // Preserve the original reader's producer-specific rules before applying the
  // broader mailbox table. These structured receipts are load-bearing history
  // and carry more information than the generic O1/O4 matches below.
  if (
    (message.sender === 'overseer' || message.sender === 'overseer-review-route') &&
    message.task_type === 'run_report'
  ) {
    let receipt: unknown;
    try { receipt = JSON.parse(message.body); } catch {
      return result('ACTIONABLE', 'body_not_json', 'overseer report body is not JSON');
    }
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
      return result('ACTIONABLE', 'body_not_json', 'overseer report body is not a JSON object');
    }
    const structured = receipt as Record<string, unknown>;
    if (ACTIONABLE_KEYWORDS.test(message.body)) {
      return result('ACTIONABLE', 'keyword', 'body contains an actionable keyword');
    }
    if (structured.kind === 'pr_review_submit_receipt' &&
        ['approved', 'changes_requested'].includes(String(structured.disposition)) &&
        ['APPROVE', 'REQUEST_CHANGES'].includes(String(structured.event))) {
      return result('INFO_DUPLICATE', 'info_review_posted', 'verdict already posted as a GitHub PR review');
    }
    if (structured.kind === 'pr_review_submit_receipt' &&
        ['checks_pending', 'stale_head', 'superseded_head'].includes(String(structured.disposition))) {
      return result('INFO_DUPLICATE', 'info_submit_intermediate', 'intermediate review receipt, superseded by the terminal receipt for the same head');
    }
    if (structured.kind === 'pr_review_ingest_receipt' &&
        ['queued', 'ignored_event', 'ignored_draft', 'duplicate_delivery', 'superseded_head'].includes(String(structured.disposition))) {
      return result('INFO_DUPLICATE', 'info_ingest_receipt', 'webhook ingest bookkeeping');
    }
  }
  if (ACTIONABLE_KEYWORDS.test(message.body)) {
    return result('ACTIONABLE', 'keyword', 'body contains an actionable keyword');
  }
  if (message.sender === 'taskmaster' && message.task_type === 'agent_message' &&
      /^Taskmaster daily (digest|canary)\b/.test(message.body)) {
    return result('NUDGE', 'nudge_taskmaster_daily', 'collapsed Taskmaster daily reminder', message.subject_key ?? 'taskmaster-daily');
  }
  if (message.sender === 'duty-officer' && message.task_type === 'agent_message' &&
      message.body.startsWith('DO pass ')) {
    return result('NUDGE', 'nudge_duty_officer_pass', 'collapsed duty officer pass reminder', 'duty-officer-pass');
  }
  const routed = routeOpsEvent(message);
  if (routed.class !== 'ROUTINE') return result('ACTIONABLE', 'ops_event_guard', routed.reason, message.subject_key);

  const body = parsedBody(message.body);
  const disposition = String(body.disposition ?? '');
  const kind = String(body.kind ?? '');
  if (message.recipient === 'xo') {
    if (message.sender === 'taskmaster' && message.body.startsWith('Nudge:') && olderThan14Days(message)) return result('INFO_DUPLICATE','X1','old Taskmaster nudge',null,'DROP');
    if (message.body.includes('expectation EXHAUSTED')) return result('INFO_DUPLICATE','X2','exhausted expectations summarized by owner',null,'DROP');
    if ((message.sender === 'duty-officer' || message.sender === 'do' || message.sender === 'dispatch') && /escalat/i.test(`${message.task_type} ${kind} ${message.body}`)) {
      if (message.subject_key?.startsWith('digest:')) return result('INFO_DUPLICATE','X3b','daily DO digest',message.subject_key,'DIGEST');
      return result('ACTIONABLE','X3c','DO escalation',message.subject_key,'BRING');
    }
    if (message.task_type === 'xo_escalation_handoff' || kind === 'xo_escalation_handoff') return terminalSubject(message) ? result('INFO_DUPLICATE','X4a','closed handoff',null,'DROP') : result('INFO_DUPLICATE','X4b','handoff re-verify',null,'DIGEST');
    const seatSender = /^(xo|xo-board|codex|cursor|claude|grok|desktop-claude|codex-desktop|codex-voice)$/.test(message.sender);
    if (seatSender && /escalat/i.test(message.body)) return result('ACTIONABLE','X5c','recent seat escalation',message.subject_key,'BRING');
    if (seatSender && /\b(receipt|PONG|probe)\b/i.test(message.body) && olderThan14Days(message)) return result('INFO_DUPLICATE','X5a','old seat receipt',null,'DROP');
    if (seatSender && olderThan14Days(message)) return result('INFO_DUPLICATE','X5b','old seat report',message.subject_key,'DIGEST');
    if (seatSender) return result('ACTIONABLE','X5c','recent seat message',message.subject_key,'BRING');
    return result('ACTIONABLE', 'no_rule_matched', 'no informational rule matched', null, 'BRING');
  }
  if (benign.has(disposition)) return result('INFO_DUPLICATE','O1','benign review receipt',null,'DROP');
  if (blockedReceipts.has(disposition) && terminalSubject(message)) return result('INFO_DUPLICATE','O2','closed review action',null,'DROP');
  if (receiptFailures.has(disposition)) return result('ACTIONABLE','O3a','receipt failure',message.subject_key,'BRING');
  if (blockedReceipts.has(disposition)) return result('INFO_DUPLICATE','O3b','open PR review action',message.subject_key,'DIGEST');
  if (message.task_type === 'run_report' || kind === 'run_report') return olderThan14Days(message) ? result('INFO_DUPLICATE','O4a','old run report',null,'DROP') : result('INFO_DUPLICATE','O4b','recent run report',message.subject_key,'DIGEST');
  if (/Unclaimed P0/i.test(message.body)) return terminalSubject(message) ? result('INFO_DUPLICATE','O5a','closed unclaimed P0',null,'DROP') : result('NUDGE','O5b','open unclaimed P0',message.subject_key,'COLLAPSE');
  if (/dead[- ]man/i.test(message.body)) return result('NUDGE','O6','dead-man alarm',message.subject_key ?? 'dead-man','COLLAPSE');
  if (/Fuelglass|seat[- ]gate/i.test(message.body)) return result('NUDGE','O7','seat gate',message.subject_key ?? 'seat-gate','COLLAPSE');
  if (/Taskmaster daily (count|digest)/i.test(message.body)) return result('NUDGE','O8','Taskmaster daily digest',message.subject_key ?? 'taskmaster-daily','COLLAPSE');
  if ((message.sender === 'duty-officer' || message.sender === 'do') && message.body === 'probe') return result('INFO_DUPLICATE','O9a','DO probe',null,'DROP');
  if ((message.sender === 'duty-officer' || message.sender === 'do') && message.body.startsWith('DO pass ')) return result('NUDGE','O9b','DO pass',message.created_at.slice(0,10),'COLLAPSE');
  if (/^(voice|xo|xo-board|codex-voice)$/.test(message.sender)) return result('ACTIONABLE','O10','owner seat row',message.subject_key,'BRING');

  return result('ACTIONABLE', 'no_rule_matched', 'no informational rule matched', null, 'BRING');
}
