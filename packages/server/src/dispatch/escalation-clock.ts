import type { DispatchMessage } from '@archon/core/db/dispatch';

export const XO_HANDOFF_IDEMPOTENCY_PREFIX = 'xo-handoff:';
export const TELEGRAM_ESCALATION_AFTER_MS = 4 * 60 * 60 * 1000;
export const SMS_ESCALATION_AFTER_MS = 24 * 60 * 60 * 1000;

export type EscalationChannel = 'telegram' | 'sms';

export interface EscalationAction {
  channel: EscalationChannel;
  messageId: string;
  idempotencyKey: string;
}

type EscalationCandidate = Pick<
  DispatchMessage,
  | 'id'
  | 'recipient'
  | 'priority'
  | 'status'
  | 'created_at'
  | 'acknowledged_at'
  | 'addressed_at'
  | 'escalated_tg_at'
  | 'escalated_sms_at'
>;

function isOpenXoBlocker(message: EscalationCandidate): boolean {
  return (
    message.recipient.trim().toLowerCase() === 'xo' &&
    message.priority === 'blocker' &&
    (message.status === 'queued' || message.status === 'claimed') &&
    message.acknowledged_at === null &&
    message.addressed_at === null
  );
}

export function escalationIdempotencyKey(
  messageId: string,
  channel: EscalationChannel
): string {
  return `${XO_HANDOFF_IDEMPOTENCY_PREFIX}${messageId}:${channel}`;
}

export function evaluateEscalationClock(
  message: EscalationCandidate,
  now: Date = new Date()
): EscalationAction[] {
  if (!isOpenXoBlocker(message)) return [];
  const ageMs = now.getTime() - new Date(message.created_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return [];

  const actions: EscalationAction[] = [];
  if (ageMs >= TELEGRAM_ESCALATION_AFTER_MS && message.escalated_tg_at === null) {
    actions.push({
      channel: 'telegram',
      messageId: message.id,
      idempotencyKey: escalationIdempotencyKey(message.id, 'telegram'),
    });
  }
  if (ageMs >= SMS_ESCALATION_AFTER_MS && message.escalated_sms_at === null) {
    actions.push({
      channel: 'sms',
      messageId: message.id,
      idempotencyKey: escalationIdempotencyKey(message.id, 'sms'),
    });
  }
  return actions;
}
