import { describe, expect, test } from 'bun:test';
import {
  classifyThread,
  computeNextAction,
  composeNudgeBody,
  isSuppressedByNoise,
  adoptionContentHash,
  resolveRecipient,
  blockerNamesSeat,
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
    expect(composeNudgeBody(thread(), adoption({ title: null }), NOW_MS)).toBeNull();
    expect(composeNudgeBody(thread(), undefined, NOW_MS)).toBeNull();
  });

  test('push: the nudge body reports elapsed time since real movement, not a raw timestamp', () => {
    // last_movement_at exactly 3 days 4 hours before NOW.
    const movedAt = new Date(NOW_MS - (3 * 24 + 4) * 3_600_000).toISOString();
    const a = adoption({ last_movement_at: movedAt });
    const body = composeNudgeBody(thread({ ref: a.thread_ref }), a, NOW_MS);
    expect(body).toContain('Last real movement was 3d 4h ago');
    // The raw ISO timestamp must NOT leak into the message.
    expect(body).not.toContain(movedAt);
  });

  test('push: a missing adoption row on a stale item does NOT send (no contentless fallback)', () => {
    const proposal = computeNextAction(thread(), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      // adoption intentionally undefined -- refresh has not enriched this thread.
    });
    expect(proposal).toBeNull();
  });

  test('push: a blocked item whose blocker NAMES A SEAT nudges with real content', () => {
    const a = adoption({
      is_blocked: 1,
      blocked_reason: 'blocked on major-build for the infra key',
      next_action: null,
    });
    const proposal = computeNextAction(thread({ ref: a.thread_ref, isBlocked: true }), 'blocked', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: a,
    });
    expect(proposal?.type).toBe('nudge');
    expect(proposal?.body).toContain('Blocked: blocked on major-build for the infra key');
  });

  test('push: a blocked item whose blocker names NO seat does NOT send', () => {
    // "waiting on infra key" says the item is stuck without saying who unsticks
    // it -- not actionable content, so it is held back to the register.
    const a = adoption({
      is_blocked: 1,
      blocked_reason: 'waiting on infra key',
      next_action: null,
    });
    const proposal = computeNextAction(thread({ ref: a.thread_ref, isBlocked: true }), 'blocked', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: a,
    });
    expect(proposal).toBeNull();
    expect(composeNudgeBody(thread({ ref: a.thread_ref }), a, NOW_MS)).toBeNull();
  });

  test('push: a seatless blocker still sends when a next action carries the content', () => {
    const a = adoption({
      is_blocked: 1,
      blocked_reason: 'waiting on infra key',
      next_action: 'rotate the key and re-run the migration',
    });
    const body = composeNudgeBody(thread({ ref: a.thread_ref }), a, NOW_MS);
    // The seatless blocker is discarded; the body reports the next action.
    expect(body).toContain('Next action: rotate the key and re-run the migration');
    expect(body).not.toContain('waiting on infra key');
  });

  test('push: blockerNamesSeat matches whole tokens only, across seat aliases', () => {
    expect(blockerNamesSeat('blocked on XO to drain the mailbox')).toBe('xo');
    expect(blockerNamesSeat('needs Major Build to land the fix')).toBe('major-build');
    expect(blockerNamesSeat('waiting for captain-ci to go green')).toBe('captain-ci');
    expect(blockerNamesSeat('John has to approve the deploy')).toBe('operator');
    // No seat named.
    expect(blockerNamesSeat('waiting on the vendor')).toBeNull();
    expect(blockerNamesSeat('')).toBeNull();
    expect(blockerNamesSeat(null)).toBeNull();
    // Substrings inside unrelated words must NOT count as a seat.
    expect(blockerNamesSeat('toxoplasmosis screening pending')).toBeNull();
    expect(blockerNamesSeat('Johnson the vendor has not replied')).toBeNull();
  });

  test('push: a ruling on a blocked thread still delivers (exempt verb, precedence first)', () => {
    // classifyThread returns "blocked" when isBlocked is set; the exempt verb
    // must still act rather than being swallowed by the classification gate.
    const proposal = computeNextAction(
      thread({ isBlocked: true, undeliveredRulingId: 'ruling-42' }),
      'blocked',
      { interventionsLast24h: 0, nowMs: NOW_MS }
    );
    expect(proposal?.type).toBe('deliver_ruling');
  });

  test('push: exempt verbs gain adoption content when available', () => {
    const a = adoption({ title: 'Rotate the Stripe key', owner_login: 'major-build' });
    const ruling = computeNextAction(
      thread({ ref: a.thread_ref, undeliveredRulingId: 'ruling-7' }),
      'ready',
      { interventionsLast24h: 0, nowMs: NOW_MS, adoption: a }
    );
    expect(ruling?.type).toBe('deliver_ruling');
    expect(ruling?.body).toContain('Rotate the Stripe key');
    expect(ruling?.body).toContain('major-build');

    const p0 = computeNextAction(
      thread({ ref: a.thread_ref, priority: 'P0', isUnclaimedP0: true }),
      'ready',
      { interventionsLast24h: 0, nowMs: NOW_MS, adoption: a }
    );
    expect(p0?.type).toBe('escalate_p0');
    expect(p0?.body).toContain('Rotate the Stripe key');
  });

  test('push: isSuppressedByNoise requires the content hash to be unchanged since the noise grade', () => {
    const a = adoption();
    const stampedHash = adoptionContentHash(a);
    // Two noise grades whose before_hash captured the CURRENT content -> suppress.
    const unchanged = [
      gradeRow({
        id: 'g1',
        before_hash: stampedHash,
        graded_at: new Date(NOW_MS - 2 * 3_600_000).toISOString(),
      }),
      gradeRow({
        id: 'g2',
        before_hash: stampedHash,
        graded_at: new Date(NOW_MS - 1 * 3_600_000).toISOString(),
      }),
    ];
    expect(isSuppressedByNoise(a.thread_ref, unchanged, a)).toBe(true);

    // Same grades, but the live content has since moved -> the later grade's
    // hash no longer matches, so suppression must NOT apply.
    const moved = adoption({ next_action: 'unblocked, ready for review' });
    expect(isSuppressedByNoise(a.thread_ref, unchanged, moved)).toBe(false);
  });

  test('push: newly-changed content is not suppressed immediately (no suppression record yet)', () => {
    const oldRow = adoption();
    const oldHash = adoptionContentHash(oldRow);
    // Grades recorded against the OLD content hash...
    const grades = [
      gradeRow({
        id: 'g1',
        before_hash: oldHash,
        graded_at: new Date(NOW_MS - 2 * 3_600_000).toISOString(),
      }),
      gradeRow({
        id: 'g2',
        before_hash: oldHash,
        graded_at: new Date(NOW_MS - 1 * 3_600_000).toISOString(),
      }),
    ];
    // ...but the item has since moved and there is no persisted suppression row.
    const moved = adoption({ next_action: 'unblocked, ready for review' });
    const proposal = computeNextAction(thread({ ref: moved.thread_ref }), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: moved,
      grades,
      // suppression intentionally omitted -- record not yet written.
    });
    expect(proposal?.type).toBe('nudge');
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
    // Exception-push: a nudge now requires a content-complete adoption row.
    const a = adoption();
    const proposal = computeNextAction(thread({ ref: a.thread_ref }), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: a,
    });
    expect(proposal?.type).toBe('nudge');
    expect(proposal?.actsImmediately).toBe(false);
    expect(proposal?.idempotencyKey.startsWith('tm:nudge:')).toBe(true);
  });

  test('nudge idempotency key is stable within a clock bucket', () => {
    const row = adoption();
    const a = computeNextAction(thread({ ref: row.thread_ref }), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: row,
    });
    const b = computeNextAction(thread({ ref: row.thread_ref }), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS + 60_000,
      adoption: row,
    });
    expect(a?.idempotencyKey).toBe(b?.idempotencyKey ?? '');
  });
});
