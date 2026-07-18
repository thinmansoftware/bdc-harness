import { describe, test, expect } from 'bun:test';
import { classifyError } from './classify.ts';
import { decide } from './decide.ts';
import type { ErrorClass } from './classify.ts';

describe('classifyError -- workflow-runtime classes (BDC 2026-05-16)', () => {
  test('sentinel_mismatch: loop node + SDK returned success message', () => {
    expect(
      classifyError({
        message: "Loop 'implement' iteration 1 failed: SDK returned success",
        nodeType: 'loop',
      })
    ).toBe('sentinel_mismatch');
  });

  test('validator_sdk_contradiction: non-loop node + SDK returned success, no nodeType', () => {
    expect(
      classifyError({
        message: "Node 'war-council-validator' failed: SDK returned success",
      })
    ).toBe('validator_sdk_contradiction');
  });

  test('validator_sdk_contradiction: loop case is unchanged (zero regression)', () => {
    expect(
      classifyError({
        message: "Loop 'implement' iteration 1 failed: SDK returned success",
        nodeType: 'loop',
      })
    ).toBe('sentinel_mismatch');
  });

  test('validator_sdk_contradiction: Node prefix wins over a mistaken nodeType', () => {
    expect(
      classifyError({
        message: "Node 'war-council-validator' failed: SDK returned success",
        nodeType: 'loop',
      })
    ).toBe('validator_sdk_contradiction');
  });

  test("npm_not_found: bash 'command not found: npm'", () => {
    expect(
      classifyError({
        message: 'bash: line 3: npm: command not found',
        nodeId: 'verify-build',
        exitCode: 127,
      })
    ).toBe('npm_not_found');
  });

  test('npm_not_found: also catches npx, pnpm, yarn', () => {
    expect(classifyError({ message: 'command not found: npx' })).toBe('npm_not_found');
    expect(classifyError({ message: 'command not found: pnpm' })).toBe('npm_not_found');
    expect(classifyError({ message: 'command not found: yarn' })).toBe('npm_not_found');
  });

  test("worktree_collision: 'is already used by worktree'", () => {
    expect(
      classifyError({
        message:
          "fatal: 'master' is already used by worktree at '/.archon/workspaces/.../thread-abc'",
      })
    ).toBe('worktree_collision');
  });

  test("worktree_collision: 'a branch named dev already exists'", () => {
    expect(
      classifyError({
        message: "fatal: a branch named 'dev' already exists",
      })
    ).toBe('worktree_collision');
  });

  test("branch_ref_missing: 'fatal: couldn't find remote ref'", () => {
    expect(
      classifyError({
        message: "fatal: couldn't find remote ref master",
      })
    ).toBe('branch_ref_missing');
  });

  test("spec_lookup_failed: read-spec node + exit 1 + 'Spec not found'", () => {
    expect(
      classifyError({
        message: 'Spec not found for WO_ID=WO-FOO-BAR-01',
        nodeId: 'read-spec',
        exitCode: 1,
      })
    ).toBe('spec_lookup_failed');
  });

  test("verify_pre_existing: verify-* node + non-zero exit + no 'not found'", () => {
    expect(
      classifyError({
        message: 'FAIL: expected >= 6 tests, got 2',
        nodeId: 'verify-tests',
        exitCode: 1,
      })
    ).toBe('verify_pre_existing');
  });
});

