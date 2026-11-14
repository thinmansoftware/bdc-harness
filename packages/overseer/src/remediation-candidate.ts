/**
 * Overseer verdict -> Taskmaster remediation candidate
 * (WO-HARNESS-OVERSEER-VERDICT-TO-TASKMASTER-REMEDIATION-01).
 *
 * THE GAP THIS CLOSES. The Review Gate's first unassisted review
 * (shopops#650, head f868542e, 2026-08-28) found a real defect -- a backfill
 * migration updating a parent's tenant_id before its child rows, which a
 * composite FK (case_id, tenant_id) rejects -- refused the PR correctly, and
 * then stopped. It escalated to an operator card and nothing else happened.
 * Zero dispatch messages, zero runs, no builder was told to fix anything. The
 * wheel was build -> review -> [GAP] -> merge -> deploy. This module is the
 * missing arrow.
 *
 * DIVISION OF LABOR (ruled by John, 2026-08-28): "Overseer's job is to give it
 * back to Taskmaster." Overseer JUDGES and HANDS BACK; Taskmaster DECIDES what
 * work actually fires. Nothing in this module spawns, refires, or schedules a
 * builder -- it writes a PROPOSAL onto the EXISTING `agent_dispatch_messages`
 * seam that Taskmaster already reads. Taskmaster's lane budget, pause state,
 * backoff, and fire-eligibility all still govern and may refuse the candidate.
 * That refusal is a correct outcome, not a failure of this path.
 *
 * WHY NO NEW TRANSPORT. Overseer already writes `agent_dispatch_messages` via
 * createMessage (see pr-review-wiring.ts) and Taskmaster already reads that
 * table (packages/server/src/taskmaster/loop.ts). What was missing was a
 * message class and a proposal type, not plumbing.
 */
import type { IndependentReviewFinding } from './independent-review-evidence.ts';

/**
 * Cap on remediation attempts per pull request. A reviewer-fix-reviewer loop
 * burning lane budget unattended is the specific failure this WO must not
 * create, so the bound is small and enforced before any candidate is built.
 */
export const MAX_REMEDIATION_ATTEMPTS = 2;

/**
 * Dispatch principals for the remediation hand-back.
 *
 * REMEDIATION_SENDER is the AUTHENTICATED sender, and it must stay equal to
 * what the emitter actually binds. M-129 Phase 1.5 (PR #669) replaced the
 * unauthenticated createMessage with createAuthenticatedMessage, whose
 * bindSenderContext admits exactly three system senders -- 'dispatch',
 * 'overseer', 'taskmaster'. 'overseer-review-route' is NOT among them, so the
 * emitter binds 'overseer'.
 *
 * This constant previously still said 'overseer-review-route', which made the
 * documented wire contract and the integration test that asserted on it both
 * inaccurate -- the test seeded and checked a principal that was never the
 * sender (PR #740 [minor], 2026-09-04). It now names the real one.
 */
export const REMEDIATION_SENDER = 'overseer';
export const REMEDIATION_RECIPIENT = 'taskmaster';

/**
 * Marks a dispatch body as a remediation candidate. Taskmaster's consumer
 * discriminates on this exact string; it is part of the wire contract and must
 * not be renamed without changing the consumer in lockstep.
 */
export const REMEDIATION_CANDIDATE_KIND = 'overseer_remediation_candidate' as const;

/**
 * Why a verdict did NOT become a remediation candidate. Carried onto the
 * operator card so a human reading the escalation knows whether the machine
 * declined to auto-fix (and why) or simply had nothing to hand back.
 */
export type RemediationRefusalReason =
  | 'verdict_not_changes_requested'
  | 'non_auto_finding_present'
  | 'no_blocking_findings'
  | 'remediation_attempts_exhausted';

/**
 * Prose classification stays disabled. Eligibility comes only from the
 * reviewer's validated per-finding remediation signal, after both vetoes.
 * Do not repopulate this table with regexes (PR #740; bdc-xo#2974).
 */
export const AUTO_FIXABLE_CLASSES: readonly never[] = [];

