import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const calls = { notices: 0, handoffs: 0, list: 0, claim: 0, release: 0 };
mock.module('@archon/core/db/dispatch', () => ({
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
    return [{ id: 'xo-1' }];
  },
  claimDispatchEscalation: async ({ leg }: { leg: string }) => {
    calls.claim++;
    return leg === 'telegram' ? { id: 'xo-1' } : null;
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
    process.env.DISPATCH_TELEGRAM_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.DISPATCH_PHASE1_ACTIVATED_AT;
  });

  test('reconciles and creates internal handoffs while John-facing legs stay dark', async () => {
    await tickDispatchEscalationClock();
    expect(calls.notices).toBe(1);
    expect(calls.handoffs).toBe(1);
    expect(calls.claim).toBe(0);
  });

  test('claims once at an injected boundary and releases only a failed delivery', async () => {
    process.env.DISPATCH_SENDER_AUTH_MODE = 'enforce';
    const telegram = mock(async () => {
      throw new Error('retry');
    });
    await tickDispatchEscalationClock({
      now: () => new Date('2026-08-08T00:00:00.000Z'),
      telegram,
    });
    expect(calls.list).toBe(1);
    expect(calls.claim).toBeGreaterThan(0);
    expect(calls.release).toBe(1);
  });
});
