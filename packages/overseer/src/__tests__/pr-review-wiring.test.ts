/**
 * WO-HARNESS-OVERSEER-REVIEW-ROUTE-01 -- route configuration and body
 * contracts. Hermetic: no database, no network.
 *
 * The fail-closed configuration gate is the security-relevant part here. An
 * unconfigured deployment must have NO endpoint rather than an endpoint that
 * accepts unverified input, so these tests pin that behavior.
 */
import { describe, expect, test } from 'bun:test';
import {
  createRealSubmitDeps,
  ingestReceiptGovernanceClassification,
  submitReceiptGovernanceClassification,
  receiptRecipient,
  REVIEW_RECEIPTS_LOG,
  REVIEW_REVIEWER_IDENTITY_ENV,
  REVIEW_WEBHOOK_SECRET_ENV,
  parseReviewWorkBody,
  resolveReviewRouteConfig,
  reviewSubjectKey,
} from '../pr-review-wiring.ts';
import type { ReceiptGovernanceClassification } from '../pr-review-wiring.ts';
import type { IngestDisposition } from '../pr-review-ingest.ts';
import type { SubmitDisposition } from '../pr-review-submit.ts';
import type { RealGitHubOctokitLike } from '../adapters/github-real-deps.ts';
import type { PrReviewResult } from '../pr-review-evaluator.ts';

const HEAD = 'a'.repeat(40);

function submitOctokit(): RealGitHubOctokitLike {
  return {
    pulls: {
      get: async () => ({ data: { head: { sha: HEAD } } }),
      createReview: async () => ({ data: { id: 1, state: 'APPROVED' } }),
    },
    checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
  } as unknown as RealGitHubOctokitLike;
}

function reviewResult(overrides: Partial<PrReviewResult> = {}): PrReviewResult {
  return {
    verdict: 'APPROVE',
    findings: [],
    reviewed_head_sha: HEAD,
    reviewer: { provider: 'test-cli', model: 'test-model' },
    acceptance_criteria_available: false,
    ...overrides,
  };
}

const work = {
  correlationId: 'correlation-1',
  messageId: 'message-1',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  prNumber: 42,
  headSha: HEAD,
  author: 'contributor',
};

describe('createRealSubmitDeps -- evaluator binding', () => {
  test.each([
    ['APPROVE', true],
    ['REQUEST_CHANGES', false],
    ['INDETERMINATE', false],
  ] as const)('maps %s to approved=%s', async (verdict, approved) => {
    const deps = createRealSubmitDeps('review-app[bot]', {
      octokit: submitOctokit(),
      evaluate: async () =>
        reviewResult({
          verdict,
          findings:
            verdict === 'REQUEST_CHANGES'
              ? [{ scope: 'unsafe.ts', severity: 'major', summary: 'Unsafe change' }]
              : [],
        }),
    });

    expect((await deps.runReviewer(work)).approved).toBe(approved);
  });

  test('does not expose internal INDETERMINATE errors in the GitHub summary', async () => {
    const secretError = 'model_error:token=super-secret-provider-detail';
    const deps = createRealSubmitDeps('review-app[bot]', {
      octokit: submitOctokit(),
      evaluate: async () => reviewResult({ verdict: 'INDETERMINATE', error: secretError }),
    });

    const verdict = await deps.runReviewer(work);
    expect(verdict.approved).toBe(false);
    expect(verdict.summary).toContain('could not reach a determinate verdict');
    expect(verdict.summary).not.toContain(secretError);
    expect(verdict.summary).not.toContain('super-secret');
  });

  test('keeps the model-correlation identity separate from the GitHub custody identity', async () => {
    let observedReviewer: unknown;
    const deps = createRealSubmitDeps('review-app[bot]', {
      octokit: submitOctokit(),
      reviewerModel: 'review-model',
      evaluate: async (_input, evaluatorDeps) => {
        observedReviewer = evaluatorDeps.reviewer;
        return reviewResult({ reviewer: evaluatorDeps.reviewer });
      },
    });

    await deps.runReviewer(work);
    expect(deps.reviewerIdentity).toBe('review-app[bot]');
    expect(observedReviewer).toEqual({ provider: 'cli', model: 'review-model' });
    expect(observedReviewer).not.toEqual(
      expect.objectContaining({ provider: deps.reviewerIdentity })
    );
  });
});

