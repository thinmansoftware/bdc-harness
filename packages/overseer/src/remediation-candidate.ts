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

/** Dispatch principals for the remediation hand-back. */
export const REMEDIATION_SENDER = 'overseer-review-route';
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
 * Finding classes the machine is permitted to hand back for an automated fix.
 *
 * DATA-DRIVEN AND FAIL-CLOSED BY CONSTRUCTION. Adding a class is an edit to
 * this table and nothing else; a finding that matches no entry here is NON-AUTO
 * and goes to a human. There is deliberately no wildcard, no default-auto
 * branch, and no "unknown -> probably fine" path. See classifyFinding.
 */
export interface AutoFixableClass {
  /** Stable id, recorded on the candidate so the fix target is auditable. */
  readonly id: string;
  /** Human-readable description for the wiki article and operator cards. */
  readonly description: string;
  /** Matched against the finding's scope + summary, case-insensitively. */
  readonly pattern: RegExp;
}

/**
 * The auto-fixable class list.
 *
 * Every entry describes a defect whose CORRECTION IS MECHANICAL: the reviewer
 * has already named what is wrong and the fix does not require a judgment call
 * about intent, scope, or risk. Migration ordering is here because it is the
 * live anchor: shopops#650's parent-before-child update order is wrong in a way
 * the diff itself proves, and reordering it settles the finding.
 *
 * Explicitly NOT here, and never to be added: design disagreements, scope
 * questions, governance objections, and security judgments. Those are the cases
 * where a human must decide, and routing them to a builder would launder a
 * judgment call into a code change.
 */
export const AUTO_FIXABLE_CLASSES: readonly AutoFixableClass[] = [
  {
    id: 'build_failure',
    description: 'Compilation or build errors named by the reviewer.',
    pattern:
      /\b(?:build|compil\w*|type[-\s]?(?:error|check)|tsc)\b[\s\S]*\b(?:fail\w*|error\w*|break\w*)\b/i,
  },
  {
    id: 'test_failure',
    description: 'Failing or missing tests the reviewer identified.',
    pattern:
      /\b(?:test|spec|assertion)s?\b[\s\S]*\b(?:fail\w*|error\w*|missing|absent|not\s+run)\b/i,
  },
  {
    id: 'lint_or_format',
    description: 'Lint, formatting, or style-rule violations.',
    pattern: /\b(?:lint\w*|eslint|prettier|format\w*|style\s+violation)\b/i,
  },
  {
    id: 'migration_ordering',
    description:
      'Migration statement ordering defects, including FK-violating parent/child update order.',
    pattern:
      /\bmigrat\w+\b[\s\S]*\b(?:order\w*|sequence\w*|before|after|foreign[-\s]?key|fk|constraint)\b/i,
  },
  {
    id: 'ascii_violation',
    description: 'Non-ASCII characters in files required to be ASCII-only.',
    pattern: /\b(?:non[-\s]?ascii|ascii[-\s]?only|em[-\s]?dash|smart\s+quote|unicode)\b/i,
  },
];

/**
 * Findings that must NEVER be auto-remediated, regardless of whether their text
 * happens to also match an auto-fixable pattern.
 *
 * This is an OVERRIDE, not a filter applied in isolation: it is checked FIRST in
 * classifyFinding, so "the migration ordering here is a security concern" is
 * non-auto even though it matches migration_ordering. Fail-closed means the
 * safer classification wins ties, always.
 */
const NON_AUTO_PATTERN =
  /\b(?:securit\w*|vulnerab\w*|auth\w*|credential\w*|secret\w*|injection|design|architect\w*|scope|governance|policy|approv\w*|judgment|judgement|intent|breaking\s+change|data\s+loss|privacy)\b/i;

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
 *   2. Otherwise, the finding must match a known auto-fixable class.
 *   3. Matching nothing means NON-AUTO -- never auto.
 */
export function classifyFinding(finding: IndependentReviewFinding): FindingClassification {
  const text = `${finding.scope} ${finding.summary}`;

  // 1. Judgment-call signal overrides any mechanical-looking match.
  if (NON_AUTO_PATTERN.test(text)) return { autoFixable: false, classId: null };

  // 2. Known mechanical class.
  for (const candidate of AUTO_FIXABLE_CLASSES) {
    if (candidate.pattern.test(text)) return { autoFixable: true, classId: candidate.id };
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
 * The bug: counting prior attempts and then inserting is a read-then-write
 * race. Two rejected reviews for DIFFERENT head SHAs could each read the same
 * prior count, each compute the same attempt number, and -- because their keys
 * differed by SHA -- each insert successfully. That yields more than
 * MAX_REMEDIATION_ATTEMPTS durable candidates and defeats the bounded-loop
 * guarantee, which is the single most important safety property here.
 *
 * Keying on (PR, attempt) makes the DATABASE the arbiter: `idempotency_key` is
 * UNIQUE and `createMessage` inserts with ON CONFLICT DO NOTHING, returning the
 * existing row. Two concurrent emitters racing for attempt 2 therefore collide
 * on the constraint and exactly one row exists. The cap cannot be exceeded no
 * matter how the reads interleave, because the slot itself is the unique
 * resource.
 *
 * A legitimate second attempt after a fix push still works: it is a different
 * ATTEMPT NUMBER, not a different SHA. The head being remediated is carried in
 * the body (`headSha`), so the candidate still names exactly what was reviewed.
 * Re-delivery of the same verdict computes the same key and is still a no-op.
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
