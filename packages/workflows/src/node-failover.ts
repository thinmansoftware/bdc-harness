/**
 * Node-level AVAILABILITY failover decision (WO-HARNESS-NODE-PROVIDER-FAILOVER-01).
 *
 * The third failure-class leg of the smart-cauldron doctrine (v1.1):
 *   - Quality      -> cascade CLIMBS   (implemented elsewhere)
 *   - Progress     -> watchdog KILL    (partial, elsewhere)
 *   - Availability -> failover SIDEWAYS (this module + dag-executor dispatch sites)
 *
 * When a prompt/loop node's provider call fails with an availability-class error,
 * the DAG executor re-dispatches that ONE node exactly once on a declared
 * `failover_provider`/`failover_model`. This module owns the single question the
 * executor asks: "is this error availability-class (safe to fall sideways) or not?"
 *
 * It REUSES the overseer classifier (`@archon/overseer/classify`) rather than
 * forking a new one, and it does NOT mutate that classifier: the cascade /
 * escalation paths (`packages/smart-cauldron`, `overseer-bridge.ts`) consume the
 * same `classifyError()` and must keep their exact semantics (spec Section 4:
 * "No conductor/cascade changes"). The small connection/timeout augmentation
 * below is kept LOCAL to the failover decision for that reason.
 */
import { classifyError, type ErrorClass } from '@archon/overseer/classify';

/**
 * Overseer error classes that count as AVAILABILITY -- the only classes that
 * justify a sideways provider failover.
 *
 * Deliberately narrow. Excluded on purpose (a different provider cannot fix them,
 * and failing over could mask a real fault):
 *   - auth_failed      -- operator /login needed; a second provider won't help
 *   - out_of_credits   -- billing; sideways provider is a separate billing account
 *                         but credit exhaustion is a distinct failure class the WO
 *                         scopes OUT of availability failover
 *   - invalid_request  -- YAML/code bug, not transient
 *   - every workflow-runtime / silent-dead-end class (sentinel_mismatch, etc.)
 */
const AVAILABILITY_ERROR_CLASSES: ReadonlySet<ErrorClass> = new Set([
  'rate_limit_exceeded', // HTTP 429 / "rate_limit_exceeded"     (overseer classify.ts)
  'service_unavailable', // HTTP 5xx / "service_unavailable"     (overseer classify.ts)
]);

/**
 * Connection/timeout substrings that the overseer classifier returns `unknown`
 * for (the message carries no HTTP status). Matched only AFTER the overseer
 * classifier has ruled out the non-availability provider classes, so an
 * auth/billing/invalid-request error whose text happens to contain one of these
 * words still does NOT failover.
 *
 * Evidence (spec Section 8 -- exact pattern list + source):
 *   - "network connection lost"     : observed verbatim in the live dev event
 *                                     store (remote_agent_workflow_events,
 *                                     event_type=node_failed, step_name=
 *                                     check-already-satisfied) -- a real AI-node
 *                                     availability failure.
 *   - econnreset / econnrefused /
 *     etimedout / socket hang up /
 *     network error                 : curated in the same repo's
 *                                     executor-shared.ts TRANSIENT_PATTERNS from
 *                                     prior Anthropic/provider incidents.
 *   - timeout / timed out           : provider request timeouts (transient).
 *   - overloaded / 529              : Anthropic HTTP 529 = service overloaded
 *                                     (executor-shared.ts TRANSIENT_PATTERNS note).
 */
export const AVAILABILITY_CONNECTION_PATTERNS: readonly string[] = [
  'timeout',
  'timed out',
  'etimedout',
  'econnreset',
  'econnrefused',
  'econnaborted',
  'socket hang up',
  'network error',
  'network connection lost',
  'connection error',
  'connection reset',
  'overloaded',
  '529',
];

/**
 * Non-availability provider classes. If the overseer classifier assigns one of
 * these, the error NEVER triggers failover -- even if the message text also
 * contains a connection-ish substring (e.g. an auth error whose stack mentions a
 * socket). This is the conservative guard the spec requires: auth errors and
 * other 4xx-class errors must not failover.
 */
const NON_AVAILABILITY_PROVIDER_CLASSES: ReadonlySet<ErrorClass> = new Set([
  'auth_failed',
  'out_of_credits',
  'invalid_request',
]);

/**
 * True when a node's provider failure is an AVAILABILITY-class error -- the only
 * class that triggers a one-shot sideways failover to a declared fallback provider.
 *
 * Conservative by design: an unrecognized error does NOT failover (returns false).
 *
 * @param message   the node failure message / provider error text
 * @param statusCode optional HTTP status code, if the caller has it separately
 */
export function isAvailabilityError(message: string | undefined, statusCode?: number): boolean {
  const cls = classifyError({
    message: message ?? '',
    ...(statusCode !== undefined ? { statusCode } : {}),
  });

  if (AVAILABILITY_ERROR_CLASSES.has(cls)) return true;

  // Auth / billing / invalid-request are explicitly NOT availability, regardless
  // of any connection-ish text in their message.
  if (NON_AVAILABILITY_PROVIDER_CLASSES.has(cls)) return false;

  // The overseer classifier returns `unknown` for bare connection/timeout text
  // (no HTTP status). Augment conservatively with the cited connection patterns.
  const lower = (message ?? '').toLowerCase();
  return AVAILABILITY_CONNECTION_PATTERNS.some(p => lower.includes(p));
}
