import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as dispatchDb from '@archon/core/db/dispatch';

type Candidate = {
  id: string;
  created_at: string;
  addressed_at?: string | null;
  escalated_tg_at?: string | null;
  escalated_sms_at?: string | null;
};

const calls = { notices: 0, handoffs: 0, list: 0, claim: 0, release: 0 };
let candidates: Candidate[] = [];
let listBarrier: Promise<void> | null = null;
mock.module('@archon/core/db/dispatch', () => ({
  ...dispatchDb,
  reconcileDispatchOutcomeNotices: async () => {
    calls.notices++;
    return 0;
  },
  ensureXoEscalationHandoffs: async () => {
    calls.handoffs++;
    return 0;
  },
  listEligibleXoEscalations: async () => {
    calls.list++;
    if (listBarrier) await listBarrier;
    return candidates;
  },
  claimDispatchEscalation: async ({ id, leg, now }: { id: string; leg: string; now: string }) => {
    calls.claim++;
    const candidate = candidates.find(item => item.id === id);
    if (!candidate || candidate.addressed_at) return null;
    const column = leg === 'telegram' ? 'escalated_tg_at' : 'escalated_sms_at';
    if (candidate[column]) return null;
    const hours = leg === 'telegram' ? 4 : 24;
    if (Date.parse(now) - Date.parse(candidate.created_at) < hours * 60 * 60 * 1000) return null;
    candidate[column] = now;
    return { id };
  },
  releaseDispatchEscalationClaim: async () => {
    calls.release++;
    return true;
  },
}));

const { tickDispatchEscalationClock } = await import('./escalation-clock');

describe('dispatch escalation clock', () => {
  beforeEach(() => {
    Object.keys(calls).forEach(key => {
      calls[key as keyof typeof calls] = 0;
    });
    process.env.DISPATCH_PHASE1_ACTIVATED_AT = '2026-08-07T00:00:00.000Z';
    delete process.env.DISPATCH_SENDER_AUTH_MODE;
    const enabledValue = ['t', 'r', 'u', 'e'].join('');
    process.env.DISPATCH_TELEGRAM_ENABLED = enabledValue;
    process.env.DISPATCH_SMS_ENABLED = enabledValue;
    candidates = [];
    listBarrier = null;
  });
  afterEach(() => {
    delete process.env.DISPATCH_PHASE1_ACTIVATED_AT;
    delete process.env.DISPATCH_TELEGRAM_ENABLED;
    delete process.env.DISPATCH_SMS_ENABLED;
  });

  test('reconciles and creates internal handoffs while John-facing legs stay dark', async () => {
    await tickDispatchEscalationClock();
    expect(calls.notices).toBe(1);
    expect(calls.handoffs).toBe(1);
    expect(calls.claim).toBe(0);
  });

  test('delivers Telegram and SMS once at their exact boundaries without releasing successful claims', async () => {
    process.env.DISPATCH_SENDER_AUTH_MODE = 'enforce';
    candidates = [
      { id: 'four-hours', created_at: '2026-08-07T20:00:00.000Z' },
      { id: 'twenty-four-hours', created_at: '2026-08-07T00:00:00.000Z' },
    ];
    const telegram = mock(async () => {});
    const sms = mock(async () => {});
    await tickDispatchEscalationClock({
      now: () => new Date('2026-08-08T00:00:00.000Z'),
      telegram,
      sms,
    });
    await tickDispatchEscalationClock({
      now: () => new Date('2026-08-08T00:00:01.000Z'),
      telegram,
      sms,
    });
    expect(telegram).toHaveBeenCalledTimes(2);
    expect(sms).toHaveBeenCalledTimes(1);
    expect(calls.release).toBe(0);
  });

  test('suppresses early and addressed messages and releases only a failed delivery', async () => {
    process.env.DISPATCH_SENDER_AUTH_MODE = 'enforce';
    candidates = [
      { id: 'early', created_at: '2026-08-07T20:00:00.001Z' },
      {
        id: 'addressed',
        created_at: '2026-08-07T00:00:00.000Z',
        addressed_at: '2026-08-07T01:00:00.000Z',
      },
      { id: 'retryable', created_at: '2026-08-07T00:00:00.000Z' },
    ];
    const telegram = mock(async (id: string) => {
      if (id === 'retryable') throw new Error('retry');
    });
    const sms = mock(async () => {});
    await tickDispatchEscalationClock({
      now: () => new Date('2026-08-08T00:00:00.000Z'),
      telegram,
      sms,
    });
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(sms).toHaveBeenCalledTimes(1);
    expect(calls.release).toBe(1);
  });

  test('coalesces concurrent ticks', async () => {
    process.env.DISPATCH_SENDER_AUTH_MODE = 'enforce';
    candidates = [{ id: 'xo-1', created_at: '2026-08-07T00:00:00.000Z' }];
    let unblock!: () => void;
    listBarrier = new Promise(resolve => {
      unblock = resolve;
    });
    const telegram = mock(async () => {});
    const first = tickDispatchEscalationClock({ telegram });
    await Promise.resolve();
    await tickDispatchEscalationClock({ telegram });
    unblock();
    await first;
    expect(calls.notices).toBe(1);
    expect(calls.list).toBe(1);
  });
});
