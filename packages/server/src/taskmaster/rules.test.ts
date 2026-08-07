import { describe, expect, test } from 'bun:test';
import {
  classifyThread,
  computeDigestProposal,
  computeNextAction,
  nudgeClockMs,
  type TaskmasterThread,
} from './rules';

const NOW = 1_800_000_000_000; // fixed fake clock
const MIN = 60_000;
const HOUR = 60 * MIN;

function thread(overrides: Partial<TaskmasterThread>): TaskmasterThread {
  return {
    ref: 'wo/1',
    priority: 'P1',
    lastActivityAt: NOW,
    claimed: true,
    recipient: 'major-build',
    subject: 'WO-TEST',
    ...overrides,
  };
}

describe('nudgeClockMs', () => {
  test('30min for P0 and customer, 4h for P1, 24h for P2/P3', () => {
    expect(nudgeClockMs('P0')).toBe(30 * MIN);
    expect(nudgeClockMs('customer')).toBe(30 * MIN);
    expect(nudgeClockMs('P1')).toBe(4 * HOUR);
    expect(nudgeClockMs('P2')).toBe(24 * HOUR);
    expect(nudgeClockMs('P3')).toBe(24 * HOUR);
  });
});

describe('classifyThread', () => {
  test('healthy when within its nudge clock', () => {
    expect(classifyThread(thread({ lastActivityAt: NOW - 1 * HOUR }), NOW)).toBe('healthy');
  });

  test('stale when idle past its nudge clock', () => {
    expect(classifyThread(thread({ lastActivityAt: NOW - 5 * HOUR }), NOW)).toBe('stale');
  });

  test('blocked thread is monitored, never nudged', () => {
    expect(classifyThread(thread({ lastActivityAt: NOW - 5 * HOUR, blocked: true }), NOW)).toBe(
      'blocked'
    );
  });

  test('undelivered ruling is always ready', () => {
    expect(classifyThread(thread({ undeliveredRuling: true, lastActivityAt: NOW }), NOW)).toBe(
      'ready'
    );
  });

  test('unclaimed P0 past clock is ready (escalation-eligible)', () => {
    expect(
      classifyThread(
        thread({ priority: 'P0', claimed: false, lastActivityAt: NOW - 40 * MIN }),
        NOW
      )
    ).toBe('ready');
  });
});

describe('computeNextAction', () => {
  test('undelivered ruling yields a deliver_ruling proposal that acts immediately', () => {
    const p = computeNextAction(thread({ ref: 'ruling/M-133', undeliveredRuling: true }), NOW, 0);
    expect(p?.actionType).toBe('deliver_ruling');
    expect(p?.actImmediately).toBe(true);
    expect(p?.idempotencyKey).toContain('deliver_ruling:ruling/M-133');
  });

  test('unclaimed stale P0 yields an escalate proposal that acts immediately', () => {
    const p = computeNextAction(
      thread({ ref: 'wo/p0', priority: 'P0', claimed: false, lastActivityAt: NOW - 40 * MIN }),
      NOW,
      0
    );
    expect(p?.actionType).toBe('escalate');
    expect(p?.actImmediately).toBe(true);
  });

  test('stale P1 yields a nudge proposal that requires two ticks', () => {
    const p = computeNextAction(thread({ lastActivityAt: NOW - 5 * HOUR }), NOW, 0);
    expect(p?.actionType).toBe('nudge');
    expect(p?.actImmediately).toBe(false);
  });

  test('healthy thread yields no proposal', () => {
    expect(computeNextAction(thread({ lastActivityAt: NOW }), NOW, 0)).toBeNull();
  });

  test('epoch is folded into the idempotency key so a resumed epoch does not replay', () => {
    const a = computeNextAction(thread({ lastActivityAt: NOW - 5 * HOUR }), NOW, 0);
    const b = computeNextAction(thread({ lastActivityAt: NOW - 5 * HOUR }), NOW, 1);
    expect(a?.idempotencyKey).not.toBe(b?.idempotencyKey);
  });
});

describe('computeDigestProposal', () => {
  test('builds a digest action keyed on the day-bucket (one per day, epoch-free)', () => {
    const p = computeDigestProposal({ now: NOW, recipient: 'john', body: 'x', dayBucket: 42 });
    expect(p.actionType).toBe('digest');
    expect(p.recipient).toBe('john');
    expect(p.actImmediately).toBe(true);
    expect(p.idempotencyKey).toBe('tm:digest:42');
  });

  test('same day-bucket yields the same key (dedupe) across pause/resume epochs', () => {
    const a = computeDigestProposal({ now: NOW, recipient: 'john', body: 'a', dayBucket: 7 });
    const b = computeDigestProposal({ now: NOW + 1, recipient: 'john', body: 'b', dayBucket: 7 });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });
});
