/**
 * WO-HARNESS-OVERSEER-VERDICT-TO-TASKMASTER-REMEDIATION-01, Section 11.
 *
 * Scenarios 1-9 are all live; nothing in this file is skipped.
 *
 * Scenario 8 (Taskmaster refusal) is split across two packages by necessity.
 * The refusal is a property of the CONSUMER -- a candidate arriving while
 * Taskmaster is paused or over the per-item budget must not fire -- and it is
 * asserted against the REAL consumer (`tick` from
 * packages/server/src/taskmaster/loop.ts) in
 * packages/server/src/taskmaster/remediation-consumer.test.ts, Tests 3 and 4.
 *
 * It cannot be asserted here: the workspace dependency edge runs
 * server -> overseer only, so `@archon/server` does not resolve from
 * `@archon/overseer` (MODULE_NOT_FOUND) and this file cannot drive a tick.
 * Scenario 8 therefore proves the producer half from inside the overseer
 * boundary and ANCHORS the consumer-side coverage mechanically, so the
 * cross-package claim above fails loudly instead of rotting into a stale
 * comment.
 *
 * No mock.module anywhere: every dependency is injected, so these tests cannot
 * pollute the process-wide module cache for other files in the package.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IndependentReviewFinding } from '../independent-review-evidence.ts';
import {
  AUTO_FIXABLE_CLASSES,
  LEGACY_PATTERN_CLASSES,
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
    const decision = decideRemediation(baseInput(), LEGACY_PATTERN_CLASSES);

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
      baseInput({ findings: [MIGRATION_ORDERING_FINDING, TEST_FAILURE_FINDING, DESIGN_FINDING] }),
      LEGACY_PATTERN_CLASSES
    );

    expect(decision.emit).toBe(false);
    if (decision.emit) throw new Error('unreachable');
    expect(decision.reason).toBe('non_auto_finding_present');
    expect(decision.nonAutoSummaries).toHaveLength(1);
    expect(decision.nonAutoSummaries[0]).toContain('scope question for the board');
  });

  test('a security finding is non-auto even when its text also looks mechanical', () => {
    // Fail-closed tie-break: the non-auto signal overrides a pattern match.
    const classification = classifyFinding(
      {
        scope: 'migrations/041.sql',
        severity: 'blocker',
        summary: 'The migration ordering here leaks a credential into the audit log.',
      },
      LEGACY_PATTERN_CLASSES
    );
    expect(classification.autoFixable).toBe(false);
    expect(classification.classId).toBeNull();
  });
});

describe('scenario 3: attempt cap', () => {
  test('at the cap, no candidate and the reason is remediation_attempts_exhausted', () => {
    const decision = decideRemediation(
      baseInput({ priorAttempts: MAX_REMEDIATION_ATTEMPTS }),
      LEGACY_PATTERN_CLASSES
    );

    expect(decision.emit).toBe(false);
    if (decision.emit) throw new Error('unreachable');
    expect(decision.reason).toBe('remediation_attempts_exhausted');
  });

  test('the last attempt under the cap still emits', () => {
    const decision = decideRemediation(
      baseInput({ priorAttempts: MAX_REMEDIATION_ATTEMPTS - 1 }),
      LEGACY_PATTERN_CLASSES
    );
    expect(decision.emit).toBe(true);
    if (!decision.emit) throw new Error('unreachable');
    expect(decision.body.attempt).toBe(MAX_REMEDIATION_ATTEMPTS);
  });
});

describe('scenario 4: idempotency', () => {
  test('the same verdict twice computes the SAME idempotency key', () => {
    const first = decideRemediation(baseInput(), LEGACY_PATTERN_CLASSES);
    const second = decideRemediation(baseInput(), LEGACY_PATTERN_CLASSES);
    if (!first.emit || !second.emit) throw new Error('expected both to emit');

    const keyOf = (body: typeof first.body) =>
      remediationIdempotencyKey({
        owner: body.owner,
        repo: body.repo,
        prNumber: body.prNumber,
        headSha: body.headSha,
      });

    expect(keyOf(first.body)).toBe(keyOf(second.body));
    // createMessage is idempotent on this key at the DB level, so an identical
    // key is exactly what makes a re-delivery a no-op instead of a second row.
    expect(keyOf(first.body)).toContain('thinmansoftware/shopops#650');
  });

  /**
   * REGRESSION -- PR #740 round 3 [major] (2026-09-04). The key has now been
   * wrong twice in OPPOSITE directions, so both are pinned here.
   *
   * Round 1 keyed on (PR, head, attempt): two racers on different heads could
   * read the same count, compute the same attempt, and both insert -- the cap
   * was exceeded.
   *
   * Round 2 keyed on (PR, attempt), which fixed that race but broke
   * REDELIVERY: after attempt 1 lands the count returns 1, so replaying the
   * SAME verdict computed attempt 2, a different key, and a duplicate row.
   *
   * Keying on the HEAD SHA satisfies both, because the head identifies the
   * verdict. Redelivery is a no-op; a genuinely new head is a new slot; the cap
   * is enforced by decideRemediation, not by key collision.
   */
  test('the key is the ATTEMPT SLOT, which is the scarce resource the cap needs', () => {
    const slotOne = remediationIdempotencyKey({
      owner: 'thinmansoftware',
      repo: 'shopops',
      prNumber: 650,
      attempt: 1,
    });
    const slotTwo = remediationIdempotencyKey({
      owner: 'thinmansoftware',
      repo: 'shopops',
      prNumber: 650,
      attempt: 2,
    });

    expect(slotOne).not.toBe(slotTwo);
    expect(slotOne).toContain('thinmansoftware/shopops#650');
    // The head must NOT appear: folding it in gives every head its own key,
    // which is how rounds 1 and 3 unbounded the loop. Redelivery is settled in
    // emitRemediationCandidate by comparing heads BEFORE the insert, not here.
    expect(slotOne).not.toContain('f868542e');
  });

  test('the cap refuses once the count reaches it, whatever the head', () => {
    const third = decideRemediation(
      baseInput({ priorAttempts: MAX_REMEDIATION_ATTEMPTS, headSha: 'cccc3333' }),
      LEGACY_PATTERN_CLASSES
    );
    expect(third.emit).toBe(false);
    if (third.emit) throw new Error('unreachable');
    expect(third.reason).toBe('remediation_attempts_exhausted');
  });
});

