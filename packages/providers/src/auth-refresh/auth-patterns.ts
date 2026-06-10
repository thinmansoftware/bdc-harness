/**
 * Shared auth-error pattern matchers for Claude + Codex providers AND the
 * orchestrator-agent's `msg.isError` branch.
 *
 * Behavior spec v2 invariant I-11 requires the orchestrator-agent to detect
 * auth-class errors using the SAME patterns the provider classifier uses.
 * Duplicating the array between provider and orchestrator would create drift
 * -- the orchestrator could miss patterns the provider learned about, or
 * vice versa.
 *
 * Provider classifier (classifyAndEnrichError / classifyAndEnrichCodexError)
 * imports from here. Orchestrator-agent imports from here. One source.
 *
 * Anchored to:
 *   - PR #48 (initial auth refresh)
 *   - PR #49 (broadened to catch the Claude binary's "Not logged in" /
 *             "Please run /login" pre-flight short-circuit)
 *   - WO-HARNESS-PROVIDER-PROACTIVE-AUTH-REFRESH-01 (orchestrator share)
 *
 * Additions adopted from upstream coleam00/Archon PR #1089 review:
 *   - 'refresh token', 'could not be refreshed', 'log out and sign in'
 *     cover Anthropic's terminal refresh-token-revoked / reused / expired
 *     server messages.
 */
export const AUTH_PATTERNS: readonly string[] = [
  'credit balance',
  'unauthorized',
  'authentication',
  'invalid token',
  '401',
  '403',
  // BDC fork addition (PR #49, 2026-05-15): Claude binary's own pre-flight
  // token check short-circuits with "Not logged in | Please run /login"
  // before any HTTP request. Without these patterns the error is
  // classified as 'unknown' and the OAuth refresh branch never engages.
  'not logged in',
  'please run /login',
  // BDC fork addition (PR #49, 2026-05-15): Codex binary's equivalent
  // pre-flight short-circuit messages. Mirrors the Claude additions above.
  'not signed in',
  "please run 'codex login'",
  // BDC fork addition (this WO, 2026-05-15): mirror upstream PR #1089
  // additions for terminal refresh-token-side errors so the orchestrator-
  // agent's I-11 branch and the provider classifier agree on auth-class.
  // 'log out and sign in' substring also matches Codex's
  // 'log out and sign in again' terminal refresh message.
  'refresh token',
  'could not be refreshed',
  'log out and sign in',
  // WO-HARNESS-CODEX-THREAD-RESUME-AND-FAILBACK-01 (2026-06-10): rollout/resume
  // tokens are intentionally EXCLUDED from AUTH_PATTERNS. The codex binary emits
  // "thread/resume failed: no rollout found for thread id X" when asked to resume
  // a thread whose rollout file no longer exists on disk. That is a runtime
  // subprocess crash (retryable with a fresh thread), NOT an auth failure --
  // classifying it as auth would short-circuit the crash retry and surface a
  // misleading "Codex auth error" to operators (who would then look for a
  // non-existent auth problem). The patterns
  //   'no rollout found', 'thread/resume failed', 'rollout not found'
  // are owned by packages/providers/src/codex/provider.ts (constant
  // ROLLOUT_MISSING_PATTERNS) and checked BEFORE AUTH_PATTERNS in
  // classifyCodexError() as defense-in-depth. Do NOT add any of those tokens to
  // this list. If a new auth-class token sounds similar to a rollout token,
  // verify (with a unit test) that it does not also substring-match a rollout
  // message before adding it here.
];

/**
 * Lowercase-substring match against AUTH_PATTERNS. Used by:
 *   - Provider classifiers (lowercase the combined errorMessage + stderr)
 *   - Orchestrator-agent's `msg.isError` branch (lowercase msg.errorSubtype)
 *
 * Returns true if any pattern is a substring of the input. Empty input
 * returns false (no false positives on missing data).
 */
export function isAuthErrorMessage(message: string | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return AUTH_PATTERNS.some(p => lower.includes(p));
}
