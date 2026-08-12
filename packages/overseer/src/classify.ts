/**
 * Error classification for Cauldron workflow failures.
 *
 * Ports overlord/router.py classify_error() to TypeScript + extends with workflow-specific
 * classes surfaced during 2026-05-16 Wave 1 sortie (sentinel mismatch, npm-not-found,
 * pre-existing verify rot, worktree collision).
 *
 * Design authority: 2026-05-09 WO-HARNESS-OVERLORD-PROVIDER-FAILOVER-01 (Python prior art).
 */

const READ_SPEC_SCOPE_AUTHORITY_MISSING = 'read_spec_scope_authority_missing' as const;

export type ErrorClass =
  // Provider/network errors (ported from router.py)
  | 'rate_limit_exceeded'
  | 'out_of_credits'
  | 'service_unavailable'
  | 'auth_failed'
  | 'invalid_request'
  // Workflow-runtime errors (new, from 2026-05-16)
  | 'sentinel_mismatch' // implement loop ended without matching `until:` sentinel
  | 'npm_not_found' // bun-only container, npm/npx/pnpm/yarn missing
  | 'verify_pre_existing' // verify-* failed on rot unrelated to WO diff
  | 'worktree_collision' // git: branch already used by another worktree
  // Failure Classes E-J (2026-07-17): six doctrine classes split into eight code values
  | 'scope_dirty_at_capture'
  | 'commit_blocked_no_authorization'
  | 'plan_review_source_unreachable'
  | typeof READ_SPEC_SCOPE_AUTHORITY_MISSING
  | 'read_spec_command_not_found'
  | 'reviewer_no_output'
  | 'loop_max_iterations'
  | 'loop_idle_timeout'
  | 'spec_lookup_failed' // read-spec couldn't fetch WO spec from bdc-xo
  | 'branch_ref_missing' // git: fatal: couldn't find remote ref
  // Silent-dead-end classes (new, from 2026-05-18 Wave A anchor incidents)
  | 'implement_loop_no_output' // commit-and-push: no diff, no validator feedback
  | 'validator_feedback_not_applied' // commit-and-push: validator emitted actionable feedback but agent did not iterate
  | 'validator_rejected' // war-council-validator stdout begins with REJECT/BLOCK/FAIL
  | 'implement_loop_skipped' // commit-and-push: thread branch HEAD-only, agent never wrote to disk
  | 'validator_sdk_contradiction' // non-loop node (e.g. war-council-validator): Anthropic SDK returned isError=true + errorSubtype='success' (bdc-harness#344), previously fell through to unknown with no escalation
  // Fallback
  | 'unknown';

export interface ClassifyInput {
  /** HTTP status code if known (provider response, gh api, etc.) */
  statusCode?: number;
  /** Error message or stderr text */
  message?: string;
  /** Node ID where failure occurred (helps disambiguate sentinel vs verify) */
  nodeId?: string;
  /** Node type (bash, prompt, loop) */
  nodeType?: string;
  /** Exit code if from bash node */
  exitCode?: number;
  /**
   * Optional war-council-validator stdout captured from a sibling node output.
   * Used to disambiguate `implement_loop_no_output` vs `validator_feedback_not_applied`,
   * and to detect `validator_rejected` from a non-validator failure site (e.g. commit-and-push).
   */
  validatorOutput?: string;
  /**
   * Optional count of commits on the thread branch ahead of origin/main (or whatever the
   * base branch is). Used as contextual signal in escalation payloads; not load-bearing
   * for the current classifier branches but documented here for future per-class rules.
   */
  threadCommitsAhead?: number;
  /**
   * Optional flag indicating whether the unique remote branch already exists at origin.
   * Distinguishes `implement_loop_no_output` (origin branch reachable, just no diff) from
   * `implement_loop_skipped` (origin branch missing AND no commits anywhere -- agent never wrote).
   */
  hasOriginBranch?: boolean;
}