describe('scenario 5: a new head SHA permits a second attempt', () => {
  test('attempt 2 is allowed and the key differs from attempt 1', () => {
    const first = decideRemediation(baseInput(), LEGACY_PATTERN_CLASSES);
    const second = decideRemediation(
      baseInput({
        priorAttempts: 1,
        headSha: 'aaaa11110000000000000000000000000000bbbb',
      }),
      LEGACY_PATTERN_CLASSES
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

/**
 * REGRESSION -- PR #740 [major] (2026-09-04). The Overseer gate found that the
 * fail-closed security boundary was really a keyword blocklist, and that a
 * security-sensitive finding phrased without any of those keywords would be
 * auto-routed for unattended remediation.
 *
 * The root cause was pattern breadth, not a missing keyword: `test_failure`
 * matched "the word test ... then a failure word anywhere after it", which
 * swallowed coverage-gap phrasings. A MISSING test is a judgment call (deciding
 * what it should assert requires knowing what the code ought to do); a FAILING
 * test is mechanical (the runner already named the broken assertion). The
 * classes now require observed failure, so coverage gaps fall through to the
 * fail-closed default and reach a human regardless of wording.
 *
 * A blocklist cannot enumerate every phrasing, so these cases deliberately omit
 * the security keywords entirely -- they must be HUMAN on pattern shape alone.
 */
describe('regression: security-shaped findings never auto-route (PR #740 major)', () => {
  const mustBeHuman: readonly {
    readonly label: string;
    readonly finding: IndependentReviewFinding;
  }[] = [
    {
      label: "the reviewer's own counterexample",
      finding: {
        scope: 'packages/api/src/query.ts',
        severity: 'blocker',
        summary: 'Missing test for a query that concatenates user input',
      },
    },
    {
      label: 'SQL-injection shaped, no security keyword',
      finding: {
        scope: 'src/db.ts',
        severity: 'blocker',
        summary: 'No test covers the string-built WHERE clause from request params',
      },
    },
    {
      label: 'XSS shaped, no security keyword',
      finding: {
        scope: 'src/render.ts',
        severity: 'blocker',
        summary: 'Test missing for unescaped user content rendered into the page',
      },
    },
    {
      label: 'a plain coverage gap is a judgment call, not a mechanical fix',
      finding: {
        scope: 'src/a.ts',
        severity: 'blocker',
        summary: 'Missing test for the new branch',
      },
    },
  ];

  for (const { label, finding } of mustBeHuman) {
    test(`NON-AUTO: ${label}`, () => {
      expect(classifyFinding(finding, LEGACY_PATTERN_CLASSES).autoFixable).toBe(false);
    });
  }

  test('a verdict containing one of these emits NO candidate', () => {
    const decision = decideRemediation(
      baseInput({ findings: [mustBeHuman[2]!.finding] }),
      LEGACY_PATTERN_CLASSES
    );
    expect(decision.emit).toBe(false);
    if (decision.emit) throw new Error('unreachable');
    expect(decision.reason).toBe('non_auto_finding_present');
  });

  /**
   * The other half of the fix: narrowing must not break the mechanical cases,
   * and above all not the live shopops#650 anchor this whole WO exists for.
   * An earlier attempt at this fix DID break it -- a bare `sql` token in the
   * non-auto list matched the `.sql` extension of the migration filename.
   */
  /**
   * PR #740 round 3 [major], second half: the mechanical-evidence rule was
   * applied to build_failure and test_failure but NOT to the other three
   * classes, so lint_or_format still matched any mention of "format" or
   * "style". The gate's example -- "The API response format exposes internal
   * identifiers" -- is a security judgment and it classified as auto-fixable.
   *
   * Auditing the remaining classes for the same flaw found two more, which are
   * covered here too: a Unicode RENDERING bug read as an ascii_violation, and
   * "this migration should be redesigned" read as migration_ordering.
   */
  const overBroadCases: readonly { readonly label: string; readonly summary: string }[] = [
    {
      label: 'the gate example: response format is a security judgment',
      summary: 'The API response format exposes internal identifiers',
    },
    {
      label: '"format" as customer-visible behavior',
      summary: 'The date format shown to customers is wrong',
    },
    { label: '"format" as data shape', summary: 'The CSV format drops the trailing column' },
    {
      label: 'Unicode RENDERING bug, not an encoding violation',
      summary: 'Unicode names render incorrectly for customers',
    },
    {
      label: 'migration REDESIGN is a judgment call',
      summary: 'This migration should run after the tenant backfill is redesigned',
    },
  ];

  for (const { label, summary } of overBroadCases) {
    test(`NON-AUTO: ${label}`, () => {
      expect(
        classifyFinding({ scope: 'src/x.ts', severity: 'blocker', summary }, LEGACY_PATTERN_CLASSES)
          .autoFixable
      ).toBe(false);
    });
  }

  /**
   * REGRESSION -- PR #740 round 6 [major] (2026-10-05). Classes were matched
   * against `scope + summary`, so a FILE PATH could authorize automation: scope
   * 'src/black.ts' with a data-disclosure summary matched lint_or_format
   * through the filename and bypassed the non-auto override entirely.
   *
   * Two changes: classes are matched against the SUMMARY alone (the scope is a
   * path, not a description of the defect), and a tool NAME now has to come
   * with observed failure evidence -- 'black' and 'ruff' are ordinary English
   * words and real filenames.
   *
   * The non-auto override still reads scope AND summary: widening what can
   * REFUSE is safe, widening what can APPROVE is not.
   */
  const filenameBypassCases: readonly {
    readonly label: string;
    readonly finding: IndependentReviewFinding;
  }[] = [
    {
      label: "the gate's example -- disclosure finding in src/black.ts",
      finding: {
        scope: 'src/black.ts',
        severity: 'blocker',
        summary: "Endpoint returns every customer's invoices to any caller",
      },
    },
    {
      label: 'a path named after ruff',
      finding: {
        scope: 'src/ruff.ts',
        severity: 'blocker',
        summary: 'Endpoint leaks other tenants rows',
      },
    },
    {
      label: 'a directory named lint',
      finding: {
        scope: 'packages/linter-config/src/a.ts',
        severity: 'blocker',
        summary: 'Returns all users to an unauthenticated caller',
      },
    },
    {
      // Proves the SCOPE/SUMMARY SPLIT specifically: the path carries the
      // failure evidence, so a concatenated match would classify this as a
      // genuine lint failure even with the narrowed pattern.
      label: 'failure words in the PATH, judgment call in the summary',
      finding: {
        scope: 'ci/eslint-failures/report.ts',
        severity: 'blocker',
        summary: 'Returns every tenant invoice to any caller',
      },
    },
    {
      label: 'a tool named in passing, with no failure',
      finding: {
        scope: 'src/a.ts',
        severity: 'blocker',
        summary: 'We should make the output prettier for operators',
      },
    },
  ];

  for (const { label, finding } of filenameBypassCases) {
    test(`NON-AUTO: ${label}`, () => {
      expect(classifyFinding(finding, LEGACY_PATTERN_CLASSES).autoFixable).toBe(false);
    });
  }

  /**
   * REGRESSION -- PR #740 round 7 [major] (2026-10-05). ascii_violation kept a
   * BARE first alternative -- /(?:non-ascii|ascii-only)/ with no failure
   * requirement -- so any finding that merely said "Non-ASCII" classified as
   * auto-fixable. The gate's example is a data-disclosure defect:
   * "Non-ASCII tenant names collide, allowing one customer to read another
   * customer's invoices".
   *
   * I had applied the mechanical-evidence rule to the second half of that
   * pattern and left the first half open. Every alternative in every class must
   * carry evidence; a topic mention is not a defect report.
   *
   * After fixing it I audited all five classes with security/behavioral
   * payloads attached to each class's own topic words. None bypasses now -- see
   * the structural audit in the commit message.
   */
  const bareMentionCases: readonly { readonly label: string; readonly summary: string }[] = [
    {
      label: "the gate's example -- non-ASCII collision causing disclosure",
      summary:
        "Non-ASCII tenant names collide, allowing one customer to read another customer's invoices",
    },
    {
      label: 'non-ASCII as a BEHAVIORAL bug, not an encoding-rule violation',
      summary: 'Non-ASCII customer names sort incorrectly in the picker',
    },
    {
      label: 'the ascii-only rule merely MENTIONED, with no failure',
      summary: 'The ascii-only convention should be documented for contributors',
    },
  ];

  for (const { label, summary } of bareMentionCases) {
    test(`NON-AUTO: ${label}`, () => {
      expect(
        classifyFinding(
          { scope: 'src/tenants.ts', severity: 'blocker', summary },
          LEGACY_PATTERN_CLASSES
        ).autoFixable
      ).toBe(false);
    });
  }

  test('a REAL encoding-rule violation still auto-routes', () => {
    for (const summary of [
      'Non-ASCII em-dash breaks PowerShell parsing',
      'The file violates the ascii-only rule and fails the gate',
    ]) {
      const result = classifyFinding(
        { scope: 'scripts/x.ps1', severity: 'blocker', summary },
        LEGACY_PATTERN_CLASSES
      );
      expect(result.autoFixable, summary).toBe(true);
      expect(result.classId, summary).toBe('ascii_violation');
    }
  });

  /**
   * REGRESSION -- PR #740 round 8 [major] (2026-10-05), and the STRUCTURAL fix
   * for a defect class the gate found five rounds running.
   *
   * Each of these uses a class's own topic word AND its own evidence word while
   * describing a data-disclosure defect, and none contains a NON_AUTO_PATTERN
   * keyword. Narrowing class patterns one at a time was losing a race against
   * phrasing, so NON_AUTO_IMPACT_PATTERN now vetoes on the CONSEQUENCE shape:
   * a mechanical defect's consequence is a red tool, while a consequence to
   * data or to another party is impact, which a human must weigh.
   *
   * The first case is the one the gate reported; the other four I found by
   * auditing every class for the same shape rather than waiting to be told.
   */
  const impactConsequenceCases: readonly { readonly label: string; readonly summary: string }[] = [
    {
      label: "the gate's example -- unicode normalization breaks tenant isolation",
      summary:
        "Unicode normalization breaks tenant isolation, allowing one customer to read another customer's invoices",
    },
    {
      label: 'build_failure shape with a disclosure consequence',
      summary:
        'The tenant-id type check fails to stop one customer reading another customer invoices',
    },
    {
      label: 'test_failure shape with a disclosure consequence',
      summary: 'The tenant isolation test fails to cover cross-customer invoice reads',
    },
    {
      label: 'lint_or_format shape with a disclosure consequence',
      summary: 'eslint reports the rule is disabled where we leak invoices to any caller',
    },
    {
      label: 'migration_ordering shape with a disclosure consequence',
      summary: 'The migration foreign key constraint fails to isolate tenants, exposing invoices',
    },
  ];

  for (const { label, summary } of impactConsequenceCases) {
    test(`NON-AUTO: ${label}`, () => {
      expect(
        classifyFinding(
          { scope: 'src/tenants.ts', severity: 'blocker', summary },
          LEGACY_PATTERN_CLASSES
        ).autoFixable
      ).toBe(false);
    });

    test(`emits NO candidate: ${label}`, () => {
      const decision = decideRemediation(
        baseInput({
          findings: [{ scope: 'src/tenants.ts', severity: 'blocker', summary }],
        }),
        LEGACY_PATTERN_CLASSES
      );
      expect(decision.emit).toBe(false);
    });
  }

  test('the real tool-reported versions of those classes DO auto-route', () => {
    const mechanical: readonly [string, string, string][] = [
      ['named linter', 'eslint reports 3 errors: prefer-const', 'lint_or_format'],
      ['named formatter', 'prettier --check fails on this file', 'lint_or_format'],
      ['ascii rule broken', 'Non-ASCII em-dash breaks PowerShell parsing', 'ascii_violation'],
    ];
    for (const [label, summary, expectedClass] of mechanical) {
      const result = classifyFinding(
        { scope: 'src/x.ts', severity: 'blocker', summary },
        LEGACY_PATTERN_CLASSES
      );
      expect(result.autoFixable, label).toBe(true);
      expect(result.classId, label).toBe(expectedClass);
    }
  });

  test('genuinely mechanical findings still auto-route', () => {
    const mechanical: readonly [string, IndependentReviewFinding, string][] = [
      [
        'observed failing tests',
        {
          scope: 'packages/core/src/x.test.ts',
          severity: 'major',
          summary: 'Two tests fail against the new column name',
        },
        'test_failure',
      ],
      [
        'build error',
        {
          scope: 'src/y.ts',
          severity: 'blocker',
          summary: 'The build fails: tsc reports an error on line 40',
        },
        'build_failure',
      ],
      ['the live shopops#650 anchor', MIGRATION_ORDERING_FINDING, 'migration_ordering'],
    ];
    for (const [label, finding, expectedClass] of mechanical) {
      const result = classifyFinding(finding, LEGACY_PATTERN_CLASSES);
      expect(result.autoFixable, `${label} must stay auto-fixable`).toBe(true);
      expect(result.classId, label).toBe(expectedClass);
    }
  });
});

describe('scenario 6: fail-closed classification', () => {
  test('a finding matching no known class is NON-AUTO', () => {
    const classification = classifyFinding(
      {
        scope: 'somewhere/unknown.ts',
        severity: 'blocker',
        summary: 'The widget frobnicator emits an unfamiliar shape nobody has classified.',
      },
      LEGACY_PATTERN_CLASSES
    );
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
      }),
      LEGACY_PATTERN_CLASSES
    );
    expect(decision.emit).toBe(false);
    if (decision.emit) throw new Error('unreachable');
    expect(decision.reason).toBe('non_auto_finding_present');
  });

  test('every declared auto-fixable class actually matches its own description', () => {
    // Guards against a class being added with a pattern that never fires,
    // which would silently shrink the auto-fixable set.
    expect(LEGACY_PATTERN_CLASSES.length).toBeGreaterThan(0);
    for (const entry of LEGACY_PATTERN_CLASSES) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});

describe('scenario 7: an APPROVED verdict never remediates', () => {
  test('no candidate at all', () => {
    const decision = decideRemediation(baseInput({ verdict: 'APPROVED' }), LEGACY_PATTERN_CLASSES);
    expect(decision.emit).toBe(false);
    if (decision.emit) throw new Error('unreachable');
    expect(decision.reason).toBe('verdict_not_changes_requested');
  });
});

describe('scenario 8: Taskmaster refusal (consumer present)', () => {
  // UNSKIPPED by WO-HARNESS-TASKMASTER-REMEDIATION-CONSUMER-01: the Taskmaster
  // consumer now exists and reads `overseer_remediation_candidate` rows.
  //
  // Scenario 8 has two halves, in the only two places each can live:
  //
  //   1. PRODUCER half (here): a CHANGES_REQUESTED verdict is handed back as an
  //      INERT candidate -- a row Taskmaster reads and gates, never an action
  //      Overseer fires itself -- and that row is exactly what the consumer's
  //      own parser accepts.
  //   2. CONSUMER half (packages/server): the tick-level refusal itself, driven
  //      against the real `tick`. @archon/overseer cannot assert it, because
  //      the workspace dependency edge runs server -> overseer only and
  //      `@archon/server` does not resolve from here.
  //
  // The second test below ANCHORS half 2. Without it, half 2 would be a prose
  // claim in a comment: if those consumer tests were deleted, renamed, or
  // quietly re-pointed at a fake tick, this file would keep asserting the
  // producer half and nothing would notice the refusal had stopped being
  // covered. The anchor makes that failure loud and local.
  test('a CHANGES_REQUESTED verdict is handed back as an inert, consumer-readable candidate', () => {
    const decision = decideRemediation(baseInput(), LEGACY_PATTERN_CLASSES);

    // Overseer emits a candidate; it does not fire or escalate anything itself.
    expect(decision.emit).toBe(true);
    if (!decision.emit) throw new Error('unreachable');

    // The candidate is inert data of the agreed wire kind -- not an executable
    // directive -- so Taskmaster's gates, not Overseer, decide what happens.
    expect(decision.body.kind).toBe(REMEDIATION_CANDIDATE_KIND);
    expect(decision.body.attempt).toBeLessThanOrEqual(decision.body.maxAttempts);

    // The consumer reads candidates through parseRemediationCandidateBody; the
    // emitted body must round-trip through that exact parser, carrying every
    // field the gated consumer needs to refuse-and-redeliver.
    const parsed = parseRemediationCandidateBody(JSON.stringify(decision.body));
    expect(parsed).not.toBeNull();
    expect(parsed?.prNumber).toBe(decision.body.prNumber);
    expect(parsed?.headSha).toBe(decision.body.headSha);
    expect(parsed?.attempt).toBe(decision.body.attempt);
    expect(parsed?.verdictBody).toBe(decision.body.verdictBody);
  });

  // Anchors half 2. This READS the consumer test rather than importing it:
  // importing @archon/server from @archon/overseer would invert the workspace
  // dependency edge and does not resolve (MODULE_NOT_FOUND).
  test('the consumer-side paused/over-budget refusal exists and drives the real tick', () => {
    const consumerTestPath = resolve(
      import.meta.dir,
      '../../../server/src/taskmaster/remediation-consumer.test.ts'
    );

    let source: string;
    try {
      source = readFileSync(consumerTestPath, 'utf8');
    } catch {
      throw new Error(
        "Scenario 8's consumer half is missing: expected the Taskmaster paused/" +
          `over-budget refusal tests at ${consumerTestPath}. If that file moved, ` +
          'repoint this anchor; if the coverage was dropped, restore it -- the ' +
          'refusal is only assertable from @archon/server.'
      );
    }

    // It must exercise the REAL consumer: a bare `tick` specifier imported from
    // './loop'. Checked by specifier, not substring, so an aliased stand-in
    // (`tick as fakeTick`) or a local reimplementation does not satisfy it.
    const loopImport = source.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/loop'/);
    expect(loopImport).not.toBeNull();
    const specifiers = (loopImport?.[1] ?? '').split(',').map(entry => entry.trim());
    expect(specifiers).toContain('tick');

    // Test 3 drives the paused refusal through the real control state.
    expect(source).toContain("pause_state = 'PAUSED'");

    // Test 4 drives the over-budget refusal through the real per-item cap.
    expect(source).toContain('MAX_INTERVENTIONS_PER_ITEM_24H');

    // Both refusals must leave the candidate unconsumed for a later tick,
    // which is what makes the refusal a deferral rather than a silent drop.
    expect(source).toContain('consumeCalls).toEqual([])');
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
      }),
      LEGACY_PATTERN_CLASSES
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
      }),
      LEGACY_PATTERN_CLASSES
    );
    expect(decision.emit).toBe(true);
  });

  test('classifyFindings reports both matched classes and non-auto summaries', () => {
    const result = classifyFindings(
      [MIGRATION_ORDERING_FINDING, DESIGN_FINDING],
      LEGACY_PATTERN_CLASSES
    );
    expect(result.allAutoFixable).toBe(false);
    expect(result.classIds).toEqual(['migration_ordering']);
    expect(result.nonAutoSummaries).toHaveLength(1);
  });
});