describe('classifyError -- provider classes (ported from router.py)', () => {
  test('rate_limit_exceeded: 429 status', () => {
    expect(classifyError({ statusCode: 429, message: 'Rate limit exceeded' })).toBe(
      'rate_limit_exceeded'
    );
  });

  test("out_of_credits: 'Credit balance is too low'", () => {
    expect(classifyError({ message: 'Credit balance is too low' })).toBe('out_of_credits');
  });

  test("out_of_credits: 'Credit exhaustion detected - resume when credits reset' (detectCreditExhaustion emit, WO-158)", () => {
    expect(
      classifyError({ message: 'Credit exhaustion detected - resume when credits reset' })
    ).toBe('out_of_credits');
  });

  test('service_unavailable: 5xx status', () => {
    expect(classifyError({ statusCode: 503, message: 'Service unavailable' })).toBe(
      'service_unavailable'
    );
    expect(classifyError({ statusCode: 500 })).toBe('service_unavailable');
  });

  test('auth_failed: 401, invalid_grant, refresh_expired', () => {
    expect(classifyError({ statusCode: 401, message: 'auth failed' })).toBe('auth_failed');
    expect(classifyError({ message: 'invalid_grant: refresh token expired' })).toBe('auth_failed');
    expect(
      classifyError({ message: 'Cauldron auth for claude is dead (reason: refresh_expired)' })
    ).toBe('auth_failed');
  });

  test('invalid_request: 400 status', () => {
    expect(classifyError({ statusCode: 400, message: 'bad json' })).toBe('invalid_request');
  });
});

describe('classifyError -- failure classes E-J (BDC 2026-07-17)', () => {
  test('scope_dirty_at_capture: run_scope_dirty_at_capture primary token', () => {
    expect(
      classifyError({
        message:
          "DAG workflow 'bdc-feature-development-codex' completed with failures: 'capture-run-scope': Bash node 'capture-run-scope' failed [exit 1]: run_scope_dirty_at_capture: working tree changed before run scope capture",
        nodeId: 'capture-run-scope',
        exitCode: 1,
      })
    ).toBe('scope_dirty_at_capture');
  });

  test('commit_blocked_no_authorization: blocked commit without approval authorization', () => {
    expect(
      classifyError({
        message:
          "DAG workflow 'bdc-feature-development-codex' completed with failures: 'commit-and-push': Bash node 'commit-and-push' failed [exit 1]: commit-and-push reached with status='BLOCKED' and no satisfied approve-with-fix or opus-rereview authorization",
        nodeId: 'commit-and-push',
        exitCode: 1,
      })
    ).toBe('commit_blocked_no_authorization');
  });

  test('plan_review_source_unreachable: escalated plan-review source phrases', () => {
    const phrases = [
      'could not be retrieved from the source repository',
      'source repository unreachable',
      'source returned 404',
      'cannot read the design reference',
      'expected method and format for reading the design',
    ];

    for (const phrase of phrases) {
      expect(
        classifyError({
          message: `DAG workflow 'bdc-feature-development-codex' completed with failures: 'plan-review': Loop node 'plan-review' escalated at iteration 2: SPEC_PATH github:bluedevilcollectibles/bdc-xo:docs/work-orders/WO-MISSING.md ${phrase}`,
          nodeId: 'plan-review',
          nodeType: 'loop',
        })
      ).toBe('plan_review_source_unreachable');
    }
  });

  test('H_shadow_bug: read-spec scope_authority_missing beats spec_lookup_failed', () => {
    expect(
      classifyError({
        message:
          "DAG workflow 'bdc-feature-development-codex' completed with failures: 'read-spec': Bash node 'read-spec' failed [exit 1]: scope_authority_missing: run-authority.json",
        nodeId: 'read-spec',
        exitCode: 1,
      })
    ).toBe('read_spec_scope_authority_missing');
  });

  test('read_spec_command_not_found: read-spec exit 127 missing command', () => {
    expect(
      classifyError({
        message:
          "DAG workflow 'bdc-feature-development-codex' completed with failures: 'read-spec': Bash node 'read-spec' failed [exit 127]: bash: line 1: read-spec: command not found",
        nodeId: 'read-spec',
        exitCode: 127,
      })
    ).toBe('read_spec_command_not_found');
  });

  test('reviewer_no_output: provider stream closed without assistant content', () => {
    expect(
      classifyError({
        message:
          "DAG workflow 'bdc-feature-development-codex' completed with failures: 'war-council-validator': Prompt node 'war-council-validator' failed: provider stream closed without yielding content",
        nodeId: 'war-council-validator',
        nodeType: 'prompt',
      })
    ).toBe('reviewer_no_output');
  });

  test('reviewer_no_output: produced no assistant output', () => {
    expect(
      classifyError({
        message:
          "DAG workflow 'bdc-feature-development-codex' completed with failures: 'diff-review': Prompt node 'diff-review' failed: produced no assistant output",
        nodeId: 'diff-review',
        nodeType: 'prompt',
      })
    ).toBe('reviewer_no_output');
  });

  test('loop_max_iterations: loop exceeded max iterations envelope', () => {
    expect(
      classifyError({
        message:
          "DAG workflow 'bdc-feature-development-codex' completed with failures: 'implement': Loop node 'implement' exceeded max iterations after 6 iterations",
        nodeId: 'implement',
        nodeType: 'loop',
      })
    ).toBe('loop_max_iterations');
  });

  test('loop_idle_timeout: loop iteration exceeded idle timeout envelope', () => {
    expect(
      classifyError({
        message:
          "DAG workflow 'bdc-feature-development-codex' completed with failures: 'implement': Loop 'implement' iteration 3 exceeded idle timeout (120000ms)",
        nodeId: 'implement',
        nodeType: 'loop',
      })
    ).toBe('loop_idle_timeout');
  });

  test('spec_lookup_unchanged: read-spec exit 1 without scope_authority_missing stays spec_lookup_failed', () => {
    expect(
      classifyError({
        message:
          "DAG workflow 'bdc-feature-development-codex' completed with failures: 'read-spec': Bash node 'read-spec' failed [exit 1]: Spec not found for WO_ID=WO-FOO-BAR-01",
        nodeId: 'read-spec',
        exitCode: 1,
      })
    ).toBe('spec_lookup_failed');
  });

  test('I_no_shadow: loop SDK-returned-success stays sentinel_mismatch', () => {
    expect(
      classifyError({
        message:
          "DAG workflow 'bdc-feature-development-codex' completed with failures: 'implement': Loop 'implement' iteration 1 failed: SDK returned success",
        nodeId: 'implement',
        nodeType: 'loop',
      })
    ).toBe('sentinel_mismatch');
  });

  test('G_negative: plan-review design and format words without source phrase stays unknown', () => {
    expect(
      classifyError({
        message:
          "DAG workflow 'bdc-feature-development-codex' completed with failures: 'plan-review': Loop node 'plan-review' escalated at iteration 1: the design of the output format needs work",
        nodeId: 'plan-review',
        nodeType: 'loop',
      })
    ).toBe('unknown');
  });

  test('J_wall_timeout: wall-timeout loop envelope maps to loop_idle_timeout', () => {
    expect(
      classifyError({
        message:
          "DAG workflow 'bdc-feature-development-codex' completed with failures: 'implement': Loop 'implement' iteration 1 exceeded wall timeout (480000ms)",
        nodeId: 'implement',
        nodeType: 'loop',
      })
    ).toBe('loop_idle_timeout');
  });
});