/** Detect the session-limit marker that makes an SDK contradiction usage-cap recoverable. */
export function classifyUsageCapSignature(input: ClassifyInput): boolean {
  const evidence = `${input.message ?? ''}\n${input.validatorOutput ?? ''}`;
  return /you(?:'|\u2019)?ve hit your session limit/i.test(evidence);
}

/**
 * Classify a workflow failure into a known error class.
 * Returns "unknown" for unrecognized errors (caller decides what to do -- usually escalate).
 *
 * Priority order matters: workflow-runtime classes checked first because they have specific
 * markers (e.g. "command not found: npm") that won't appear in provider errors.
 */
export function classifyError(input: ClassifyInput): ErrorClass {
  const msg = (input.message ?? '').toLowerCase();
  const status = input.statusCode;
  const exit = input.exitCode;
  const rawMessage = input.message ?? '';
  const validatorText = input.validatorOutput ?? '';

  // --- Silent-dead-end classes (BDC-specific, 2026-05-18 Wave A anchor incidents) ---
  //
  // Order matters: validator_rejected is checked first so a REJECT/BLOCK/FAIL signal
  // wins over the action-verb heuristic in validator_feedback_not_applied (e.g. a
  // validator output of "REJECT: must add X" is still a REJECT, not feedback to apply).

  // REJECT/BLOCK/FAIL at the start of any line of validator output.
  // Two entry conditions:
  //   (a) the failing node IS the validator and its message contains the token (Test 3)
  //   (b) a downstream node failed and we have the validator stdout in context (Test 5
  //       variant; current bridge wiring forwards validatorOutput when available)
  const validatorRejectPattern = /^(REJECT|BLOCK|FAIL)\b/m;
  if (input.nodeId === 'war-council-validator' && validatorRejectPattern.test(rawMessage)) {
    return 'validator_rejected';
  }
  if (input.validatorOutput !== undefined && validatorRejectPattern.test(validatorText)) {
    return 'validator_rejected';
  }

  // commit-and-push stderr emitted when COMMITS_AHEAD = 0 (see
  // .archon/workflows/defaults/bdc-feature-development.yaml ~line 289).
  // Three distinct downstream classifications depend on additional context:
  //   - validator emitted actionable remediation -> validator_feedback_not_applied
  //   - thread branch is HEAD-only (origin branch missing + no commits anywhere) -> implement_loop_skipped
  //   - else -> implement_loop_no_output
  const implementLoopStderr = /implement loop did not produce work/i;
  if (implementLoopStderr.test(rawMessage)) {
    const actionVerbs = /\b(add|fix|include|must|should|needs?)\b/i;
    if (input.validatorOutput && actionVerbs.test(validatorText)) {
      return 'validator_feedback_not_applied';
    }
    if (input.hasOriginBranch === false && (input.threadCommitsAhead ?? 0) === 0) {
      return 'implement_loop_skipped';
    }
    return 'implement_loop_no_output';
  }

  // --- Workflow-runtime classes (BDC-specific, 2026-05-16) ---

  // Validator SDK contradiction: the Anthropic SDK returned isError=true +
  // errorSubtype='success' on a NON-loop node (e.g. war-council-validator), a
  // provider-side glitch (bdc-harness#344). Checked BEFORE sentinel_mismatch so the
  // `Node '` message prefix wins even against a malformed nodeType (Test 3). The
  // `Node '` vs `Loop '` message prefix is the primary and sufficient discriminator:
  // the regex already excludes `Loop '...` messages, so no nodeType gate is applied
  // here (gating on nodeType !== 'loop' would wrongly re-route the malformed
  // Node-prefix + nodeType='loop' case back to sentinel_mismatch, violating Test 3).
  const validatorSdkContradiction = /^Node '.+' failed: SDK returned success\b/;
  if (validatorSdkContradiction.test(rawMessage)) {
    return 'validator_sdk_contradiction';
  }

  // Sentinel mismatch: implement loop iteration ended without finding `until:` string
  if (msg.includes('sdk returned success') && input.nodeType === 'loop') {
    return 'sentinel_mismatch';
  }

  // npm-not-found: bun container missing npm/npx/pnpm/yarn
  if (
    /command not found:?\s+(npm|npx|pnpm|yarn)/i.test(input.message ?? '') ||
    /bash:.*:\s+(npm|npx|pnpm|yarn):\s+command not found/i.test(input.message ?? '')
  ) {
    return 'npm_not_found';
  }

  // Worktree collision: git: branch already used
  if (
    /is already used by worktree/i.test(input.message ?? '') ||
    /fatal: a branch named .* already exists/i.test(input.message ?? '')
  ) {
    return 'worktree_collision';
  }

  // Branch ref missing: master/main hardcoded but doesn't exist
  if (/fatal: couldn't find remote ref/i.test(input.message ?? '')) {
    return 'branch_ref_missing';
  }

  // Failure Classes E-J (2026-07-17). Doctrine names six classes; code splits H and J
  // into separate operational values for distinct observable failure modes.
  if (rawMessage.includes('run_scope_dirty_at_capture')) {
    return 'scope_dirty_at_capture';
  }

  if (
    rawMessage.includes(
      "commit-and-push reached with status='BLOCKED' and no satisfied approve-with-fix or opus-rereview authorization"
    )
  ) {
    return 'commit_blocked_no_authorization';
  }

  if (
    /plan-review' escalated at iteration \d+/i.test(rawMessage) &&
    /(could not be retrieved|unreachable|404|cannot read the design|expected method and format for reading)/i.test(
      rawMessage
    )
  ) {
    return 'plan_review_source_unreachable';
  }

  if (input.nodeId === 'read-spec' && exit === 1 && msg.includes('scope_authority_missing')) {
    return READ_SPEC_SCOPE_AUTHORITY_MISSING;
  }

  if (
    input.nodeId === 'read-spec' &&
    (exit === 127 || /exit 127|command not found/i.test(rawMessage))
  ) {
    return 'read_spec_command_not_found';
  }

  if (
    msg.includes('produced no assistant output') ||
    msg.includes('provider stream closed without yielding content')
  ) {
    return 'reviewer_no_output';
  }

  if (/Loop node '[^']+' exceeded max iterations/.test(rawMessage)) {
    return 'loop_max_iterations';
  }

  if (/Loop '[^']+' iteration \d+ exceeded (idle|wall) timeout/.test(rawMessage)) {
    return 'loop_idle_timeout';
  }

  // Spec lookup failed
  if (
    /spec not found for wo_id/i.test(input.message ?? '') ||
    (input.nodeId === 'read-spec' && exit === 1)
  ) {
    return 'spec_lookup_failed';
  }

  // Verify pre-existing rot: verify-* node failed but on a check-not-in-WO-scope
  // (heuristic: verify-* node failed AND error mentions tests/build/types unrelated to common WO file changes)
  if (
    /^verify-/i.test(input.nodeId ?? '') &&
    exit !== 0 &&
    !msg.includes('not found') // not npm-not-found (already handled above)
  ) {
    return 'verify_pre_existing';
  }

  // --- Provider/network classes (ported from router.py) ---

  if (
    msg.includes('out_of_credits') ||
    msg.includes('credit balance is too low') ||
    msg.includes('credit exhaustion detected') ||
    msg.includes('insufficient_quota') ||
    // OpenRouter/Grok 402 phrasing (verified live 2026-07-18, run db45cdbf --
    // real failure previously misclassified as 'unknown'):
    // "402 This request requires more credits, or fewer max_tokens... add more credits"
    (status === 402 && msg.includes('credit')) ||
    /requires more credits/i.test(rawMessage) ||
    /add more credits/i.test(rawMessage)
  ) {
    return 'out_of_credits';
  }

  if (msg.includes('rate_limit_exceeded') || status === 429) {
    return 'rate_limit_exceeded';
  }

  if (
    msg.includes('service_unavailable') ||
    msg.includes('model_not_found') ||
    msg.includes('model_deprecated') ||
    (typeof status === 'number' && status >= 500 && status <= 599)
  ) {
    return 'service_unavailable';
  }

  if (
    msg.includes('authentication_failed') ||
    msg.includes('invalid_grant') ||
    msg.includes('refresh_expired') ||
    status === 401 ||
    status === 403
  ) {
    return 'auth_failed';
  }

  if (msg.includes('invalid_request') || status === 400) {
    return 'invalid_request';
  }

  return 'unknown';
}