/**
 * Findings that must NEVER be auto-remediated, regardless of whether their text
 * carries a mechanical remediation signal.
 *
 * DEFENSE IN DEPTH, NOT THE BOUNDARY. This is an OVERRIDE checked FIRST in
 * classifyFinding, so "the migration ordering here is a security concern" is
 * non-auto even if the reviewer marked it mechanical.
 *
 * A blocklist cannot enumerate every security judgment. The primary gate is
 * the reviewer's explicit mechanical signal; these vetoes can only refuse.
 * Missing or invalid eligibility always routes to a human.
 *
 * NOTE ON PRECISION: a bare `sql` token is deliberately NOT listed. It matched
 * the `.sql` extension of the migration filename in the live shopops#650
 * anchor and sent the WO's own reference case to a human. `sql injection` is
 * the security signal; a `.sql` file is just a file.
 */
const NON_AUTO_PATTERN =
  /\b(?:securit\w*|vulnerab\w*|auth\w*|credential\w*|secret\w*|injection|inject(?:s|ed|ing)?|escap\w*|sanitiz\w*|sanitis\w*|xss|csrf|ssrf|rce|traversal|untrusted|user[-\s]input|request\s+param\w*|design|architect\w*|scope|governance|policy|approv\w*|judgment|judgement|intent|breaking\s+change|data\s+loss|privacy|pii)\b/i;

/**
 * SECOND VETO: a described CONSEQUENCE, not a vocabulary match.
 *
 * WHY A SECOND ONE EXISTS. NON_AUTO_PATTERN is a keyword list, and a keyword
 * list cannot enumerate every way to describe a security defect. The review
 * gate demonstrated that five rounds running on this PR, each time with a
 * finding that used a MECHANICAL topic word plus a MECHANICAL evidence word
 * while describing a data-disclosure defect:
 *
 *   "Unicode normalization breaks tenant isolation, allowing one customer to
 *    read another customer's invoices"        -> matched ascii_violation
 *   "The tenant-id type check fails to stop one customer reading another
 *    customer invoices"                       -> matched build_failure
 *   "The tenant isolation test fails to cover cross-customer invoice reads"
 *                                             -> matched test_failure
 *   "The migration foreign key constraint fails to isolate tenants, exposing
 *    invoices"                                -> matched migration_ordering
 *
 * None of those contain a NON_AUTO_PATTERN word. Narrowing the class patterns
 * one at a time was losing a race against phrasing.
 *
 * THE STRUCTURAL DISTINCTION. A genuinely mechanical defect's consequence is a
 * RED TOOL: the build fails, the suite fails, the linter objects, the migration
 * is rejected by a constraint. A finding that instead describes a consequence
 * TO DATA OR TO ANOTHER PARTY -- somebody can read something, something is
 * exposed or leaked, a boundary between tenants or customers fails -- is
 * reasoning about impact, and impact is exactly what a human must weigh.
 *
 * So this vetoes on CONSEQUENCE SHAPE rather than on topic vocabulary, which is
 * why it catches phrasings no keyword list anticipated. It can only ever
 * REFUSE, never approve, so a false positive costs one unnecessary human
 * review while a false negative hands a disclosure defect to an unattended
 * builder. That asymmetry is the whole reason it is deliberately broad.
 */
const NON_AUTO_IMPACT_PATTERN = new RegExp(
  [
    // Cross-party access: "one customer ... another customer", "other tenants".
    String.raw`\b(?:another|other|different|cross)[-\s](?:customer|tenant|user|account|org|organisation|organization|company)`,
    String.raw`\b(?:customer|tenant|user|account|org)s?\b[\s\S]{0,60}?\b(?:read|access|see|view|retrieve|download|modify)\b[\s\S]{0,60}?\b(?:another|other|each\s+other)`,
    // Isolation or boundary failure.
    String.raw`\b(?:tenant|customer|account|data|privilege|trust|security)[-\s](?:isolation|boundary|separation|segregation)`,
    String.raw`\b(?:isolation|boundary|separation|segregation)\b[\s\S]{0,40}?\b(?:break\w*|fail\w*|bypass\w*|violat\w*|lost|broken)`,
    // Exposure or leakage of data.
    String.raw`\b(?:expos\w*|leak\w*|disclos\w*|reveal\w*)\b[\s\S]{0,60}?\b(?:invoice|customer|tenant|user|account|record|row|data|secret|token|password|identifier|hostname|path)`,
    String.raw`\b(?:invoice|customer|tenant|record|row|datum|data)s?\b[\s\S]{0,40}?\b(?:expos\w*|leak\w*|disclos\w*|reveal\w*)`,
    // Unauthenticated or arbitrary access.
    String.raw`\b(?:any|every|unauthenticated|anonymous|arbitrary)\s+(?:caller|user|client|requester|visitor)`,
    String.raw`\b(?:all|every)\s+(?:customer|tenant|user|account|invoice|record)s?\b[\s\S]{0,40}?\b(?:read|returned?|accessible|exposed|listed)`,
  ].join('|'),
  'i'
);

