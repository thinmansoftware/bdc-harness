import { describe, expect, test } from 'bun:test';
import {
  adoptionContentHash,
  classifyThread,
  composeNudgeBody,
  computeNextAction,
  isSuppressedByNoise,
  nudgeClockMs,
  CUSTOMER_CLOCK_MS,
  MAX_INTERVENTIONS_PER_ITEM_24H,
  NUDGE_CLOCK_MS,
  type GradedActionLike,
  type ThreadSnapshot,
} from './rules';
import type { TmAdoptionRow } from '@archon/core/db/taskmaster';

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

// ---------------------------------------------------------------------------
// M-155 WO 3 (WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01) -- exception push:
// content-complete nudges, register-only bare staleness, noise suppression.
// Every test name carries the literal 'push:' for the Section 12 count gate.
// ---------------------------------------------------------------------------

function makeAdoption(overrides: Partial<TmAdoptionRow> = {}): TmAdoptionRow {
  return {
    thread_ref: 'gh:thinmansoftware/bdc-harness#1',
    snapshot_id: 'snap-test',
    repo: 'thinmansoftware/bdc-harness',
    issue_number: 1,
    title: 'Untitled fixture',
    priority: 'P1',
    labels_json: '["wo","prio:P1"]',
    owner_login: null,
    is_blocked: 0,
    blocked_reason: null,
    next_action: null,
    latest_marker_kind: null,
    latest_marker_at: null,
    state: 'open',
    last_movement_at: null,
    last_movement_kind: null,
    attempts_24h: 0,
    attempts_total: 0,
    evidence_observed_at: new Date(NOW_MS - 60_000).toISOString(),
    source_updated_at: new Date(NOW_MS - 60_000).toISOString(),
    ...overrides,
  };
}

function noiseGrade(threadRef: string, gradedAtMs: number, grade = 'noise'): GradedActionLike {
  return { thread_ref: threadRef, grade, graded_at: new Date(gradedAtMs).toISOString() };
}

describe('M-155 exception push (rules)', () => {
  test('push: a content-complete stale item nudges with real content', () => {
    const adoption = makeAdoption({
      title: 'Fix the thing',
      owner_login: 'major-build',
      next_action: 'waiting on Stripe key rotation',
      last_movement_at: new Date(NOW_MS - 5 * 24 * 3_600_000).toISOString(),
    });
    const proposal = computeNextAction(thread(), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption,
    });
    expect(proposal?.type).toBe('nudge');
    expect(proposal?.body).toContain('Fix the thing');
    expect(proposal?.body).toContain('major-build');
    expect(proposal?.body).toContain('waiting on Stripe key rotation');
    expect(proposal?.body).toContain('https://github.com/thinmansoftware/bdc-harness/issues/1');
    // The old contentless template must be gone.
    expect(proposal?.body).not.toMatch(/has had no activity past its \d+min clock/);
  });

  test('push: bare staleness with UNKNOWN next action does NOT send', () => {
    const adoption = makeAdoption({
      title: 'Bare stale item',
      next_action: null,
      blocked_reason: null,
    });
    const proposal = computeNextAction(thread(), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption,
    });
    expect(proposal).toBeNull();
    // The composer itself declares the row ineligible.
    expect(composeNudgeBody(thread(), adoption, NOW_MS)).toBeNull();
  });

  test('push: replaying the audited chronic corpus produces no sends', () => {
    // 15 threads shaped like the audited #5xx-#8xx block: stale, titled, no
    // next_action, no blocked_reason, unchanged content -- the 91%-noise class.
    for (let i = 0; i < 15; i += 1) {
      const ref = `gh:thinmansoftware/bdc-xo#${500 + i}`;
      const chronicThread = thread({
        ref,
        lastActivityAt: new Date(NOW_MS - 30 * 24 * 3_600_000).toISOString(),
      });
      const adoption = makeAdoption({
        thread_ref: ref,
        repo: 'thinmansoftware/bdc-xo',
        issue_number: 500 + i,
        title: `Chronic item ${i}`,
        next_action: null,
        blocked_reason: null,
      });
      const proposal = computeNextAction(chronicThread, 'stale', {
        interventionsLast24h: 0,
        nowMs: NOW_MS,
        adoption,
      });
      expect(proposal).toBeNull();
    }
  });

  test('push: two consecutive noise grades suppress until content changes', () => {
    const ref = 'gh:thinmansoftware/bdc-harness#1';
    const adoption = makeAdoption({
      title: 'Suppressed item',
      next_action: 'waiting on review',
      last_movement_at: new Date(NOW_MS - 3 * 24 * 3_600_000).toISOString(),
    });
    const grades = [noiseGrade(ref, NOW_MS - 2 * 3_600_000), noiseGrade(ref, NOW_MS - 3_600_000)];
    // Fixture from tm_suppression (durable), NOT from a tm_adoption column --
    // a tm_adoption fixture would pass here and fail in production the moment
    // a snapshot commits (Section 9).
    const suppression = { suppressed_until_hash: adoptionContentHash(adoption) };

    expect(
      computeNextAction(thread(), 'stale', {
        interventionsLast24h: 0,
        nowMs: NOW_MS,
        adoption,
        grades,
        suppression,
      })
    ).toBeNull();

    // Grade-path (no durable row yet) also suppresses on unchanged content.
    expect(isSuppressedByNoise(ref, grades, adoption)).toBe(true);

    // Content moved (next_action + last_movement_at changed): hash differs
    // from the suppressed hash -> a proposal IS produced again.
    const moved = makeAdoption({
      ...adoption,
      next_action: 'waiting on John decision',
      last_movement_at: new Date(NOW_MS - 60_000).toISOString(),
    });
    const recovered = computeNextAction(thread(), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: moved,
      grades,
      suppression,
    });
    expect(recovered?.type).toBe('nudge');
    expect(recovered?.body).toContain('waiting on John decision');
  });

  test('push: ungraded sends never trigger suppression', () => {
    const ref = 'gh:thinmansoftware/bdc-harness#1';
    const adoption = makeAdoption({ title: 'Ungraded item', next_action: 'do the next step' });
    // 5 sent rows, ALL ungraded (grade IS NULL): the audit found 757 ungraded
    // sends, and ungraded must never be read as noise.
    const ungraded: GradedActionLike[] = Array.from({ length: 5 }, () => ({
      thread_ref: ref,
      grade: null,
      graded_at: null,
    }));
    expect(isSuppressedByNoise(ref, ungraded, adoption)).toBe(false);
    const proposal = computeNextAction(thread(), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption,
      grades: ungraded,
    });
    expect(proposal?.type).toBe('nudge');
  });

  test('push: an unclaimed P0 still escalates with NO adoption row (exemption)', () => {
    const proposal = computeNextAction(thread({ priority: 'P0', isUnclaimedP0: true }), 'ready', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
    });
    expect(proposal?.type).toBe('escalate_p0');
    expect(proposal?.recipient).toBe('operator');
    expect(proposal?.actsImmediately).toBe(true);
  });

  test('push: an undelivered ruling still delivers with NO adoption row (exemption)', () => {
    const proposal = computeNextAction(thread({ undeliveredRulingId: 'ruling-155' }), 'ready', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
    });
    expect(proposal?.type).toBe('deliver_ruling');
    expect(proposal?.body).toContain('ruling-155');
    expect(proposal?.body).toContain(proposal?.threadRef ?? '');
  });
});
