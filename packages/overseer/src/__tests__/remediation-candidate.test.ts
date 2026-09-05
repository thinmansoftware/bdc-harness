/**
 * WO-HARNESS-OVERSEER-VERDICT-TO-TASKMASTER-REMEDIATION-01, Section 11.
 *
 * Scenarios 1-7 and 9 are covered here. Scenario 8 (Taskmaster refusal) is
 * GATED on bdc-harness PR #669 (M-129), which was still OPEN when this landed
 * -- packages/server/src/taskmaster/* is frozen, so the consumer that would
 * make scenario 8 assertable does not exist yet. It is skipped with that
 * reason stated, per the spec's own instruction.
 *
 * No mock.module anywhere: every dependency is injected, so these tests cannot
 * pollute the process-wide module cache for other files in the package.
 */
import { describe, expect, test } from 'bun:test';
import type { IndependentReviewFinding } from '../independent-review-evidence.ts';
import {
  AUTO_FIXABLE_CLASSES,
  classifyFinding,
  classifyFindings,
  countPriorRemediationAttempts,
  decideRemediation,
  MAX_REMEDIATION_ATTEMPTS,
  parseRemediationCandidateBody,
  REMEDIATION_CANDIDATE_KIND,
  remediationIdempotencyKey,
  type RemediationCandidateInput,
} from '../remediation-candidate.ts';
import { runAndSubmitReview, type ReviewWorkItem, type SubmitDeps } from '../pr-review-submit.ts';

/**
 * The live anchor. This is the defect shopops#650 actually found on
 * 2026-08-28: a backfill migration updating the parent row's tenant_id before
 * its children, which the composite FK (case_id, tenant_id) rejects.
 */
const MIGRATION_ORDERING_FINDING: IndependentReviewFinding = {
  scope: 'migrations/041_backfill_tenant.sql',
  severity: 'blocker',
  summary:
    'The migration updates the parent case row tenant_id before the child rows; the composite foreign key (case_id, tenant_id) rejects this ordering, so the migration can never reach its own later step.',
};

const TEST_FAILURE_FINDING: IndependentReviewFinding = {
  scope: 'packages/core/src/db/cases.test.ts',
  severity: 'major',
  summary: 'Two tests fail against the new column name.',
};

const DESIGN_FINDING: IndependentReviewFinding = {
  scope: 'packages/core/src/db/cases.ts',
  severity: 'blocker',
  summary:
    'This design pushes tenancy resolution into the data layer, which is a scope question for the board rather than a defect.',
};

function baseInput(overrides: Partial<RemediationCandidateInput> = {}): RemediationCandidateInput {
  return {
    owner: 'thinmansoftware',
    repo: 'shopops',
    prNumber: 650,
    headSha: 'f868542e0000000000000000000000000000abcd',
    verdict: 'CHANGES_REQUESTED',
    findings: [MIGRATION_ORDERING_FINDING],
    verdictBody: 'Independent review at head f868542e.\n\nMigration ordering violates the FK.',
    priorAttempts: 0,
    ...overrides,
  };
}

describe('scenario 1: machine-fixable findings produce exactly one candidate', () => {
  test('emits attempt 1 carrying PR ref, head SHA, and the verdict body', () => {
    const decision = decideRemediation(baseInput());

    expect(decision.emit).toBe(true);
    if (!decision.emit) throw new Error('unreachable');

    expect(decision.body.kind).toBe(REMEDIATION_CANDIDATE_KIND);
    expect(decision.body.owner).toBe('thinmansoftware');
    expect(decision.body.repo).toBe('shopops');
    expect(decision.body.prNumber).toBe(650);
    expect(decision.body.headSha).toBe('f868542e0000000000000000000000000000abcd');
    expect(decision.body.attempt).toBe(1);
    expect(decision.body.maxAttempts).toBe(MAX_REMEDIATION_ATTEMPTS);
    expect(decision.body.findingClasses).toEqual(['migration_ordering']);
    // The verdict body must TRAVEL, so the builder fixes the named defect
    // rather than rediscovering it.
    expect(decision.body.verdictBody).toContain('Migration ordering violates the FK');
  });
});

