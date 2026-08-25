/**
 * GitHub webhook signature verification -- HMAC SHA-256 with constant-time
 * comparison.
 *
 * WO-HARNESS-OVERSEER-REVIEW-ROUTE-01: extracted VERBATIM from the private
 * `GitHubAdapter.verifySignature` method (packages/adapters/src/forge/github/
 * adapter.ts) so the existing adapter and the new review-ingestion route share
 * ONE proven implementation. This is a refactor of code already in production
 * use, not a second security path -- XO ruling 2026-08-17 explicitly forbids a
 * parallel HMAC implementation.
 *
 * Behavior preserved exactly from the original:
 *  - digest is 'sha256=' + hex of HMAC-SHA256(payload, secret)
 *  - a length mismatch returns false BEFORE timingSafeEqual (which throws on
 *    unequal buffer lengths) -- the length check is load-bearing, not defensive
 *  - comparison is constant-time via crypto.timingSafeEqual
 *  - any thrown error returns false (fail closed), never propagates
 *  - the raw payload string is compared as-is; callers MUST pass the exact raw
 *    request body, never a re-serialized object
 */
import { createHmac, timingSafeEqual } from 'crypto';

/** Structured outcome so callers can log/act on WHY verification failed. */
export type WebhookSignatureFailureReason =
  | 'missing_signature'
  | 'length_mismatch'
  | 'digest_mismatch'
  | 'verification_error';

export interface WebhookSignatureResult {
  valid: boolean;
  reason?: WebhookSignatureFailureReason;
  /** Truncated prefixes for diagnostics. Never the full digest or secret. */
  receivedPrefix?: string;
  computedPrefix?: string;
}

/**
 * Verifies a GitHub `x-hub-signature-256` header against the raw payload.
 *
 * Returns a structured result rather than a bare boolean so the ingestion
 * route can record a precise blocker reason; `verifyGitHubWebhookSignature`
 * below is the boolean-compatible form used by existing call sites.
 */
export function checkGitHubWebhookSignature(
  payload: string,
  signature: string | undefined | null,
  secret: string
): WebhookSignatureResult {
  if (!signature) return { valid: false, reason: 'missing_signature' };
  try {
    const hmac = createHmac('sha256', secret);
    const digest = 'sha256=' + hmac.update(payload).digest('hex');

    const digestBuffer = Buffer.from(digest);
    const signatureBuffer = Buffer.from(signature);

    // Load-bearing: timingSafeEqual throws when lengths differ.
    if (digestBuffer.length !== signatureBuffer.length) {
      return {
        valid: false,
        reason: 'length_mismatch',
        receivedPrefix: signature.substring(0, 15) + '...',
        computedPrefix: digest.substring(0, 15) + '...',
      };
    }

    if (!timingSafeEqual(digestBuffer, signatureBuffer)) {
      return {
        valid: false,
        reason: 'digest_mismatch',
        receivedPrefix: signature.substring(0, 15) + '...',
        computedPrefix: digest.substring(0, 15) + '...',
      };
    }

    return { valid: true };
  } catch {
    // Fail closed on any crypto/encoding error, exactly as the original did.
    return { valid: false, reason: 'verification_error' };
  }
}

/**
 * Boolean form matching the original private method's contract, for the
 * existing adapter call site.
 */
export function verifyGitHubWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  return checkGitHubWebhookSignature(payload, signature, secret).valid;
}