describe('classifyError -- fallback', () => {
  test('unknown for unrecognized input', () => {
    expect(classifyError({ message: 'something weird happened' })).toBe('unknown');
    expect(classifyError({})).toBe('unknown');
  });
});

describe('decide -- provider classes', () => {
  test('rate_limit retries with exponential backoff up to attempt 3', () => {
    const r1 = decide({ errorClass: 'rate_limit_exceeded', attempt: 1 });
    expect(r1.decision).toBe('retry');
    expect(r1.backoffMs).toBe(2000); // 2 * 2^1 = 2000? actually 1000*2^1 = 2000... wait
    // Formula in decide.ts: 1000 * Math.pow(2, attempt) -> attempt 1 = 2000ms
    expect(r1.backoffMs).toBeGreaterThan(0);

    const r3 = decide({ errorClass: 'rate_limit_exceeded', attempt: 3 });
    expect(r3.decision).toBe('escalate');
  });

  test('out_of_credits escalates (provider failover deferred to v2)', () => {
    expect(decide({ errorClass: 'out_of_credits', attempt: 1 }).decision).toBe('escalate');
  });

  test('auth_failed escalates (cron handles refresh, manual /login if persists)', () => {
    expect(decide({ errorClass: 'auth_failed', attempt: 1 }).decision).toBe('escalate');
  });
});