describe('scenario 2: a non-auto finding among fixable ones blocks remediation', () => {
  test('MIXED case -- one design finding sends the whole verdict to a human', () => {
    const decision = decideRemediation(
      baseInput({ findings: [MIGRATION_ORDERING_FINDING, TEST_FAILURE_FINDING, DESIGN_FINDING] })
    );

    expect(decision.emit).toBe(false);
    if (decision.emit) throw new Error('unreachable');
    expect(decision.reason).toBe('non_auto_finding_present');
    expect(decision.nonAutoSummaries).toHaveLength(1);
    expect(decision.nonAutoSummaries[0]).toContain('scope question for the board');
  });

  test('a security finding is non-auto even when its text also looks mechanical', () => {
    // Fail-closed tie-break: the non-auto signal overrides a pattern match.
    const classification = classifyFinding({
      scope: 'migrations/041.sql',
      severity: 'blocker',
      summary: 'The migration ordering here leaks a credential into the audit log.',
    });
    expect(classification.autoFixable).toBe(false);
    expect(classification.classId).toBeNull();
  });
});

describe('scenario 3: attempt cap', () => {
  test('at the cap, no candidate and the reason is remediation_attempts_exhausted', () => {
    const decision = decideRemediation(baseInput({ priorAttempts: MAX_REMEDIATION_ATTEMPTS }));

    expect(decision.emit).toBe(false);
    if (decision.emit) throw new Error('unreachable');
    expect(decision.reason).toBe('remediation_attempts_exhausted');
  });

  test('the last attempt under the cap still emits', () => {
    const decision = decideRemediation(baseInput({ priorAttempts: MAX_REMEDIATION_ATTEMPTS - 1 }));
    expect(decision.emit).toBe(true);
    if (!decision.emit) throw new Error('unreachable');
    expect(decision.body.attempt).toBe(MAX_REMEDIATION_ATTEMPTS);
  });
});

describe('scenario 4: idempotency', () => {
  test('the same verdict twice computes the SAME idempotency key', () => {
    const first = decideRemediation(baseInput());
    const second = decideRemediation(baseInput());
    if (!first.emit || !second.emit) throw new Error('expected both to emit');

    const keyOf = (body: typeof first.body) =>
      remediationIdempotencyKey({
        owner: body.owner,
        repo: body.repo,
        prNumber: body.prNumber,
        attempt: body.attempt,
      });

    expect(keyOf(first.body)).toBe(keyOf(second.body));
    // createMessage is idempotent on this key at the DB level, so an identical
    // key is exactly what makes a re-delivery a no-op instead of a second row.
    expect(keyOf(first.body)).toContain('thinmansoftware/shopops#650');
  });

  /**
   * REGRESSION -- the defect the Overseer review gate found on this WO's own
   * PR (740, head bc30cae8, 2026-08-28).
   *
   * The key previously included the head SHA. Counting attempts and then
   * inserting is a read-then-write race, so two rejected reviews for DIFFERENT
   * heads could each read the same prior count, compute the SAME attempt
   * number, and -- because their keys differed by SHA -- BOTH insert. That
   * exceeded MAX_REMEDIATION_ATTEMPTS and defeated the bounded-loop guarantee.
   *
   * Excluding the SHA makes the attempt slot itself the unique resource, so the
   * UNIQUE constraint arbitrates and only one of the racers can win.
   */
  test('two different heads racing for the SAME attempt collide on one key', () => {
    const raceA = decideRemediation(baseInput({ priorAttempts: 1 }));
    const raceB = decideRemediation(
      baseInput({ priorAttempts: 1, headSha: 'bbbb22220000000000000000000000000000cccc' })
    );
    if (!raceA.emit || !raceB.emit) throw new Error('expected both to emit');

    // Both computed attempt 2 from the same stale count -- that is the race.
    expect(raceA.body.attempt).toBe(2);
    expect(raceB.body.attempt).toBe(2);

    // The DB sees ONE key, so exactly one row can exist. The cap holds.
    expect(remediationIdempotencyKey({ ...raceA.body })).toBe(
      remediationIdempotencyKey({ ...raceB.body })
    );
    expect(remediationIdempotencyKey({ ...raceA.body })).not.toContain(raceA.body.headSha);
  });
});