describe('wire contract parsing fails closed', () => {
  test('round-trips a well-formed candidate', () => {
    const decision = decideRemediation(baseInput(), LEGACY_PATTERN_CLASSES);
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

  /**
   * REGRESSION -- PR #740 round 6 [minor] (2026-10-05). Splitting the approved
   * branch out of the shared terminal return dropped `...summaryField(verdict)`
   * from it, silently removing the reviewer's text from every successful
   * approval outcome. #782 added that field so the same-head recheck path can
   * tell a CHECK-caused verdict from a CODE finding, and the worker persists the
   * outcome as result_body -- so losing it is a contract change, not cosmetic.
   *
   * Unaffected by the classifier being disarmed: this is the APPROVED path.
   */
  test('an APPROVED outcome still carries the reviewer summary', async () => {
    const { deps: d } = deps({
      runReviewer: async () => ({
        approved: true,
        summary: 'No blocking findings. Checks green at this head.',
        reviewedHeadSha: 'f868542e0000000000000000000000000000abcd',
        findings: [],
      }),
    });
    const outcome = await runAndSubmitReview(work(), d);

    expect(outcome.disposition).toBe('approved');
    expect(outcome.summary).toBe('No blocking findings. Checks green at this head.');
  });

  /**
   * REGRESSION -- the counter must still fail closed. A hand-back that cannot
   * prove it is under the cap must not emit, because an unbounded
   * reviewer-fix-reviewer loop is the failure this WO must not create. Reachable
   * while disarmed because it short-circuits before classification.
   */
  test('a counter failure declines to emit rather than risking an unbounded loop', async () => {
    const { deps: d, emitted } = deps({
      countPriorRemediationAttempts: async () => {
        throw new Error('db down');
      },
    });
    const outcome = await runAndSubmitReview(work(), d);

    expect(outcome.disposition).toBe('changes_requested');
    expect(outcome.remediation?.emitted).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  /**
   * REGRESSION -- with the optional remediation deps absent the review path must
   * behave exactly as it did before this WO existed.
   */
  test('with no remediation deps the review still submits as before', async () => {
    const { deps: d, emitted } = deps({
      countPriorRemediationAttempts: undefined,
      emitRemediationCandidate: undefined,
    });
    const outcome = await runAndSubmitReview(work(), d);

    expect(outcome.disposition).toBe('changes_requested');
    expect(outcome.remediation?.reason).toBe('remediation_not_configured');
    expect(emitted).toHaveLength(0);
  });

  /**
   * PRODUCTION IS DISARMED, and that is the behavior under test here.
   *
   * AUTO_FIXABLE_CLASSES ships EMPTY (see the comment on it), so no finding is
   * eligible and the hand-back never fires. runAndSubmitReview reaches
   * handBackToTaskmaster through the real production path -- it cannot be given
   * an injected class table -- so these assertions describe what actually
   * happens today: the review lands, and the verdict goes to a human.
   *
   * The four tests that previously asserted a candidate WAS emitted (receipt
   * shape, emit-failure degradation, lost-slot reporting, owningLane default)
   * were asserting behavior that is correct in the MECHANISM but unreachable
   * while the table is empty. Their coverage of the mechanism now lives in the
   * fixture-injected tests above, which exercise decideRemediation directly.
   * When a structured eligibility signal lands, restore the end-to-end
   * assertions here.
   */
  test('with no eligible classes the review lands and NOTHING is handed back', async () => {
    const { deps: d, emitted, receipts } = deps();
    const outcome = await runAndSubmitReview(work(), d);

    // The review itself is unaffected -- it is on the PR.
    expect(outcome.disposition).toBe('changes_requested');
    // And no builder was told to do anything.
    expect(outcome.remediation?.emitted).toBe(false);
    expect(emitted).toHaveLength(0);
    expect((receipts[0]?.remediation as { emitted: boolean }).emitted).toBe(false);
  });

  test('the hand-back is still WIRED, so re-arming needs no plumbing change', async () => {
    // Proves the seam is intact rather than removed: a verdict whose findings
    // ARE eligible under an injected table still produces a candidate body with
    // the PR ref, the head, and the owning lane. Only AUTO_FIXABLE_CLASSES
    // stands between this and a live hand-back.
    const decision = decideRemediation(
      {
        owner: 'thinmansoftware',
        repo: 'shopops',
        prNumber: 650,
        headSha: 'f868542e0000000000000000000000000000abcd',
        verdict: 'CHANGES_REQUESTED',
        findings: [MIGRATION_ORDERING_FINDING],
        verdictBody: 'Independent review at head f868542e.',
        priorAttempts: 0,
        owningLane: 'cauldron-lane-a',
      },
      LEGACY_PATTERN_CLASSES
    );

    expect(decision.emit).toBe(true);
    if (!decision.emit) throw new Error('unreachable');
    expect(decision.body.prNumber).toBe(650);
    expect(decision.body.headSha).toBe('f868542e0000000000000000000000000000abcd');
    expect(decision.body.owningLane).toBe('cauldron-lane-a');
    expect(decision.body.findingClasses).toEqual(['migration_ordering']);
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
