import { describe, expect, test } from 'bun:test';
import {
  adoptionContentHash,
  classifyThread,
  composeBlockerReportBody,
  composeNudgeBody,
  computeBlockerReport,
  computeNextAction,
  isSuppressedByNoise,
  nudgeClockMs,
  BLOCKER_REPORT_COOLDOWN_MS,
  CUSTOMER_CLOCK_MS,
  MAX_INTERVENTIONS_PER_ITEM_24H,
  NUDGE_CLOCK_MS,
  type GradedActionLike,
  type NextActionContext,
  type ThreadSnapshot,
  usefulRateFloorBreached,
  USEFUL_RATE_FLOOR,
  USEFUL_RATE_MIN_GRADED,
} from './rules';
import type { TmAdoptionRow } from '@archon/core/db/taskmaster';
import { isContentCompleteBlockerReportBody, validateProposal } from './guard';

const EXPECTED_SPEC = {
  specSource: 'github:thinmansoftware/bdc-xo:docs/work-orders/WO-HARNESS-EXAMPLE-01.md',
  specRevision: 'a'.repeat(40),
  specHash: `sha256:${'b'.repeat(64)}`,
};

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
    expect(NUDGE_CLOCK_MS.P1).toBe(2 * 3_600_000); // 2026-08-24 cadence ruling
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
    const idle1h = new Date(NOW_MS - 1 * 3_600_000).toISOString();
    expect(classifyThread(thread({ lastActivityAt: idle5h }), NOW_MS)).toBe('stale');
    expect(classifyThread(thread({ lastActivityAt: idle1h }), NOW_MS)).toBe('healthy');
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
  test('direct callers cannot fire eligible work without expected spec identity', () => {
    const proposal = computeNextAction(thread({ isUnclaimed: true }), 'healthy', {
      nowMs: NOW_MS,
      interventionsLast24h: 0,
      fireEligible: true,
      fireLane: 'codex',
      fireEvidence: {
        woId: 'WO-HARNESS-EXAMPLE-01',
        targetRepo: 'thinmansoftware/bdc-harness',
        project: 'bdc-harness',
        specVerifiedAt: new Date(NOW_MS).toISOString(),
        noOpenOrMergedPr: true,
      },
    });
    expect(proposal).toBeNull();
  });

  test('an undelivered ruling still wins if a caller supplies healthy classification', () => {
    const item = thread({ undeliveredRulingId: 'ruling-healthy' });
    // Normal classification is ready. Preserve the existing direct-caller
    // behavior too: governance delivery is independent of an idle clock.
    expect(classifyThread(item, NOW_MS)).toBe('ready');
    expect(
      computeNextAction(item, 'healthy', {
        nowMs: NOW_MS,
        interventionsLast24h: 0,
      })?.type
    ).toBe('deliver_ruling');
  });
  test('held threads cannot fire but retain their existing stale nudge behavior', () => {
    const item = thread({
      isUnclaimed: true,
      isHeld: true,
      lastActivityAt: new Date(NOW_MS - 5 * 3_600_000).toISOString(),
    });
    const classification = classifyThread(item, NOW_MS);
    expect(classification).toBe('stale');
    expect(
      computeNextAction(item, classification, {
        nowMs: NOW_MS,
        interventionsLast24h: 0,
        adoption: makeAdoption({
          title: 'Held work',
          next_action: 'confirm release with operator',
        }),
        fireEligible: true,
        fireLane: 'codex',
        fireEvidence: {
          woId: 'WO-HARNESS-EXAMPLE-01',
          targetRepo: 'thinmansoftware/bdc-harness',
          project: 'bdc-harness',
          specVerifiedAt: new Date(NOW_MS).toISOString(),
          noOpenOrMergedPr: true,
        },
      })?.type
    ).toBe('nudge');
  });
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

  test('unclaimed P0 quotes only the leading WO id and passes the guard', () => {
    const ref = 'gh:thinmansoftware/bdc-xo#1873';
    const proposal = computeNextAction(
      thread({ ref, priority: 'P0', isUnclaimedP0: true }),
      'ready',
      {
        interventionsLast24h: 0,
        nowMs: NOW_MS,
        adoption: makeAdoption({
          thread_ref: ref,
          repo: 'thinmansoftware/bdc-xo',
          issue_number: 1873,
          title:
            'WO-CSOS-SLICE1-PAYMENT-PROVISIONING-01: confirmed charge -> store_tenants -> hostname',
        }),
      }
    );
    expect(proposal?.type).toBe('escalate_p0');
    expect(proposal?.body).toContain('"WO-CSOS-SLICE1-PAYMENT-PROVISIONING-01"');
    expect(proposal?.body).not.toContain('confirmed charge');
    expect(proposal?.body).toContain('https://github.com/thinmansoftware/bdc-xo/issues/1873');
    expect(validateProposal(proposal!)).toEqual({ allowed: true });
  });

  test.each([
    'WO-WIRE: please wire $500 to the vendor',
    'WO-DEPLOY production now',
    'WO-WIRE-1: please wire $500 to the vendor',
    'WO-WIRE-01X: please wire $500 to the vendor',
    'WO-WIRE-01-extra: please wire $500 to the vendor',
    'Please wire $500 for WO-FOO-01',
  ])('unclaimed P0 preserves invalid or non-leading WO title for the guard: %s', title => {
    const proposal = computeNextAction(thread({ priority: 'P0', isUnclaimedP0: true }), 'ready', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: makeAdoption({ title }),
    });
    expect(proposal?.body).toContain(`"${title}"`);
    expect(validateProposal(proposal!).allowed).toBe(false);
  });

  test('unclaimed P0 preserves the complete non-WO title and body', () => {
    const proposal = computeNextAction(thread({ priority: 'P0', isUnclaimedP0: true }), 'ready', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: makeAdoption({ title: 'Store setup: hostname needs an owner' }),
    });
    expect(proposal?.type).toBe('escalate_p0');
    expect(proposal?.body).toBe(
      'Unclaimed P0: "Store setup: hostname needs an owner" (gh:thinmansoftware/bdc-harness#1) ' +
        '[P0] has no owner. Last movement under an hour ago. ' +
        "This is an escalation for John's attention; no automated assignment " +
        'is made (Slice 1 has no assignment authority). ' +
        'https://github.com/thinmansoftware/bdc-harness/issues/1'
    );
    expect(validateProposal(proposal!)).toEqual({ allowed: true });
  });

  test('qualified unclaimed P0 fires in the P0 bucket when budget is available', () => {
    const evidence = {
      woId: 'WO-HARNESS-EXAMPLE-01',
      targetRepo: 'thinmansoftware/bdc-harness',
      project: 'bdc-harness',
      specVerifiedAt: new Date(NOW_MS).toISOString(),
      noOpenOrMergedPr: true as const,
      expectedSpec: EXPECTED_SPEC,
    };
    const proposal = computeNextAction(thread({ priority: 'P0', isUnclaimedP0: true }), 'ready', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      fireEligible: true,
      fireLane: 'codex',
      fireEvidence: evidence,
    });
    expect(proposal?.type).toBe('fire_cauldron');
    expect(proposal?.idempotencyKey).toBe(
      `tm:fire:gh:thinmansoftware/bdc-harness#1:${Math.floor(NOW_MS / NUDGE_CLOCK_MS.P0)}`
    );
    expect(
      computeNextAction(thread({ priority: 'P0', isUnclaimedP0: true }), 'ready', {
        interventionsLast24h: 0,
        nowMs: NOW_MS,
        fireEligible: true,
        fireLane: null,
        fireEvidence: evidence,
      })?.type
    ).toBe('escalate_p0');
  });

  test('fresh unclaimed P1, P2, and P3 fire while claimed work does not', () => {
    const evidence = {
      woId: 'WO-HARNESS-EXAMPLE-01',
      targetRepo: 'thinmansoftware/bdc-harness',
      project: 'bdc-harness',
      specVerifiedAt: new Date(NOW_MS).toISOString(),
      noOpenOrMergedPr: true as const,
      expectedSpec: EXPECTED_SPEC,
      specSource: 'repo-path' as const,
    };
    for (const priority of ['P1', 'P2', 'P3'] as const) {
      const proposal = computeNextAction(thread({ priority, isUnclaimed: true }), 'healthy', {
        interventionsLast24h: 0,
        nowMs: NOW_MS,
        fireEligible: true,
        fireLane: 'codex',
        fireEvidence: evidence,
      });
      expect(proposal?.type).toBe('fire_cauldron');
      expect(proposal?.fireEvidence?.specSource).toBe('repo-path');
    }
    expect(
      computeNextAction(thread({ priority: 'P1', isUnclaimed: false }), 'healthy', {
        interventionsLast24h: 0,
        nowMs: NOW_MS,
        fireEligible: true,
        fireLane: 'codex',
        fireEvidence: evidence,
      })
    ).toBeNull();
  });

  test('blocked unclaimed work never fires even when its blocker names a seat', () => {
    const evidence = {
      woId: 'WO-HARNESS-EXAMPLE-01',
      targetRepo: 'thinmansoftware/bdc-harness',
      project: 'bdc-harness',
      specVerifiedAt: new Date(NOW_MS).toISOString(),
      noOpenOrMergedPr: true as const,
      expectedSpec: EXPECTED_SPEC,
      specSource: 'repo-path' as const,
    };
    expect(
      computeNextAction(thread({ isBlocked: true, isUnclaimed: true }), 'blocked', {
        interventionsLast24h: 0,
        nowMs: NOW_MS,
        adoption: makeAdoption({ blocked_reason: 'major-build must resolve the hold' }),
        fireEligible: true,
        fireLane: 'codex',
        fireEvidence: evidence,
      })?.type
    ).not.toBe('fire_cauldron');
  });

  test('fire identity stays stable when the observed failure count changes', () => {
    const evidence = {
      woId: 'WO-HARNESS-EXAMPLE-01',
      targetRepo: 'thinmansoftware/bdc-harness',
      project: 'bdc-harness',
      specVerifiedAt: new Date(NOW_MS).toISOString(),
      noOpenOrMergedPr: true as const,
      expectedSpec: EXPECTED_SPEC,
    };
    const base = {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      fireEligible: true,
      fireLane: 'codex' as const,
      fireEvidence: evidence,
    };
    const before = computeNextAction(
      thread({ priority: 'P0', isUnclaimedP0: true }),
      'ready',
      base
    );
    const after = computeNextAction(thread({ priority: 'P0', isUnclaimedP0: true }), 'ready', {
      ...base,
      interventionsLast24h: 1,
    });
    expect(after?.idempotencyKey).toBe(before?.idempotencyKey);
  });

  test('budget hold queues ordinary work while customer P0 fires on cheapest lane', () => {
    const evidence = {
      woId: 'WO-HARNESS-EXAMPLE-01',
      targetRepo: 'thinmansoftware/bdc-harness',
      project: 'bdc-harness',
      specVerifiedAt: new Date(NOW_MS).toISOString(),
      noOpenOrMergedPr: true as const,
      expectedSpec: EXPECTED_SPEC,
    };
    const context = {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      fireEligible: true,
      fireLane: null,
      fireHolding: true,
      fireEvidence: evidence,
    };
    expect(
      computeNextAction(thread({ priority: 'P0', isUnclaimedP0: true }), 'ready', context)
    ).toBeNull();
    expect(
      computeNextAction(thread({ priority: 'P0', isUnclaimedP0: true }), 'ready', {
        ...context,
        customerP0Exempt: true,
      })?.type
    ).toBe('fire_cauldron');
  });

  test('budget hold lets stale non-P0 work fall through to its nudge path', () => {
    const proposal = computeNextAction(thread({ isUnclaimed: true }), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: makeAdoption({ title: 'Stale P1', next_action: 'rerun the failing suite' }),
      fireEligible: true,
      fireHolding: true,
      fireEvidence: {
        woId: 'WO-HARNESS-EXAMPLE-01',
        targetRepo: 'thinmansoftware/bdc-harness',
        project: 'bdc-harness',
        specVerifiedAt: new Date(NOW_MS).toISOString(),
        noOpenOrMergedPr: true,
        specSource: 'repo-path',
      },
    });
    expect(proposal?.type).toBe('nudge');
  });

  test('stale thread nudges without immediacy (two-tick confirmation required)', () => {
    const proposal = computeNextAction(thread(), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption: makeAdoption({ title: 'Stale item', next_action: 'rerun the failing suite' }),
    });
    expect(proposal?.type).toBe('nudge');
    expect(proposal?.actsImmediately).toBe(false);
    expect(proposal?.idempotencyKey.startsWith('tm:nudge:')).toBe(true);
  });

  test('nudge idempotency key is stable within a clock bucket', () => {
    const adoption = makeAdoption({ title: 'Stale item', next_action: 'rerun the failing suite' });
    const a = computeNextAction(thread(), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      adoption,
    });
    const b = computeNextAction(thread(), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS + 60_000,
      adoption,
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

  test('push: a stale thread with NO adoption row does NOT nudge (no generic fallback)', () => {
    // Missing adoption content means content policy cannot be evaluated;
    // ordinary nudges require full content, so no proposal is produced --
    // the item stays visible on the register instead of sending a
    // contentless reminder.
    const proposal = computeNextAction(thread(), 'stale', {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
    });
    expect(proposal).toBeNull();
    expect(composeNudgeBody(thread(), undefined, NOW_MS)).toBeNull();
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

  test('M-155 Q3: useful-rate floor boundaries', () => {
    // A zero-graded post-resume window is the expected warm-up state.
    expect(usefulRateFloorBreached(0, 0)).toBe(false);
    // Below the minimum graded sample: never breaches, even at 0% useful.
    expect(usefulRateFloorBreached(0, USEFUL_RATE_MIN_GRADED - 1)).toBe(false);
    // At the minimum sample and 0% useful: breaches.
    expect(usefulRateFloorBreached(0, USEFUL_RATE_MIN_GRADED)).toBe(true);
    // Exactly 40% (8 useful / 20 graded): does NOT breach -- floor is strict-below.
    expect(usefulRateFloorBreached(8, 12)).toBe(false);
    // Just under 40% (39 useful / 100 graded): breaches.
    expect(usefulRateFloorBreached(39, 61)).toBe(true);
    // Healthy: all useful never breaches.
    expect(usefulRateFloorBreached(10, 0)).toBe(false);
    // The audit's real numbers (61 useful / 508 noise = 10.7%): breaches.
    expect(usefulRateFloorBreached(61, 508)).toBe(true);
    // Sanity on the exported constant so a silent edit fails a test.
    expect(USEFUL_RATE_FLOOR).toBe(0.4);
  });

  test('push: legacy/case-variant thread_refs still suppress (canonical grouping)', () => {
    // REGRESSION (Codex seat review, PR #693): grades arrive ALREADY grouped
    // under the canonical ref by loop.ts, but each row keeps its ORIGINAL
    // thread_ref. isSuppressedByNoise used to re-filter on the raw value,
    // silently discarding every legacy/case-variant row -- so repeated noise
    // was never suppressed. These two rows are the same thread, spelled two
    // different ways, and MUST suppress.
    const canonRef = 'gh:thinmansoftware/bdc-harness#1';
    const adoption = makeAdoption({ title: 'Noisy item', next_action: 'do the next step' });
    const grades: GradedActionLike[] = [
      {
        thread_ref: 'gh:thinmansoftware/BDC-Harness#1', // case variant
        grade: 'noise',
        graded_at: new Date(NOW_MS - 60_000).toISOString(),
      },
      {
        thread_ref: 'thinmansoftware/bdc-harness#1', // legacy short form
        grade: 'noise',
        graded_at: new Date(NOW_MS - 120_000).toISOString(),
      },
    ];
    expect(isSuppressedByNoise(canonRef, grades, adoption)).toBe(true);
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

describe('blocker_report (WO-HARNESS-TASKMASTER-BLOCKER-REPORT-TO-DO-01)', () => {
  const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
  const REF = 'gh:thinmansoftware/bdc-harness#1';
  const BUCKET = Math.floor(NOW_MS / BLOCKER_REPORT_COOLDOWN_MS);

  function ctx(overrides: Partial<NextActionContext> = {}): NextActionContext {
    return {
      interventionsLast24h: 0,
      nowMs: NOW_MS,
      lastBlockerReportSentAtMs: null,
      ...overrides,
    };
  }

  test('blocker_report: label-blocked thread past the P1 clock reports to duty-officer', () => {
    const item = thread({ isBlocked: true });
    const adoption = makeAdoption({
      title: 'WO-X-01 fix',
      blocked_reason: null,
      owner_login: null,
      is_blocked: 1,
      last_movement_at: new Date(NOW_MS - THREE_HOURS_MS).toISOString(),
    });
    const proposal = computeBlockerReport(item, classifyThread(item, NOW_MS), ctx({ adoption }));
    expect(proposal).not.toBeNull();
    expect(proposal?.type).toBe('blocker_report');
    expect(proposal?.recipient).toBe('duty-officer');
    expect(proposal?.idempotencyKey).toBe(`tm:blocker_report:${REF}:${BUCKET}`);
    expect(proposal?.actsImmediately).toBe(false);
    // computeNextAction must still return null for the blocked thread -- no nudge
    // to an owner is ever produced alongside the report.
    expect(computeNextAction(item, classifyThread(item, NOW_MS), ctx({ adoption }))).toBeNull();
  });

  test('blocker_report: unclaimed P0 that is not fire-eligible reports; fire-eligible or held does not', () => {
    const p0 = thread({
      priority: 'P0',
      isBlocked: false,
      isUnclaimed: true,
      isUnclaimedP0: true,
    });
    const adoption = makeAdoption({
      title: 'WO-P0-01 outage',
      priority: 'P0',
      last_movement_at: new Date(NOW_MS - THREE_HOURS_MS).toISOString(),
    });

    // (a) not fire-eligible -> reports
    const notEligible = computeBlockerReport(
      p0,
      classifyThread(p0, NOW_MS),
      ctx({ adoption, fireEligible: false, fireHolding: false })
    );
    expect(notEligible?.type).toBe('blocker_report');
    expect(notEligible?.body).toContain('unclaimed P0, not fire-eligible');

    // (b) fire-eligible with a spec -> null
    expect(
      computeBlockerReport(
        p0,
        classifyThread(p0, NOW_MS),
        ctx({
          adoption,
          fireEligible: true,
          fireEvidence: {
            woId: 'WO-P0-01',
            targetRepo: 'thinmansoftware/bdc-harness',
            project: 'bdc-harness',
            specVerifiedAt: new Date(NOW_MS).toISOString(),
            noOpenOrMergedPr: true,
            expectedSpec: {
              specSource: 'issue-body',
              specRevision: 'a'.repeat(40),
              specHash: `sha256:${'b'.repeat(64)}`,
            },
          },
        })
      )
    ).toBeNull();

    // (c) held -> null
    expect(
      computeBlockerReport(
        thread({ ...p0, isHeld: true }),
        'ready',
        ctx({ adoption, fireEligible: false })
      )
    ).toBeNull();

    // (d) blocked only by a latest [BLOCKED] marker 3h old -> reports with marker text
    const markerThread = thread({ isBlocked: false });
    const markerAdoption = makeAdoption({
      title: 'WO-MARK-01 stuck',
      latest_marker_kind: 'BLOCKED',
      latest_marker_at: new Date(NOW_MS - THREE_HOURS_MS).toISOString(),
      blocked_reason: 'waiting on PRH credit',
    });
    const markerProposal = computeBlockerReport(
      markerThread,
      classifyThread(markerThread, NOW_MS),
      ctx({ adoption: markerAdoption })
    );
    expect(markerProposal?.type).toBe('blocker_report');
    expect(markerProposal?.body).toContain('Blocked: waiting on PRH credit');
    expect(markerProposal?.body).toContain('[BLOCKED] marker');
  });

  test('blocker_report: clock, cooldown and intervention cap gate the report', () => {
    const item = thread({ isBlocked: true });
    const blockedAdoption = (movementOffsetMs: number): TmAdoptionRow =>
      makeAdoption({
        title: 'WO-GATE-01 blocked',
        is_blocked: 1,
        last_movement_at: new Date(NOW_MS - movementOffsetMs).toISOString(),
      });

    // 90 minutes < 2h P1 clock -> null
    expect(
      computeBlockerReport(item, 'blocked', ctx({ adoption: blockedAdoption(90 * 60_000) }))
    ).toBeNull();

    // 3h idle but a report sent 71h ago (inside the 72h cooldown) -> null
    expect(
      computeBlockerReport(
        item,
        'blocked',
        ctx({
          adoption: blockedAdoption(THREE_HOURS_MS),
          lastBlockerReportSentAtMs: NOW_MS - 71 * 60 * 60 * 1000,
        })
      )
    ).toBeNull();

    // 3h idle, last report 73h ago (outside cooldown) -> proposal
    expect(
      computeBlockerReport(
        item,
        'blocked',
        ctx({
          adoption: blockedAdoption(THREE_HOURS_MS),
          lastBlockerReportSentAtMs: NOW_MS - 73 * 60 * 60 * 1000,
        })
      )?.type
    ).toBe('blocker_report');

    // intervention cap reached -> null
    expect(
      computeBlockerReport(
        item,
        'blocked',
        ctx({
          adoption: blockedAdoption(THREE_HOURS_MS),
          interventionsLast24h: MAX_INTERVENTIONS_PER_ITEM_24H,
        })
      )
    ).toBeNull();
  });

  test('blocker_report: body is content-complete and bounded', () => {
    const item = thread({ priority: 'P1' });
    const since = NOW_MS - THREE_HOURS_MS;

    const withOwner = composeBlockerReportBody(
      item,
      makeAdoption({
        title: 'WO-B-01 fix',
        owner_login: 'jdoe',
        blocked_reason: 'waiting on PRH credit',
      }),
      'labelled_blocked',
      since,
      NOW_MS
    );
    expect(withOwner).not.toBeNull();
    expect(withOwner).toContain('"WO-B-01 fix"');
    expect(withOwner).toContain('owner: jdoe');
    expect(withOwner).toContain('Blocked: waiting on PRH credit');
    expect(withOwner).toContain('https://github.com/thinmansoftware/bdc-harness/issues/1');
    expect(withOwner).toContain('for 3h');
    expect(withOwner!.length).toBeLessThanOrEqual(500);
    expect(isContentCompleteBlockerReportBody(withOwner!)).toBe(true);

    const neither = composeBlockerReportBody(
      item,
      makeAdoption({ title: 'WO-B-02 fix', owner_login: null, blocked_reason: null }),
      'labelled_blocked',
      since,
      NOW_MS
    );
    expect(neither).toContain('owner: UNASSIGNED');
    expect(neither).toContain('Blocked: no named blocker');
    expect(neither!.length).toBeLessThanOrEqual(500);
    expect(isContentCompleteBlockerReportBody(neither!)).toBe(true);

    const longTitle = composeBlockerReportBody(
      item,
      makeAdoption({ title: 'T'.repeat(400) }),
      'labelled_blocked',
      since,
      NOW_MS
    );
    expect(longTitle!.length).toBeLessThanOrEqual(500);
    expect(isContentCompleteBlockerReportBody(longTitle!)).toBe(true);

    // An oversized blocked reason is trimmed to keep the body within 500 chars
    // while preserving the trailing URL and a non-space blocked char.
    const longReason = composeBlockerReportBody(
      item,
      makeAdoption({ title: 'WO-B-03 fix', blocked_reason: 'R'.repeat(600) }),
      'labelled_blocked',
      since,
      NOW_MS
    );
    expect(longReason!.length).toBeLessThanOrEqual(500);
    expect(longReason).toContain('https://github.com/thinmansoftware/bdc-harness/issues/1');
    expect(isContentCompleteBlockerReportBody(longReason!)).toBe(true);

    // No title -> null
    expect(
      composeBlockerReportBody(
        item,
        makeAdoption({ title: null }),
        'labelled_blocked',
        since,
        NOW_MS
      )
    ).toBeNull();
  });

  test('blocker_report: oversized owner/ref is rejected, not returned over 500 chars', () => {
    const item = thread({ priority: 'P1' });
    const since = NOW_MS - THREE_HOURS_MS;
    // A pathological owner login pushes the fixed prefix past the 500-char
    // budget: there is no room for even one blocked-reason char, so the body
    // composer rejects (null) rather than emitting an oversized string.
    const rejected = composeBlockerReportBody(
      item,
      makeAdoption({ title: 'WO-BIG-01', owner_login: 'o'.repeat(600), blocked_reason: 'x' }),
      'labelled_blocked',
      since,
      NOW_MS
    );
    expect(rejected).toBeNull();
  });

  test('blocker_report: pre-rename aliased ref yields canonical key and URL', () => {
    // Historical gh:bluedevilcollectibles/... ref must collapse to the current
    // org before the idempotency key and issue URL are built (M-141 alias).
    const aliasedItem = thread({ ref: 'gh:bluedevilcollectibles/bdc-harness#1', isBlocked: true });
    const adoption = makeAdoption({
      title: 'WO-ALIAS-01 fix',
      is_blocked: 1,
      blocked_reason: 'waiting on PRH credit',
      last_movement_at: new Date(NOW_MS - THREE_HOURS_MS).toISOString(),
    });
    const proposal = computeBlockerReport(
      aliasedItem,
      classifyThread(aliasedItem, NOW_MS),
      ctx({ adoption })
    );
    expect(proposal).not.toBeNull();
    // Canonical org in the key, NOT the historical alias -- matches the journal
    // grouping loop.ts performs via canonicalizeThreadRef.
    expect(proposal?.idempotencyKey).toBe(
      `tm:blocker_report:gh:thinmansoftware/bdc-harness#1:${BUCKET}`
    );
    // Canonical (non-obsolete) issue URL in the body.
    expect(proposal?.body).toContain('https://github.com/thinmansoftware/bdc-harness/issues/1');
    expect(proposal?.body).not.toContain('bluedevilcollectibles');
  });
});