describe('resolveReviewRouteConfig -- fail closed', () => {
  test('returns config when both values are present', () => {
    const config = resolveReviewRouteConfig({
      [REVIEW_WEBHOOK_SECRET_ENV]: 'secret-value',
      [REVIEW_REVIEWER_IDENTITY_ENV]: 'thinman-overseer[bot]',
    });
    expect(config).toEqual({
      webhookSecret: 'secret-value',
      reviewerIdentity: 'thinman-overseer[bot]',
    });
  });

  test('uses explicit values from the app env when provided', () => {
    const config = resolveReviewRouteConfig({
      [REVIEW_WEBHOOK_SECRET_ENV]: 'secret-value',
      [REVIEW_REVIEWER_IDENTITY_ENV]: 'thinman-overseer[bot]',
      MERGE_MANAGER_REVIEW_GATE_LOGIN: 'alt-reviewer-bot',
      WEBHOOK_SECRET: 'fallback-secret',
    });
    expect(config).toEqual({
      webhookSecret: 'secret-value',
      reviewerIdentity: 'thinman-overseer[bot]',
    });
  });

  test('falls back to WEBHOOK_SECRET and MERGE_MANAGER_REVIEW_GATE_LOGIN when review vars are absent', () => {
    const config = resolveReviewRouteConfig({
      WEBHOOK_SECRET: 'webhook-fallback',
      MERGE_MANAGER_REVIEW_GATE_LOGIN: 'merge-gate-reviewer',
    });
    expect(config).toEqual({
      webhookSecret: 'webhook-fallback',
      reviewerIdentity: 'merge-gate-reviewer',
    });
  });

  test('falls back to thinman-overseer[bot] when only webhook secret is present', () => {
    const config = resolveReviewRouteConfig({
      [REVIEW_WEBHOOK_SECRET_ENV]: 'secret-value',
    });
    expect(config).toEqual({
      webhookSecret: 'secret-value',
      reviewerIdentity: 'thinman-overseer[bot]',
    });
  });

  test('returns null when the webhook secret is absent', () => {
    expect(
      resolveReviewRouteConfig({ [REVIEW_REVIEWER_IDENTITY_ENV]: 'thinman-overseer[bot]' })
    ).toBeNull();
  });

  test('returns null on an empty environment (default is OFF, not open)', () => {
    expect(resolveReviewRouteConfig({})).toBeNull();
  });

  test('whitespace-only values do not count as configured', () => {
    expect(
      resolveReviewRouteConfig({
        [REVIEW_WEBHOOK_SECRET_ENV]: '   ',
        [REVIEW_REVIEWER_IDENTITY_ENV]: 'thinman-overseer[bot]',
      })
    ).toBeNull();
  });

  test('trims surrounding whitespace from configured values', () => {
    const config = resolveReviewRouteConfig({
      [REVIEW_WEBHOOK_SECRET_ENV]: '  secret-value  ',
      [REVIEW_REVIEWER_IDENTITY_ENV]: '  thinman-overseer[bot]  ',
    });
    expect(config?.webhookSecret).toBe('secret-value');
    expect(config?.reviewerIdentity).toBe('thinman-overseer[bot]');
  });
});

describe('reviewSubjectKey', () => {
  test('is head-INDEPENDENT so every attempt for one PR groups together', () => {
    expect(reviewSubjectKey('thinmansoftware', 'bdc-harness', 673)).toBe(
      'gh:thinmansoftware/bdc-harness#673'
    );
  });

  test('distinguishes different PRs and different repos', () => {
    expect(reviewSubjectKey('o', 'r', 1)).not.toBe(reviewSubjectKey('o', 'r', 2));
    expect(reviewSubjectKey('o', 'r1', 1)).not.toBe(reviewSubjectKey('o', 'r2', 1));
  });
});

describe('parseReviewWorkBody', () => {
  const valid = {
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    prNumber: 673,
    headSha: 'a'.repeat(40),
    baseRef: 'dev',
    author: 'bluedevilcollectibles',
  };

  test('round-trips a valid body', () => {
    expect(parseReviewWorkBody(JSON.stringify(valid))).toEqual(valid);
  });

  test('returns null on malformed JSON rather than throwing', () => {
    expect(parseReviewWorkBody('not json')).toBeNull();
  });

  test('returns null when a required field is missing or wrong-typed', () => {
    const { headSha: _omitted, ...missingHead } = valid;
    expect(parseReviewWorkBody(JSON.stringify(missingHead))).toBeNull();
    expect(parseReviewWorkBody(JSON.stringify({ ...valid, prNumber: '673' }))).toBeNull();
  });

  test('tolerates absent optional fields without inventing values', () => {
    const { baseRef: _b, author: _a, ...minimal } = valid;
    const parsed = parseReviewWorkBody(JSON.stringify(minimal));
    expect(parsed?.baseRef).toBe('');
    expect(parsed?.author).toBe('');
  });
});

