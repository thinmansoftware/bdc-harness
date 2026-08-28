/**
 * GitHub rate-limit classifier tests
 * (WO-HARNESS-OPERATOR-INBOX-BACKPRESSURE-01, Section 11 scenario 4).
 *
 * The load-bearing case is the 2026-08-27 trap: a 403/429 whose /rate_limit
 * buckets ALL read FULL must be classified SECONDARY, not quota exhaustion.
 * GitHub does not expose secondary limits in /rate_limit, so any check that
 * concludes "token is fine" from full buckets reproduces the outage blindness.
 */
import { describe, expect, test } from 'bun:test';
import {
  advanceRateLimitBackoff,
  classifyGitHubRateLimit,
  createRateLimitBackoffState,
  resetRateLimitBackoff,
  type RateLimitSnapshot,
} from './github-rate-limit-classifier';

// Every documented /rate_limit bucket reading FULL -- the exact outage snapshot.
const ALL_BUCKETS_FULL: RateLimitSnapshot = {
  buckets: {
    core: { remaining: 5000, limit: 5000 },
    search: { remaining: 30, limit: 30 },
    graphql: { remaining: 5000, limit: 5000 },
    integration_manifest: { remaining: 5000, limit: 5000 },
    code_scanning_upload: { remaining: 500, limit: 500 },
  },
};

describe('classifyGitHubRateLimit -- 2026-08-27 secondary-limit trap', () => {
  test('403 with all /rate_limit buckets FULL is SECONDARY, not primary exhaustion', () => {
    const error = Object.assign(new Error('You have exceeded a secondary rate limit'), {
      status: 403,
      response: { headers: { 'x-ratelimit-remaining': '4999' } },
    });
    expect(classifyGitHubRateLimit(error, ALL_BUCKETS_FULL)).toBe('secondary');
  });

  test('429 with a retry-after header and full buckets is SECONDARY', () => {
    const error = Object.assign(new Error('rate limited'), {
      status: 429,
      response: { headers: { 'retry-after': '60', 'x-ratelimit-remaining': '5000' } },
    });
    expect(classifyGitHubRateLimit(error, ALL_BUCKETS_FULL)).toBe('secondary');
  });

  test('generic "rate limit" 403 with buckets full (no remaining:0) is SECONDARY', () => {
    const error = Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    expect(classifyGitHubRateLimit(error, ALL_BUCKETS_FULL)).toBe('secondary');
  });

  test('REGRESSION: x-ratelimit-remaining:0 is PRIMARY_EXHAUSTED, unchanged', () => {
    const error = Object.assign(new Error('API rate limit exceeded'), {
      status: 403,
      response: { headers: { 'x-ratelimit-remaining': '0' } },
    });
    expect(classifyGitHubRateLimit(error)).toBe('primary_exhausted');
  });

  test('a depleted snapshot bucket (remaining 0) is PRIMARY_EXHAUSTED', () => {
    const snapshot: RateLimitSnapshot = {
      buckets: { core: { remaining: 0, limit: 5000 }, graphql: { remaining: 5000, limit: 5000 } },
    };
    const error = Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    expect(classifyGitHubRateLimit(error, snapshot)).toBe('primary_exhausted');
  });

  test('a depleted primary bucket WITH a secondary message is still SECONDARY', () => {
    // Secondary limiting can coincide with a hot bucket; the explicit secondary
    // signal wins so we back off instead of waiting for a reset that is not the
    // real cause.
    const error = Object.assign(new Error('You have exceeded a secondary rate limit'), {
      status: 403,
      response: { headers: { 'x-ratelimit-remaining': '0' } },
    });
    expect(classifyGitHubRateLimit(error)).toBe('secondary');
  });

  test('non-rate-limit 403 (permissions) is NOT rate limited', () => {
    const error = Object.assign(new Error('Resource not accessible by integration'), {
      status: 403,
    });
    expect(classifyGitHubRateLimit(error, ALL_BUCKETS_FULL)).toBe('not_rate_limited');
  });

  test('a 404 / transport error is NOT rate limited', () => {
    expect(classifyGitHubRateLimit(Object.assign(new Error('Not Found'), { status: 404 }))).toBe(
      'not_rate_limited'
    );
    expect(classifyGitHubRateLimit(null)).toBe('not_rate_limited');
    expect(classifyGitHubRateLimit('nope')).toBe('not_rate_limited');
  });

  test('header lookup is case-insensitive', () => {
    const error = Object.assign(new Error('boom'), {
      status: 403,
      response: { headers: { 'X-RateLimit-Remaining': '0' } },
    });
    expect(classifyGitHubRateLimit(error)).toBe('primary_exhausted');
  });
});

describe('increasing backoff helper', () => {
  test('first hit is exactly the base window; repeats grow geometrically and cap', () => {
    const state = createRateLimitBackoffState();
    const a = advanceRateLimitBackoff(state, 1_000, { baseMs: 60_000, maxMs: 900_000 });
    expect(a.backoffMs).toBe(60_000);
    expect(state.backoffUntil).toBe(61_000);
    expect(state.consecutiveHits).toBe(1);

    const b = advanceRateLimitBackoff(state, 100_000, { baseMs: 60_000, maxMs: 900_000 });
    expect(b.backoffMs).toBe(120_000); // 60_000 * 2^1
    const c = advanceRateLimitBackoff(state, 200_000, { baseMs: 60_000, maxMs: 900_000 });
    expect(c.backoffMs).toBe(240_000); // 60_000 * 2^2

    // Keep hitting -- backoff must saturate at maxMs, never grow unbounded.
    for (let i = 0; i < 20; i += 1) advanceRateLimitBackoff(state, 300_000, { maxMs: 900_000 });
    const capped = advanceRateLimitBackoff(state, 300_000, { baseMs: 60_000, maxMs: 900_000 });
    expect(capped.backoffMs).toBe(900_000);
  });

  test('reset returns to a clear state after a success', () => {
    const state = createRateLimitBackoffState();
    advanceRateLimitBackoff(state, 1_000);
    advanceRateLimitBackoff(state, 1_000);
    expect(state.consecutiveHits).toBe(2);
    resetRateLimitBackoff(state);
    expect(state.consecutiveHits).toBe(0);
    expect(state.backoffUntil).toBe(0);
    // A fresh hit after reset is a first hit again (base window).
    const again = advanceRateLimitBackoff(state, 5_000, { baseMs: 60_000 });
    expect(again.backoffMs).toBe(60_000);
  });
});
