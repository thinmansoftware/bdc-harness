/**
 * gate-misfire.test.ts -- hermetic classifier matrix for harness gate misfires.
 *
 * No cascade, network, or filesystem. Each case quotes a live gate text.
 */

import { describe, expect, test } from 'bun:test';
import { classifyGateMisfire, type GateMisfireKind } from '../gate-misfire.js';
import type { PollResult } from '../types.js';

function poll(rawMetadata: Record<string, unknown>): PollResult {
  return {
    runId: 'run-stub',
    terminalStatus: 'failed',
    validatorVerdict: 'unknown',
    prUrl: null,
    prMergeable: null,
    servedModelId: null,
    rawMetadata,
  };
}

describe('classifyGateMisfire', () => {
  test('nine-result matrix, in order', () => {
    const cases: { metadata: Record<string, unknown>; expected: GateMisfireKind | null }[] = [
      { metadata: {}, expected: null },
      {
        metadata: {
          error:
            'HARNESS_REFUSED: 1 grep stop condition(s) were declared but none executed (grep_executed=0, grep_dropped=1, grep_unparsed=0)',
        },
        expected: 'evidence_harness_refused',
      },
      {
        metadata: {
          error:
            'SPEC_DEFECT: 4 grep stop condition(s) were declared but none executed (grep_executed=0, grep_dropped=2, grep_unparsed=2)',
          failed_nodes: ['run-stop-greps', 'manifest-evidence-check'],
        },
        expected: 'evidence_spec_defect',
      },
      {
        metadata: {
          error:
            'Loop iteration 1 failed: Cauldron auth for claude is dead (reason: refresh_expired)',
          failed_nodes: ['plan-review'],
        },
        expected: 'auth_dead',
      },
      {
        metadata: {
          error: 'build-manifest primaryReason gate_scope_mismatch',
          failed_nodes: ['build-manifest'],
        },
        expected: 'manifest_gate_scope_mismatch',
      },
      {
        metadata: {
          error: "exceeded max iterations (3) without completion signal 'PLAN_REVIEW_APPROVED'",
          failed_nodes: ['plan-review'],
        },
        expected: null,
      },
      {
        metadata: {
          error:
            'escalated at iteration 1: Provide a lane-verified repair-target record naming PR #1196 and its matching head branch.',
          failed_nodes: ['plan-review'],
        },
        expected: 'plan_review_record_demand',
      },
      {
        metadata: {
          error:
            'escalated at iteration 2: Have the lane verify PR #1120 and provide its matching head branch in the repair-target record.',
          failed_nodes: ['plan-review'],
        },
        expected: 'plan_review_record_demand',
      },
      {
        metadata: {
          error:
            "escalated at iteration 2: Re-run the lane's GitHub CLI repair-target verification and supply the lane-verified record; if it returns PR #1196 + branch archon/task-web-worker-1792508866189-fj3m6u, this plan is approvable as-is",
          failed_nodes: ['plan-review'],
        },
        expected: 'plan_review_record_demand',
      },
    ];

    const actual = cases.map(entry => classifyGateMisfire(poll(entry.metadata))?.kind ?? null);
    expect(actual).toEqual([
      null,
      'evidence_harness_refused',
      'evidence_spec_defect',
      'auth_dead',
      'manifest_gate_scope_mismatch',
      null,
      'plan_review_record_demand',
      'plan_review_record_demand',
      'plan_review_record_demand',
    ]);
  });

  test('held repair-target branch is repair_target_unavailable, not a later kind', () => {
    const error =
      "repair_target_branch_held: feat/x is checked out by /.archon/workspaces/o/r/worktrees/archon/task-web-worker-1-a; not reclaimed: live process cwd under holder; 'repair-gate-fail': Bash node 'repair-gate-fail' failed [exit 1]: repair_gate_closed: checkout_failed";
    const result = classifyGateMisfire(
      poll({
        error,
        failed_nodes: ['checkout-repair-target', 'repair-gate-fail'],
      })
    );
    expect(result?.kind).toBe('repair_target_unavailable');
    expect(result?.gateNode).toBe('checkout-repair-target');
    expect(result?.failedNodes).toEqual(['checkout-repair-target', 'repair-gate-fail']);
    expect(result?.reason).toBe(error);
  });

  test('repair_gate_closed: plan_review_skipped is a harness misfire', () => {
    const result = classifyGateMisfire(
      poll({
        error: 'repair_gate_closed: plan_review_skipped',
        failed_nodes: ['repair-gate-fail'],
      })
    );
    expect(result?.kind).toBe('repair_gate_closed');
    expect(result?.gateNode).toBe('repair-gate-fail');
  });

  test('repair_gate_closed: plan_review_not_approved is a quality failure', () => {
    const result = classifyGateMisfire(
      poll({
        error: 'repair_gate_closed: plan_review_not_approved',
        failed_nodes: ['plan-review', 'repair-gate-fail'],
      })
    );
    expect(result).toBeNull();
  });

  test('absent failed_nodes with HARNESS_REFUSED uses gateNode unknown', () => {
    const result = classifyGateMisfire(
      poll({
        error: 'HARNESS_REFUSED: 1 grep stop condition(s) were declared but none executed',
      })
    );
    expect(result?.kind).toBe('evidence_harness_refused');
    expect(result?.gateNode).toBe('unknown');
    expect(result?.failedNodes).toEqual([]);
  });
});
