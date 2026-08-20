import { describe, expect, test } from 'bun:test';
import {
  classifyThread,
  computeNextAction,
  composeNudgeBody,
  isSuppressedByNoise,
  adoptionContentHash,
  resolveRecipient,
  nudgeClockMs,
  CUSTOMER_CLOCK_MS,
  MAX_INTERVENTIONS_PER_ITEM_24H,
  NUDGE_CLOCK_MS,
  type ThreadSnapshot,
} from './rules';
import { TM_ALLOWED_RECIPIENTS } from './guard';
import type { TmAdoptionRow, TmJournalEntry, TmSuppressionRow } from '@archon/core/db/taskmaster';

const NOW_MS = Date.parse('2026-08-07T12:00:00.000Z');

function thread(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    ref: 'gh:thinmansoftware/bdc-harness#1',
    priority: 'P1',
    lastActivityAt: new Date(NOW_MS - 60_000).toISOString(),
    recipient: 'xo',
    ...overrides,
  };
}

function adoption(overrides: Partial<TmAdoptionRow> = {}): TmAdoptionRow {
  return {
    thread_ref: 'gh:thinmansoftware/bdc-xo#42',
    snapshot_id: 'snap-1',
    repo: 'thinmansoftware/bdc-xo',
    issue_number: 42,
    title: 'Fix the thing',
    priority: 'P1',
    labels_json: '[]',
    owner_login: 'major-build',
    is_blocked: 0,
    blocked_reason: null,
    next_action: 'waiting on Stripe key rotation',
    latest_marker_kind: null,
    latest_marker_at: null,
    state: 'open',
    last_movement_at: new Date(NOW_MS - 5 * 24 * 3_600_000).toISOString(),
    last_movement_kind: 'progress_comment',
    attempts_24h: 0,
    attempts_total: 0,
    evidence_observed_at: new Date(NOW_MS).toISOString(),
    source_updated_at: new Date(NOW_MS).toISOString(),
    ...overrides,
  };
}

function gradeRow(overrides: Partial<TmJournalEntry> = {}): TmJournalEntry {
  return {
    id: 'j1',
    created_at: new Date(NOW_MS - 3_600_000).toISOString(),
    thread_ref: 'gh:thinmansoftware/bdc-xo#42',
    action_type: 'nudge',
    proposal_json: '{}',
    idempotency_key: null,
    before_hash: null,
    proof_predicate: null,
    proof_deadline_at: null,
    outcome: 'sent',
    graded_at: new Date(NOW_MS - 3_600_000).toISOString(),
    grade: 'noise',
    ...overrides,
  };
}

describe('exception-push composer (M-155 WO 3)', () => {
  test('push: a content-complete stale item nudges with real content', () => {
    const a = adoption();
    const proposal = computeNextAction(thread({ ref: a.thread_ref }), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: a,
    });
    expect(proposal?.type).toBe('nudge');
    expect(proposal?.body).toContain('Fix the thing');
    expect(proposal?.body).toContain('major-build');
    expect(proposal?.body).toContain('waiting on Stripe key rotation');
    expect(proposal?.body).toContain('https://github.com/thinmansoftware/bdc-xo/issues/42');
    expect(proposal?.body).not.toMatch(/has had no activity past its \d+min clock/);
  });

  test('push: bare staleness with UNKNOWN next action does NOT send', () => {
    const a = adoption({ next_action: null, blocked_reason: null });
    const proposal = computeNextAction(thread({ ref: a.thread_ref }), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: a,
    });
    expect(proposal).toBeNull();
  });

  test('push: replaying the audited chronic corpus produces no sends', () => {
    let sends = 0;
    for (let i = 0; i < 15; i++) {
      const a = adoption({
        thread_ref: `gh:thinmansoftware/bdc-xo#${500 + i}`,
        issue_number: 500 + i,
        next_action: null,
        blocked_reason: null,
      });
      const proposal = computeNextAction(thread({ ref: a.thread_ref }), 'stale', {
        interventionsLast24h: 0,
        nowMs: NOW_MS,
        adoption: a,
      });
      if (proposal) sends += 1;
    }
    expect(sends).toBe(0);
  });

  test('push: two consecutive noise grades suppress until content changes', () => {
    const a = adoption();
    const grades = [
      gradeRow({ id: 'g1', graded_at: new Date(NOW_MS - 2 * 3_600_000).toISOString() }),
      gradeRow({ id: 'g2', graded_at: new Date(NOW_MS - 1 * 3_600_000).toISOString() }),
    ];
    const suppression: TmSuppressionRow = {
      thread_ref: a.thread_ref,
      suppressed_until_hash: adoptionContentHash(a),
      suppressed_at: new Date(NOW_MS - 3_600_000).toISOString(),
      noise_grade_count: 2,
    };
    const suppressed = computeNextAction(thread({ ref: a.thread_ref }), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: a,
      grades,
      suppression,
    });
    expect(suppressed).toBeNull();

    // Content moves -> hash differs -> suppression lifts.
    const moved = adoption({ next_action: 'unblocked, ready for review' });
    const recovered = computeNextAction(thread({ ref: a.thread_ref }), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: moved,
      grades,
      suppression,
    });
    expect(recovered?.type).toBe('nudge');
  });

  test('push: ungraded sends never trigger suppression', () => {
    const ungraded = Array.from({ length: 5 }, (_, i) =>
      gradeRow({ id: `u${i}`, grade: null, graded_at: null, outcome: 'sent' })
    );
    expect(isSuppressedByNoise('gh:thinmansoftware/bdc-xo#42', ungraded, adoption())).toBe(false);
  });

  test('push: an unclaimed P0 still escalates with no adoption row', () => {
    const proposal = computeNextAction(thread({ priority: 'P0', isUnclaimedP0: true }), 'ready', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
    });
    expect(proposal?.type).toBe('escalate_p0');
    expect(proposal?.recipient).toBe('operator');
  });

  test('push: an undelivered ruling still delivers with no adoption row', () => {
    const proposal = computeNextAction(thread({ undeliveredRulingId: 'ruling-9' }), 'ready', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
    });
    expect(proposal?.type).toBe('deliver_ruling');
  });

  test('push: every owner resolves to xo in this WO', () => {
    for (const owner of ['major-build', 'captain-ci', 'someone-unmapped', null]) {
      const resolved = resolveRecipient(owner);
      expect(resolved).toBe('xo');
      expect((TM_ALLOWED_RECIPIENTS as readonly string[]).includes(resolved)).toBe(true);
    }
  });

  test('composeNudgeBody returns null when title is missing', () => {
    expect(composeNudgeBody(thread(), adoption({ title: null }))).toBeNull();
    expect(composeNudgeBody(thread(), undefined)).toBeNull();
  });
});