/** Severities that block a merge and therefore justify remediation work. */
const BLOCKING_SEVERITIES: ReadonlySet<IndependentReviewFinding['severity']> = new Set([
  'blocker',
  'major',
]);

export interface FindingClassification {
  readonly autoFixable: boolean;
  /** The matched class id when autoFixable; null otherwise. */
  readonly classId: string | null;
}

/**
 * Classify ONE finding.
 *
 * Order is load-bearing and fails closed at every branch:
 *   1. A non-auto signal anywhere in the finding wins outright.
 *   2. Otherwise, the reviewer must explicitly mark the finding mechanical.
 *   3. A missing, judgment, or invalid signal means NON-AUTO -- never auto.
 */
export function classifyFinding(finding: IndependentReviewFinding): FindingClassification {
  // Scope is a path and cannot authorize remediation. Both scope and summary
  // may veto the reviewer's signal, because either can identify human judgment.
  const vetoText = `${finding.scope} ${finding.summary}`;

  // 1a. Judgment-call VOCABULARY overrides any mechanical-looking match.
  if (NON_AUTO_PATTERN.test(vetoText)) return { autoFixable: false, classId: null };

  // 1b. Judgment-call CONSEQUENCE, independent of vocabulary. A mechanical
  // defect's consequence is a red tool; a consequence to data or to another
  // party is impact, and impact is what a human must weigh. This catches the
  // phrasings five rounds of keyword narrowing kept missing.
  if (NON_AUTO_IMPACT_PATTERN.test(vetoText)) return { autoFixable: false, classId: null };

  // 2. Only the explicit structured signal authorizes a mechanical hand-back.
  if (finding.remediation === 'mechanical') {
    return { autoFixable: true, classId: 'reviewer_mechanical' };
  }

  // 3. Unrecognized -> non-auto. This is the fail-closed default.
  return { autoFixable: false, classId: null };
}

export interface FindingsClassification {
  /** True only when there is at least one blocking finding and ALL are auto-fixable. */
  readonly allAutoFixable: boolean;
  /** Class ids matched, in finding order, for the audit trail. */
  readonly classIds: readonly string[];
  /** Summaries of the blocking findings that forced a human escalation. */
  readonly nonAutoSummaries: readonly string[];
}

/**
 * Classify a whole verdict's findings.
 *
 * Only BLOCKING findings (blocker/major) gate the decision: advisory minor and
 * note findings are commentary and must not, on their own, keep a mechanically
 * fixable PR away from a builder -- nor should an advisory note mentioning
 * architecture be treated as a blocking design objection. A verdict whose
 * blocking findings are all mechanical is handed back; one blocking judgment
 * call among them sends the whole verdict to a human. That mixed case is the
 * one the spec singles out, and it resolves toward the human.
 */
export function classifyFindings(
  findings: readonly IndependentReviewFinding[]
): FindingsClassification {
  const blocking = findings.filter(finding => BLOCKING_SEVERITIES.has(finding.severity));
  if (blocking.length === 0) {
    return { allAutoFixable: false, classIds: [], nonAutoSummaries: [] };
  }

  const classIds: string[] = [];
  const nonAutoSummaries: string[] = [];
  for (const finding of blocking) {
    const classification = classifyFinding(finding);
    if (classification.autoFixable && classification.classId) {
      classIds.push(classification.classId);
    } else {
      nonAutoSummaries.push(finding.summary);
    }
  }

  return {
    allAutoFixable: nonAutoSummaries.length === 0,
    classIds,
    nonAutoSummaries,
  };
}

/**
 * The remediation candidate wire contract.
 *
 * Everything Taskmaster and the builder it eventually fires need in order to
 * fix the NAMED defect rather than rediscover it: the PR ref, the exact head
 * that was reviewed, which attempt this is, the matched classes, and the
 * verdict body verbatim.
 */
