import { describe, expect, test } from 'bun:test';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import { evaluateEscalationClock, XO_HANDOFF_IDEMPOTENCY_PREFIX } from './escalation-clock';

const start = '2026-08-01T00:00:00.000Z';

function candidate(overrides: Partial<DispatchMessage> = {}): DispatchMessage {
  return {
    id: 'message-1',
    recipient: 'xo',
    priority: 'blocker',
    status: 'queued',
    created_at: start,
    acknowledged_at: null,
    addressed_at: null,
    escalated_tg_at: null,
    escalated_sms_at: null,
    ...overrides,
  } as DispatchMessage;
}

describe('XO blocker escalation clock', () => {
  test('never pages John for a blocker addressed to a non-XO principal', () => {
    expect(
      evaluateEscalationClock(candidate({ recipient: 'operator' }), new Date('2026-08-03T00:00:00Z'))
    ).toEqual([]);
  });

  test('keeps the 4h Telegram and 24h SMS thresholds with idempotent handoff keys', () => {
    expect(evaluateEscalationClock(candidate(), new Date('2026-08-01T03:59:59.999Z'))).toEqual(
      []
    );

    const atFourHours = evaluateEscalationClock(
      candidate(),
      new Date('2026-08-01T04:00:00.000Z')
    );
    expect(atFourHours.map(action => action.channel)).toEqual(['telegram']);
    expect(atFourHours[0]?.idempotencyKey.startsWith(XO_HANDOFF_IDEMPOTENCY_PREFIX)).toBe(true);

    const atTwentyFourHours = evaluateEscalationClock(
      candidate({ escalated_tg_at: '2026-08-01T04:00:00.000Z' }),
      new Date('2026-08-02T00:00:00.000Z')
    );
    expect(atTwentyFourHours.map(action => action.channel)).toEqual(['sms']);
    expect(atTwentyFourHours[0]?.idempotencyKey).toBe('xo-handoff:message-1:sms');
  });
});