describe('nudgeClockMs', () => {
  test('ratified Q1 clocks: 30min P0, 4h P1, 24h P2/P3', () => {
    expect(NUDGE_CLOCK_MS.P0).toBe(30 * 60_000);
    expect(NUDGE_CLOCK_MS.P1).toBe(4 * 3_600_000);
    expect(NUDGE_CLOCK_MS.P2).toBe(24 * 3_600_000);
    expect(NUDGE_CLOCK_MS.P3).toBe(24 * 3_600_000);
  });

  test('customer-facing threads use the 30min clock regardless of priority', () => {
    expect(nudgeClockMs({ priority: 'P3', isCustomerFacing: true })).toBe(CUSTOMER_CLOCK_MS);
  });
});

describe('classifyThread', () => {
  test('blocked wins over everything', () => {
    expect(classifyThread(thread({ isBlocked: true, undeliveredRulingId: 'r1' }), NOW_MS)).toBe(
      'blocked'
    );
  });

  test('undelivered ruling or unclaimed P0 is ready', () => {
    expect(classifyThread(thread({ undeliveredRulingId: 'r1' }), NOW_MS)).toBe('ready');
    expect(classifyThread(thread({ priority: 'P0', isUnclaimedP0: true }), NOW_MS)).toBe('ready');
  });

  test('idle past clock is stale; within clock is healthy', () => {
    const idle5h = new Date(NOW_MS - 5 * 3_600_000).toISOString();
    const idle3h = new Date(NOW_MS - 3 * 3_600_000).toISOString();
    expect(classifyThread(thread({ lastActivityAt: idle5h }), NOW_MS)).toBe('stale');
    expect(classifyThread(thread({ lastActivityAt: idle3h }), NOW_MS)).toBe('healthy');
  });

  test('customer-facing P2 stales on the 30min clock', () => {
    const idle45m = new Date(NOW_MS - 45 * 60_000).toISOString();
    expect(
      classifyThread(
        thread({ priority: 'P2', isCustomerFacing: true, lastActivityAt: idle45m }),
        NOW_MS
      )
    ).toBe('stale');
  });

  test('unparseable activity timestamp is healthy, not guessed stale', () => {
    expect(classifyThread(thread({ lastActivityAt: 'not-a-date' }), NOW_MS)).toBe('healthy');
  });
});

describe('computeNextAction', () => {
  test('blocked and healthy threads produce no action', () => {
    const t = thread();
    expect(computeNextAction(t, 'blocked', { interventionsLast24h: 0, nowMs: NOW_MS })).toBeNull();
    expect(computeNextAction(t, 'healthy', { interventionsLast24h: 0, nowMs: NOW_MS })).toBeNull();
  });

  test('24h per-item intervention budget (max 3) suppresses further actions', () => {
    const t = thread({ undeliveredRulingId: 'r1' });
    expect(
      computeNextAction(t, 'ready', {
        interventionsLast24h: MAX_INTERVENTIONS_PER_ITEM_24H,
        nowMs: NOW_MS,
      })
    ).toBeNull();
  });

  test('deliver_ruling acts immediately with a per-ruling idempotency key', () => {
    const proposal = computeNextAction(thread({ undeliveredRulingId: 'ruling-42' }), 'ready', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
    });
    expect(proposal?.type).toBe('deliver_ruling');
    expect(proposal?.actsImmediately).toBe(true);
    expect(proposal?.idempotencyKey).toBe('tm:deliver_ruling:ruling-42');
  });

  test('unclaimed P0 escalates to operator immediately', () => {
    const proposal = computeNextAction(thread({ priority: 'P0', isUnclaimedP0: true }), 'ready', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
    });
    expect(proposal?.type).toBe('escalate_p0');
    expect(proposal?.recipient).toBe('operator');
    expect(proposal?.actsImmediately).toBe(true);
  });

  test('stale thread nudges without immediacy (two-tick confirmation required)', () => {
    const proposal = computeNextAction(thread(), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
    });
    expect(proposal?.type).toBe('nudge');
    expect(proposal?.actsImmediately).toBe(false);
    expect(proposal?.idempotencyKey.startsWith('tm:nudge:')).toBe(true);
  });

  test('nudge idempotency key is stable within a clock bucket', () => {
    const a = computeNextAction(thread(), 'stale', { interventionsLast24h: 0, nowMs: NOW_MS });
    const b = computeNextAction(thread(), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS + 60_000,
    });
    expect(a?.idempotencyKey).toBe(b?.idempotencyKey ?? '');
  });
});