describe('decide -- workflow-runtime classes', () => {
  test('sentinel_mismatch with output -> commit_and_push_anyway', () => {
    const r = decide({ errorClass: 'sentinel_mismatch', attempt: 1, hasOutput: true });
    expect(r.decision).toBe('commit_and_push_anyway');
  });

  test('sentinel_mismatch without output -> escalate', () => {
    const r = decide({ errorClass: 'sentinel_mismatch', attempt: 1, hasOutput: false });
    expect(r.decision).toBe('escalate');
  });

  test('npm_not_found -> skip (legacy YAML; container is bun-only)', () => {
    const r = decide({ errorClass: 'npm_not_found', attempt: 1 });
    expect(r.decision).toBe('skip');
  });

  test("verify_pre_existing -> skip (post-Patch-1, verify-* shouldn't exist; if it does, ignore)", () => {
    const r = decide({ errorClass: 'verify_pre_existing', attempt: 1 });
    expect(r.decision).toBe('skip');
  });

  test('worktree_collision -> escalate (Rule 17 violation in YAML)', () => {
    const r = decide({ errorClass: 'worktree_collision', attempt: 1 });
    expect(r.decision).toBe('escalate');
  });

  test('branch_ref_missing -> escalate (Rule 16 violation)', () => {
    const r = decide({ errorClass: 'branch_ref_missing', attempt: 1 });
    expect(r.decision).toBe('escalate');
  });

  test('spec_lookup_failed retries once then escalates', () => {
    expect(decide({ errorClass: 'spec_lookup_failed', attempt: 1 }).decision).toBe('retry');
    expect(decide({ errorClass: 'spec_lookup_failed', attempt: 2 }).decision).toBe('escalate');
  });

  test('validator_sdk_contradiction -> escalate even with output (never auto-recovers)', () => {
    const r = decide({ errorClass: 'validator_sdk_contradiction', attempt: 1, hasOutput: true });
    expect(r.decision).toBe('escalate');
  });

  test('validator_sdk_contradiction -> populates escalationContext for operator evidence', () => {
    const r = decide({
      errorClass: 'validator_sdk_contradiction',
      attempt: 1,
      nodeId: 'war-council-validator',
      woId: 'WO-TEST-01',
      validatorOutput: 'some output',
    });
    expect(r.escalationContext).toBeDefined();
    expect(r.escalationContext?.errorClass).toBe('validator_sdk_contradiction');
    expect(r.escalationContext?.nodeId).toBe('war-council-validator');
    expect(r.escalationContext?.woId).toBe('WO-TEST-01');
  });
});

describe('decide -- failure classes E-J', () => {
  test('decisions_are_escalate_only: every new class escalates without action command context', () => {
    const newClasses: ErrorClass[] = [
      'scope_dirty_at_capture',
      'commit_blocked_no_authorization',
      'plan_review_source_unreachable',
      'read_spec_scope_authority_missing',
      'read_spec_command_not_found',
      'reviewer_no_output',
      'loop_max_iterations',
      'loop_idle_timeout',
    ];

    for (const errorClass of newClasses) {
      const result = decide({ errorClass, attempt: 1 });
      const rawResult = result as Record<string, unknown>;

      expect(result.decision).toBe('escalate');
      expect(result.escalationContext).toBeUndefined();
      expect(rawResult.action).toBeUndefined();
      expect(rawResult.adapter).toBeUndefined();
      expect(rawResult.command).toBeUndefined();
      expect(result.reason).not.toMatch(/\b(re-fire|climb|clean|chown|salvage)\b/i);
    }
  });
});

describe('decide -- unknown', () => {
  test('unknown class -> escalate (preserve current behavior)', () => {
    const r = decide({ errorClass: 'unknown', attempt: 1 });
    expect(r.decision).toBe('escalate');
    expect(r.reason).toContain('unknown');
  });
});