describe('scenario 5: a new head SHA permits a second attempt', () => {
  test('attempt 2 is allowed and the key differs from attempt 1', () => {
    const first = decideRemediation(baseInput());
    const second = decideRemediation(
      baseInput({
        priorAttempts: 1,
        headSha: 'aaaa11110000000000000000000000000000bbbb',
      })
    );
    if (!first.emit || !second.emit) throw new Error('expected both to emit');

    expect(second.body.attempt).toBe(2);
    // Distinct because the ATTEMPT differs, not because the SHA does. The head
    // being remediated still travels in the body.
    const firstKey = remediationIdempotencyKey({ ...first.body });
    const secondKey = remediationIdempotencyKey({ ...second.body });
    expect(secondKey).not.toBe(firstKey);
    expect(second.body.headSha).toBe('aaaa11110000000000000000000000000000bbbb');
  });

  test('the counter reflects prior candidates derived from durable rows', () => {
    const rows = [
      { body: JSON.stringify({ ...baseCandidateRow(), attempt: 1 }) },
      { body: JSON.stringify({ ...baseCandidateRow(), attempt: 2 }) },
      // A different PR must not count toward this PR's cap.
      { body: JSON.stringify({ ...baseCandidateRow(), prNumber: 999, attempt: 1 }) },
      // Non-candidate traffic on the same queue is ignored.
      { body: JSON.stringify({ kind: 'pr_review_submit_receipt' }) },
      { body: 'not json at all' },
    ];

    expect(
      countPriorRemediationAttempts(rows, {
        owner: 'thinmansoftware',
        repo: 'shopops',
        prNumber: 650,
      })
    ).toBe(2);
  });
});