export interface RemediationCandidateBody {
  readonly kind: typeof REMEDIATION_CANDIDATE_KIND;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  /** The exact head the reviewer examined and rejected. */
  readonly headSha: string;
  /** 1-based attempt number; never exceeds MAX_REMEDIATION_ATTEMPTS. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Matched auto-fixable class ids, for audit and for lane routing. */
  readonly findingClasses: readonly string[];
  /** The reviewer's verdict text, so the builder fixes the named defect. */
  readonly verdictBody: string;
  /** Work order id when the review route knew one; null otherwise. */
  readonly woId: string | null;
  /**
   * The lane that built the PR. KNOWN SCOPE LIMIT (deliberate): owner
   * selection defaults to the building lane. The general problem -- the
   * machine ASSIGNING an owner to ownerless work -- is a board design question
   * John raised 2026-08-28 and is explicitly NOT part of this WO.
   */
  readonly owningLane: string | null;
}

/**
 * What the emitter reports back.
 *
 * `attempt` is the slot ACTUALLY claimed, which may differ from the attempt the
 * caller predicted when a concurrent racer took an earlier slot. The receipt
 * must record this one, not the prediction, or an audit trail can say attempt 1
 * while the durable row says attempt 2 (PR #740 round 5 [minor]).
 */
export interface RemediationEmitResult {
  readonly claimed: boolean;
  /** The slot actually claimed; absent when nothing was inserted. */
  readonly attempt?: number;
  /** Why nothing was inserted, when claimed === false. */
  readonly reason?: 'duplicate_unit_of_work' | 'cap_exhausted';
}

export interface RemediationCandidateInput {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly verdict: 'APPROVED' | 'CHANGES_REQUESTED';
  readonly findings: readonly IndependentReviewFinding[];
  readonly verdictBody: string;
  /** Attempts ALREADY made for this PR, counted from durable state. */
  readonly priorAttempts: number;
  readonly woId?: string | null;
  readonly owningLane?: string | null;
}

export type RemediationDecision =
  | { readonly emit: true; readonly body: RemediationCandidateBody }
  | {
      readonly emit: false;
      readonly reason: RemediationRefusalReason;
      /** Blocking findings that were not auto-fixable, when that is the reason. */
      readonly nonAutoSummaries: readonly string[];
    };

/**
 * Decide whether a verdict becomes a remediation candidate, and build it.
 *
 * PURE. It reads no clock, no database, and no environment, so every branch of
 * the safety matrix is testable by value. Attempt state is passed in as
 * `priorAttempts` rather than read here, which keeps the counting concern with
 * the durable store that owns it (see countPriorRemediationAttempts).
 */
export function decideRemediation(input: RemediationCandidateInput): RemediationDecision {
  if (input.verdict !== 'CHANGES_REQUESTED') {
    return { emit: false, reason: 'verdict_not_changes_requested', nonAutoSummaries: [] };
  }

  const classification = classifyFindings(input.findings);

  if (classification.classIds.length === 0 && classification.nonAutoSummaries.length === 0) {
    // A CHANGES_REQUESTED verdict with no blocking finding is not something a
    // builder can act on. It stays with a human.
    return { emit: false, reason: 'no_blocking_findings', nonAutoSummaries: [] };
  }

  if (!classification.allAutoFixable) {
    return {
      emit: false,
      reason: 'non_auto_finding_present',
      nonAutoSummaries: classification.nonAutoSummaries,
    };
  }

  // Cap is checked AFTER classification so an exhausted PR reports exhaustion
  // rather than being masked by a classification refusal, and BEFORE any
  // candidate is constructed so no over-cap body can exist.
  if (input.priorAttempts >= MAX_REMEDIATION_ATTEMPTS) {
    return { emit: false, reason: 'remediation_attempts_exhausted', nonAutoSummaries: [] };
  }

  return {
    emit: true,
    body: {
      kind: REMEDIATION_CANDIDATE_KIND,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      attempt: input.priorAttempts + 1,
      maxAttempts: MAX_REMEDIATION_ATTEMPTS,
      findingClasses: classification.classIds,
      verdictBody: input.verdictBody,
      woId: input.woId ?? null,
      owningLane: input.owningLane ?? null,
    },
  };
}