// WO-HARNESS-OPERATOR-INBOX-BACKPRESSURE-01, Section 11 scenario 9: the receipt
// governance predicate. Routine outcomes are information-only (audit log);
// genuine decisions/blockers are operator-actionable (human inbox). Both sides,
// same test. The switches are exhaustive-by-construction, so every disposition
// value is asserted here -- a new one would fail to compile in the source.
describe('receipt governance classification', () => {
  test('ingest: routine dispositions are information-only', () => {
    const informational: IngestDisposition[] = [
      'queued',
      'duplicate_delivery',
      'superseded_head',
      'ignored_event',
      'ignored_draft',
    ];
    for (const d of informational) {
      expect(ingestReceiptGovernanceClassification(d)).toBe('information-only');
    }
  });

  test('ingest: refusals a human must resolve are operator_decision_required', () => {
    const actionable: IngestDisposition[] = ['blocked', 'custody_conflict', 'rejected_signature'];
    for (const d of actionable) {
      expect(ingestReceiptGovernanceClassification(d)).toBe('operator_decision_required');
    }
  });

  test('submit: routine outcomes are information-only', () => {
    const informational: SubmitDisposition[] = ['approved', 'changes_requested', 'stale_head'];
    for (const d of informational) {
      expect(submitReceiptGovernanceClassification(d)).toBe('information-only');
    }
  });

  test('submit: custody/reviewer/submission failures are operator_decision_required', () => {
    const actionable: SubmitDisposition[] = [
      'custody_conflict',
      'merge_custody_conflict',
      'reviewer_failed',
      'submission_failed',
    ];
    for (const d of actionable) {
      expect(submitReceiptGovernanceClassification(d)).toBe('operator_decision_required');
    }
  });

  test('the receipts-log principal is a distinct, non-operator audit home', () => {
    expect(REVIEW_RECEIPTS_LOG).toBe('review-receipts-log');
    expect(REVIEW_RECEIPTS_LOG).not.toBe('operator');
  });
});

// WO-HARNESS-OPERATOR-INBOX-BACKPRESSURE-01: the ROUTING invariant the WO
// requires -- a receipt classified 'information-only' can never be written with
// recipient='operator'. receiptRecipient is the single choke point BOTH the
// ingest and submit producers route through, so proving it here proves the
// invariant for every producer in this module. Driving each disposition through
// classification -> recipient (not just the classifier in isolation) closes the
// gap Codex flagged: enforcement is now covered end-to-end, per producer.
describe('receipt routing enforcement (information-only never reaches operator)', () => {
  const ingestDispositions: IngestDisposition[] = [
    'queued',
    'duplicate_delivery',
    'superseded_head',
    'ignored_event',
    'ignored_draft',
    'blocked',
    'custody_conflict',
    'rejected_signature',
  ];
  const submitDispositions: SubmitDisposition[] = [
    'approved',
    'changes_requested',
    'stale_head',
    'custody_conflict',
    'merge_custody_conflict',
    'reviewer_failed',
    'submission_failed',
  ];

  test('receiptRecipient hard-constrains information-only to the audit log', () => {
    expect(receiptRecipient('information-only')).toBe(REVIEW_RECEIPTS_LOG);
    expect(receiptRecipient('information-only')).not.toBe('operator');
    expect(receiptRecipient('operator_decision_required')).toBe('operator');
  });

  test('EVERY ingest disposition routes information-only away from the operator inbox', () => {
    for (const disposition of ingestDispositions) {
      const classification: ReceiptGovernanceClassification =
        ingestReceiptGovernanceClassification(disposition);
      const recipient = receiptRecipient(classification);
      if (classification === 'information-only') {
        expect(recipient).toBe(REVIEW_RECEIPTS_LOG);
        expect(recipient).not.toBe('operator');
      } else {
        expect(recipient).toBe('operator');
      }
    }
  });

  test('EVERY submit disposition routes information-only away from the operator inbox', () => {
    for (const disposition of submitDispositions) {
      const classification: ReceiptGovernanceClassification =
        submitReceiptGovernanceClassification(disposition);
      const recipient = receiptRecipient(classification);
      if (classification === 'information-only') {
        expect(recipient).toBe(REVIEW_RECEIPTS_LOG);
        expect(recipient).not.toBe('operator');
      } else {
        expect(recipient).toBe('operator');
      }
    }
  });

  test('no information-only disposition anywhere in the module resolves to operator', () => {
    const allInformationOnly = [
      ...ingestDispositions.filter(
        d => ingestReceiptGovernanceClassification(d) === 'information-only'
      ),
      ...submitDispositions.filter(
        d => submitReceiptGovernanceClassification(d) === 'information-only'
      ),
    ];
    // Guardrail: the fixture must actually contain the routine dispositions the
    // 2026-08-27 flood was made of, or this test would pass vacuously.
    expect(allInformationOnly).toContain('queued');
    expect(allInformationOnly).toContain('approved');
    expect(allInformationOnly.map(() => receiptRecipient('information-only'))).not.toContain(
      'operator'
    );
  });
});