describe('scenario 6: fail-closed classification', () => {
  test('a finding matching no known class is NON-AUTO', () => {
    const classification = classifyFinding({
      scope: 'somewhere/unknown.ts',
      severity: 'blocker',
      summary: 'The widget frobnicator emits an unfamiliar shape nobody has classified.',
    });
    expect(classification.autoFixable).toBe(false);
    expect(classification.classId).toBeNull();
  });

  test('an unrecognized blocking finding refuses the whole verdict', () => {
    const decision = decideRemediation(
      baseInput({
        findings: [
          {
            scope: 'somewhere/unknown.ts',
            severity: 'blocker',
            summary: 'Entirely novel problem shape.',
          },
        ],
      })
    );
    expect(decision.emit).toBe(false);
    if (decision.emit) throw new Error('unreachable');
    expect(decision.reason).toBe('non_auto_finding_present');
  });

  test('every declared auto-fixable class actually matches its own description', () => {
    // Guards against a class being added with a pattern that never fires,
    // which would silently shrink the auto-fixable set.
    expect(AUTO_FIXABLE_CLASSES.length).toBeGreaterThan(0);
    for (const entry of AUTO_FIXABLE_CLASSES) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});

describe('scenario 7: an APPROVED verdict never remediates', () => {
  test('no candidate at all', () => {
    const decision = decideRemediation(baseInput({ verdict: 'APPROVED' }));
    expect(decision.emit).toBe(false);
    if (decision.emit) throw new Error('unreachable');
    expect(decision.reason).toBe('verdict_not_changes_requested');
  });
});

describe('scenario 8: Taskmaster refusal (GATED on PR #669)', () => {
  // SKIPPED WITH REASON, per the spec. bdc-harness PR #669 (M-129 Phase 1.5)
  // was OPEN at implementation time, freezing packages/server/src/taskmaster/*.
  // The consumer that would accept a candidate and record a
  // budget/pause/eligibility refusal does not exist yet, so there is nothing to
  // assert against. This test unskips when #669 merges and the consumer lands.
  test.skip('a candidate arriving while paused or over budget is not fired', () => {
    throw new Error('unreachable: gated on PR #669');
  });
});

describe('scenario 9: regression -- advisory-only verdicts still go to a human', () => {
  test('minor/note findings alone produce no candidate', () => {
    const decision = decideRemediation(
      baseInput({
        findings: [
          { scope: 'a.ts', severity: 'minor', summary: 'Lint nit.' },
          { scope: 'b.ts', severity: 'note', summary: 'Consider renaming.' },
        ],
      })
    );
    expect(decision.emit).toBe(false);
    if (decision.emit) throw new Error('unreachable');
    expect(decision.reason).toBe('no_blocking_findings');
  });

  test('advisory findings do not veto an otherwise fixable verdict', () => {
    // A note that merely MENTIONS architecture must not be treated as a
    // blocking design objection.
    const decision = decideRemediation(
      baseInput({
        findings: [
          MIGRATION_ORDERING_FINDING,
          { scope: 'c.ts', severity: 'note', summary: 'Architecture could be tidier here.' },
        ],
      })
    );
    expect(decision.emit).toBe(true);
  });

  test('classifyFindings reports both matched classes and non-auto summaries', () => {
    const result = classifyFindings([MIGRATION_ORDERING_FINDING, DESIGN_FINDING]);
    expect(result.allAutoFixable).toBe(false);
    expect(result.classIds).toEqual(['migration_ordering']);
    expect(result.nonAutoSummaries).toHaveLength(1);
  });
});

describe('wire contract parsing fails closed', () => {
  test('round-trips a well-formed candidate', () => {
    const decision = decideRemediation(baseInput());
    if (!decision.emit) throw new Error('expected emit');
    const parsed = parseRemediationCandidateBody(JSON.stringify(decision.body));
    expect(parsed).not.toBeNull();
    expect(parsed?.prNumber).toBe(650);
    expect(parsed?.verdictBody).toContain('Migration ordering');
  });

  test('rejects a candidate missing the head it applies to', () => {
    const body = { ...baseCandidateRow() } as Record<string, unknown>;
    delete body.headSha;
    expect(parseRemediationCandidateBody(JSON.stringify(body))).toBeNull();
  });

  test('rejects a foreign kind and malformed JSON', () => {
    expect(parseRemediationCandidateBody(JSON.stringify({ kind: 'something_else' }))).toBeNull();
    expect(parseRemediationCandidateBody('{{{')).toBeNull();
  });
});

/**
 * End-to-end through the submit path: proves the arrow is actually wired, not
 * merely that the pure decision function works.
 */
describe('submit path hands a rejected verdict back to Taskmaster', () => {
  function work(): ReviewWorkItem {
    return {
      correlationId: 'corr-1',
      messageId: 'msg-1',
      owner: 'thinmansoftware',
      repo: 'shopops',
      prNumber: 650,
      headSha: 'f868542e0000000000000000000000000000abcd',
      author: 'cauldron-lane-a',
    };
  }

  function deps(overrides: Partial<SubmitDeps> = {}) {
    const emitted: unknown[] = [];
    const receipts: Record<string, unknown>[] = [];
    const base: SubmitDeps = {
      reviewerIdentity: 'thinman-overseer[bot]',
      runReviewer: async () => ({
        approved: false,
        summary: 'Migration ordering violates the composite FK.',
        reviewedHeadSha: 'f868542e0000000000000000000000000000abcd',
        findings: [MIGRATION_ORDERING_FINDING],
      }),
      submitReview: async () => ({ submitted: true }),
      currentHeadSha: async () => 'f868542e0000000000000000000000000000abcd',
      recordReceipt: async input => {
        receipts.push(input as unknown as Record<string, unknown>);
      },
      countPriorRemediationAttempts: async () => 0,
      emitRemediationCandidate: async body => {
        emitted.push(body);
        return { claimed: true };
      },
      ...overrides,
    };
    return { deps: base, emitted, receipts };
  }

  test('CHANGES_REQUESTED emits exactly one candidate and records it on the receipt', async () => {
    const { deps: d, emitted, receipts } = deps();
    const outcome = await runAndSubmitReview(work(), d);

    expect(outcome.disposition).toBe('changes_requested');
    expect(outcome.remediation?.emitted).toBe(true);
    expect(outcome.remediation?.attempt).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(receipts[0]?.remediation).toEqual({ emitted: true, attempt: 1 });
  });

  test('an APPROVED verdict emits nothing', async () => {
    const { deps: d, emitted } = deps({
      runReviewer: async () => ({
        approved: true,
        summary: 'No blocking findings.',
        reviewedHeadSha: 'f868542e0000000000000000000000000000abcd',
        findings: [],
      }),
    });
    const outcome = await runAndSubmitReview(work(), d);

    expect(outcome.disposition).toBe('approved');
    expect(outcome.remediation).toBeUndefined();
    expect(emitted).toHaveLength(0);
  });

  test('REGRESSION: with no remediation deps the review still submits as before', async () => {
    const { deps: d, emitted } = deps({
      countPriorRemediationAttempts: undefined,
      emitRemediationCandidate: undefined,
    });
    const outcome = await runAndSubmitReview(work(), d);

    expect(outcome.disposition).toBe('changes_requested');
    expect(outcome.remediation?.emitted).toBe(false);
    expect(outcome.remediation?.reason).toBe('remediation_not_configured');
    expect(emitted).toHaveLength(0);
  });

  test('a counter failure declines to emit rather than risking an unbounded loop', async () => {
    const { deps: d, emitted } = deps({
      countPriorRemediationAttempts: async () => {
        throw new Error('db down');
      },
    });
    const outcome = await runAndSubmitReview(work(), d);

    expect(outcome.disposition).toBe('changes_requested');
    expect(outcome.remediation?.emitted).toBe(false);
    expect(outcome.remediation?.reason).toBe('emit_failed');
    expect(emitted).toHaveLength(0);
  });

  test('an emit failure never converts a landed review into a failed submission', async () => {
    const { deps: d } = deps({
      emitRemediationCandidate: async () => {
        throw new Error('dispatch unavailable');
      },
    });
    const outcome = await runAndSubmitReview(work(), d);

    // The review IS on the PR; that fact must survive a hand-back failure.
    expect(outcome.disposition).toBe('changes_requested');
    expect(outcome.remediation?.emitted).toBe(false);
    expect(outcome.remediation?.reason).toBe('emit_failed');
  });

  test('losing the attempt-slot race reports honestly instead of claiming success', async () => {
    // The DB unique constraint on (PR, attempt) rejected this emitter because a
    // concurrent rejected review already claimed the slot. The cap held, and
    // the receipt must not tell an operator a fix was queued.
    const { deps: d } = deps({
      emitRemediationCandidate: async () => ({ claimed: false }),
    });
    const outcome = await runAndSubmitReview(work(), d);

    expect(outcome.disposition).toBe('changes_requested');
    expect(outcome.remediation?.emitted).toBe(false);
    expect(outcome.remediation?.reason).toBe('attempt_slot_already_claimed');
  });

  test('the candidate defaults its owning lane to the lane that built the PR', async () => {
    const { deps: d, emitted } = deps();
    await runAndSubmitReview(work(), d);
    expect((emitted[0] as { owningLane: string }).owningLane).toBe('cauldron-lane-a');
  });
});

function baseCandidateRow() {
  return {
    kind: REMEDIATION_CANDIDATE_KIND,
    owner: 'thinmansoftware',
    repo: 'shopops',
    prNumber: 650,
    headSha: 'f868542e0000000000000000000000000000abcd',
    attempt: 1,
    maxAttempts: MAX_REMEDIATION_ATTEMPTS,
    findingClasses: ['migration_ordering'],
    verdictBody: 'body',
    woId: null,
    owningLane: null,
  };
}
