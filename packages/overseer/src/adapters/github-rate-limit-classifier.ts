/**
 * GitHub rate-limit classifier (WO-HARNESS-OPERATOR-INBOX-BACKPRESSURE-01).
 *
 * The 2026-08-27 outage: a stale operator-inbox backlog re-processed every
 * minute tripped GitHub SECONDARY rate limiting on the shared token, which
 * starved the PR reviewer and deadlocked the merge path. The diagnostic trap
 * that hid it: GitHub does NOT expose secondary limits in /rate_limit, so all
 * fifteen documented buckets read FULL (core 5000/5000, graphql 5000/5000)
 * during the outage. Any check that concludes "token is fine" from /rate_limit
 * alone reproduces that blindness.
 *
 * This module is a PURE classifier plus an increasing-backoff helper. It never
 * reads the network or module-scope state -- callers own their backoff state so
 * the classifier stays deterministic and hermetically testable.
 */

/**
 * secondary          -- secondary/abuse rate limiting (the 2026-08-27 signature):
 *                       a 403/429 that is NOT explained by a depleted primary
 *                       bucket. Back off with increasing delay.
 * primary_exhausted  -- a documented primary bucket is depleted
 *                       (x-ratelimit-remaining: 0 or a snapshot bucket at 0).
 * not_rate_limited   -- some other error (permissions, 404, transport, etc.).
 */
export type GitHubRateLimitClass = 'secondary' | 'primary_exhausted' | 'not_rate_limited';

/** A single /rate_limit bucket. */
export interface RateLimitBucket {
  remaining: number;
  limit: number;
}

/**
 * Optional snapshot of GitHub's /rate_limit response. Present buckets are the
 * ONLY thing that can prove primary exhaustion from a snapshot -- absence of a
 * depleted bucket is NOT proof the token is fine (that is the exact trap).
 */
export interface RateLimitSnapshot {
  buckets?: Record<string, RateLimitBucket>;
}

interface GitHubErrorShape {
  status?: unknown;
  message?: unknown;
  response?: { headers?: Record<string, unknown> };
}

function coerceHeaderValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function readHeader(headers: Record<string, unknown> | undefined, name: string): string | null {
  if (!headers) return null;
  // Header names are case-insensitive; Octokit lowercases, but be defensive.
  const direct = coerceHeaderValue(headers[name]);
  if (direct !== null) return direct;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) {
      const value = coerceHeaderValue(headers[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function anyBucketDepleted(snapshot: RateLimitSnapshot | undefined): boolean {
  if (!snapshot?.buckets) return false;
  return Object.values(snapshot.buckets).some(bucket => bucket.remaining === 0);
}

/**
 * Classify a caught error (optionally with a /rate_limit snapshot) into one of
 * the three buckets above. Order matters: primary exhaustion is only concluded
 * from hard evidence (remaining: 0 or a depleted snapshot bucket); everything
 * else that still looks like rate limiting is treated as SECONDARY, because the
 * primary buckets reading full during a secondary limit is the documented trap.
 */
export function classifyGitHubRateLimit(
  error: unknown,
  snapshot?: RateLimitSnapshot
): GitHubRateLimitClass {
  if (!error || typeof error !== 'object') return 'not_rate_limited';
  const candidate = error as GitHubErrorShape;
  const status = typeof candidate.status === 'number' ? candidate.status : undefined;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  const headers = candidate.response?.headers;

  const isRateLimitStatus = status === 403 || status === 429;
  const remaining = readHeader(headers, 'x-ratelimit-remaining');
  const retryAfter = readHeader(headers, 'retry-after');
  const mentionsSecondary = /secondary rate limit|abuse detection|exceeded a secondary/i.test(
    message
  );
  const mentionsRateLimit = /rate limit/i.test(message);

  // Hard primary-exhaustion evidence wins ONLY when it is not explicitly a
  // secondary-limit message. A depleted core bucket with a "secondary rate
  // limit" body is still secondary.
  if (!mentionsSecondary && (remaining === '0' || anyBucketDepleted(snapshot))) {
    return 'primary_exhausted';
  }

  // Explicit secondary signal.
  if (mentionsSecondary) return 'secondary';

  // A rate-limit-shaped failure whose primary buckets are NOT depleted is the
  // 2026-08-27 signature: 403/429 with /rate_limit reading full. Treat 429, a
  // retry-after header, or a generic "rate limit" body as secondary.
  if (isRateLimitStatus && (status === 429 || retryAfter !== null || mentionsRateLimit)) {
    return 'secondary';
  }

  return 'not_rate_limited';
}

/** Mutable increasing-backoff state. Callers own an instance per token/seam. */
export interface RateLimitBackoffState {
  /** Consecutive rate-limited hits since the last success. */
  consecutiveHits: number;
  /** Epoch ms until which callers should suppress live requests (0 = clear). */
  backoffUntil: number;
}

export interface RateLimitBackoffOptions {
  /** First-hit backoff (also the doubling base). Default 60_000. */
  baseMs?: number;
  /** Maximum single-hit backoff. Default 900_000 (15 minutes). */
  maxMs?: number;
}

export const DEFAULT_RATE_LIMIT_BASE_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MAX_MS = 900_000;

export function createRateLimitBackoffState(): RateLimitBackoffState {
  return { consecutiveHits: 0, backoffUntil: 0 };
}

/**
 * Advance an increasing backoff on a fresh rate-limited hit. Backoff grows
 * geometrically (base * 2^(hits-1)) capped at maxMs -- the FIRST hit is exactly
 * baseMs, so a single-hit-then-recover sequence backs off by the base window
 * (preserving the prior flat-60s behavior). Mutates and returns the state.
 */
export function advanceRateLimitBackoff(
  state: RateLimitBackoffState,
  nowMs: number,
  options: RateLimitBackoffOptions = {}
): { backoffMs: number } {
  const baseMs = options.baseMs ?? DEFAULT_RATE_LIMIT_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_RATE_LIMIT_MAX_MS;
  state.consecutiveHits += 1;
  const exponent = Math.min(state.consecutiveHits - 1, 30);
  const backoffMs = Math.min(baseMs * 2 ** exponent, maxMs);
  state.backoffUntil = nowMs + backoffMs;
  return { backoffMs };
}

/** Reset backoff after a successful request. Mutates and returns the state. */
export function resetRateLimitBackoff(state: RateLimitBackoffState): void {
  state.consecutiveHits = 0;
  state.backoffUntil = 0;
}