/**
 * Idempotency key for one remediation candidate: (PR, attempt).
 *
 * THE HEAD SHA IS DELIBERATELY NOT IN THIS KEY. That is what makes the attempt
 * cap atomic, and it was a real defect before (found by the Overseer review
 * gate on this WO's own PR, 2026-08-28 -- fittingly, the very loop this WO
 * builds).
 *
 * THE KEY IS (PR, ATTEMPT) -- one row per attempt slot.
 *
 * This key has been wrong three times, in a cycle, so the whole reasoning is
 * recorded here. Read it before changing the shape again.
 *
 *   Round 1: (PR, head, attempt). Counting attempts then inserting is a
 *     read-then-write race, so two racers on DIFFERENT heads computed the same
 *     attempt and -- their keys differing by SHA -- both inserted. Cap exceeded.
 *   Round 2: (PR, attempt). Closed that race, but broke REDELIVERY: after
 *     attempt 1 lands the count returns 1, so the SAME verdict replayed
 *     computed attempt 2 and inserted a duplicate.
 *   Round 3: (PR, head). Fixed redelivery, and reintroduced round 1 -- two
 *     heads read the same below-cap count and each got its own key.
 *
 * The lesson is that ONE key cannot carry both properties, because the only
 * atomic primitive available is a single UNIQUE index:
 *
 *   - Atomic cap needs the key to be the SCARCE RESOURCE (the attempt slot).
 *   - Idempotent redelivery needs the key to be the VERDICT IDENTITY (the head).
 *
 * Those are different things, so they are enforced in different places. The KEY
 * is the attempt slot, which keeps the cap atomic. REDELIVERY is settled before
 * the insert, by checking whether any existing candidate for this PR already
 * names this head (see emitRemediationCandidate).
 *
 * Do not "simplify" this by folding the head back into the key. That is round 1
 * and round 3, and it silently unbounds the reviewer-fix-reviewer loop.
 */
export function remediationIdempotencyKey(input: {
  owner: string;
  repo: string;
  prNumber: number;
  attempt: number;
}): string {
  const slug = `${input.owner.toLowerCase()}/${input.repo.toLowerCase()}#${input.prNumber}`;
  return `overseer-remediation:${slug}:attempt-${input.attempt}`;
}

/**
 * Parse a dispatch body back into a remediation candidate.
 *
 * Fails closed: anything that is not a well-formed candidate returns null
 * rather than a partially-populated object, so a consumer can never act on a
 * candidate missing the PR ref or the head it applies to.
 */
export function parseRemediationCandidateBody(body: string): RemediationCandidateBody | null {
  try {
    const value = JSON.parse(body) as Partial<RemediationCandidateBody>;
    if (
      value.kind !== REMEDIATION_CANDIDATE_KIND ||
      typeof value.owner !== 'string' ||
      typeof value.repo !== 'string' ||
      typeof value.prNumber !== 'number' ||
      typeof value.headSha !== 'string' ||
      typeof value.attempt !== 'number' ||
      typeof value.verdictBody !== 'string' ||
      !Array.isArray(value.findingClasses)
    ) {
      return null;
    }
    return {
      kind: REMEDIATION_CANDIDATE_KIND,
      owner: value.owner,
      repo: value.repo,
      prNumber: value.prNumber,
      headSha: value.headSha,
      attempt: value.attempt,
      maxAttempts:
        typeof value.maxAttempts === 'number' ? value.maxAttempts : MAX_REMEDIATION_ATTEMPTS,
      findingClasses: value.findingClasses.filter(
        (entry): entry is string => typeof entry === 'string'
      ),
      verdictBody: value.verdictBody,
      woId: typeof value.woId === 'string' ? value.woId : null,
      owningLane: typeof value.owningLane === 'string' ? value.owningLane : null,
    };
  } catch {
    return null;
  }
}

/**
 * Count remediation attempts already made for a PR from durable dispatch rows.
 *
 * NO NEW TABLE. The spec asked the builder to reuse existing storage if one
 * fits, and `agent_dispatch_messages` does: every attempt is itself a durable,
 * subject-keyed row, so the attempt count IS the number of candidate rows for
 * that PR. Deriving it here rather than maintaining a separate counter removes
 * the class of bug where the counter and the queue disagree.
 *
 * Rows are counted regardless of status. A candidate that Taskmaster refused or
 * that failed still consumed an attempt -- that is the point of the cap.
 */
export function countPriorRemediationAttempts(
  messages: readonly { body: string }[],
  pr: { owner: string; repo: string; prNumber: number }
): number {
  let count = 0;
  for (const message of messages) {
    const candidate = parseRemediationCandidateBody(message.body);
    if (!candidate) continue;
    if (
      candidate.owner.toLowerCase() === pr.owner.toLowerCase() &&
      candidate.repo.toLowerCase() === pr.repo.toLowerCase() &&
      candidate.prNumber === pr.prNumber
    ) {
      count += 1;
    }
  }
  return count;
}
