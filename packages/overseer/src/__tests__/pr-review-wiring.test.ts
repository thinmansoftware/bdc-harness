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
  REVIEW_REVIEWER_IDENTITY_ENV,
  REVIEW_WEBHOOK_SECRET_ENV,
  parseReviewWorkBody,
  resolveReviewRouteConfig,
  reviewSubjectKey,
} from '../pr-review-wiring.ts';

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

  test('returns null when the webhook secret is absent', () => {
    expect(
      resolveReviewRouteConfig({ [REVIEW_REVIEWER_IDENTITY_ENV]: 'thinman-overseer[bot]' })
    ).toBeNull();
  });

  test('returns null when the reviewer identity is absent', () => {
    expect(resolveReviewRouteConfig({ [REVIEW_WEBHOOK_SECRET_ENV]: 'secret-value' })).toBeNull();
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
