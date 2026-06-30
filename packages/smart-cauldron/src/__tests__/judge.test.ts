/**
 * judge.test.ts -- Real judgeGate() coverage (no stubs).
 *
 * Rule 10 compliance: every test calls the REAL judgeGate() with a concrete PollResult
 * and asserts the actual gate logic output.
 *
 * Gate conditions under test:
 *   1. terminal status: "completed" passes; "failed"/"cancelled" fails.
 *   2. validator verdict: "needs_revision" fails; "unknown" abstains; "satisfied" passes.
 *   3. PR opened: if completed but prUrl===null, fails.
 *   4. PR mergeable: prMergeable===false fails; null abstains.
 */

import { describe, test, expect } from 'bun:test';
import { judgeGate } from '../judge.js';
import type { PollResult } from '../types.js';

function makePoll(overrides?: Partial<PollResult>): PollResult {
  return {
    runId: 'run-judge-test',
    terminalStatus: 'completed',
    validatorVerdict: 'satisfied',
    prUrl: 'https://github.com/org/repo/pull/42',
    prMergeable: true,
    servedModelId: null,
    rawMetadata: {},
    ...overrides,
  };
}

describe('judgeGate -- real 4-condition gate logic', () => {
  // ---------------------------------------------------------------------------
  // All-pass baseline
  // ---------------------------------------------------------------------------

  test('all conditions pass -> verdict.pass=true, reason="all gate conditions passed"', () => {
    const verdict = judgeGate(makePoll());
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBe('all gate conditions passed');
    expect(verdict.validatorVerdict).toBe('satisfied');
    expect(verdict.prOpened).toBe(true);
    expect(verdict.prMergeable).toBe(true);
    expect(verdict.terminalStatus).toBe('completed');
  });

  // ---------------------------------------------------------------------------
  // Condition 1: terminal status
  // ---------------------------------------------------------------------------

  test('condition 1: terminalStatus=failed -> pass=false, reason contains "terminal status: failed"', () => {
    const verdict = judgeGate(makePoll({ terminalStatus: 'failed' }));
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('terminal status: failed');
    expect(verdict.terminalStatus).toBe('failed');
  });

  test('condition 1: terminalStatus=cancelled -> pass=false, reason contains "terminal status: cancelled"', () => {
    const verdict = judgeGate(makePoll({ terminalStatus: 'cancelled' }));
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('terminal status: cancelled');
  });

  test('condition 1: terminalStatus=completed with all else passing -> pass=true', () => {
    const verdict = judgeGate(makePoll({ terminalStatus: 'completed' }));
    expect(verdict.pass).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Condition 2: validator verdict
  // ---------------------------------------------------------------------------

  test('condition 2: validatorVerdict=needs_revision -> pass=false, reason contains "validator verdict: needs_revision"', () => {
    const verdict = judgeGate(makePoll({ validatorVerdict: 'needs_revision' }));
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('validator verdict: needs_revision');
    expect(verdict.validatorVerdict).toBe('needs_revision');
  });

  test('condition 2: validatorVerdict=unknown -> abstains (does not add a failing reason)', () => {
    const verdict = judgeGate(makePoll({ validatorVerdict: 'unknown' }));
    // unknown does not fail the gate when all other conditions pass
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBe('all gate conditions passed');
    expect(verdict.validatorVerdict).toBe('unknown');
  });

  test('condition 2: validatorVerdict=satisfied -> passes (no contribution to failure)', () => {
    const verdict = judgeGate(makePoll({ validatorVerdict: 'satisfied' }));
    expect(verdict.pass).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Condition 3: PR opened (only fires when terminalStatus=completed)
  // ---------------------------------------------------------------------------

  test('condition 3: completed + prUrl=null -> pass=false, reason contains "no PR opened after completed run"', () => {
    const verdict = judgeGate(makePoll({ prUrl: null, prMergeable: null }));
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('no PR opened after completed run');
    expect(verdict.prOpened).toBe(false);
  });

  test('condition 3: failed + prUrl=null -> condition 3 does NOT fire; only condition 1 fails', () => {
    const verdict = judgeGate(
      makePoll({ terminalStatus: 'failed', prUrl: null, prMergeable: null })
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('terminal status: failed');
    expect(verdict.reason).not.toContain('no PR opened after completed run');
  });

  test('condition 3: cancelled + prUrl=null -> condition 3 does NOT fire; only condition 1 fails', () => {
    const verdict = judgeGate(
      makePoll({ terminalStatus: 'cancelled', prUrl: null, prMergeable: null })
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('terminal status: cancelled');
    expect(verdict.reason).not.toContain('no PR opened');
  });

  test('condition 3: completed + prUrl set -> condition 3 does not fire', () => {
    const verdict = judgeGate(makePoll({ prUrl: 'https://github.com/org/repo/pull/99' }));
    expect(verdict.pass).toBe(true);
    expect(verdict.prOpened).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Condition 4: PR mergeable
  // ---------------------------------------------------------------------------

  test('condition 4: prMergeable=false -> pass=false, reason contains "PR is not mergeable"', () => {
    const verdict = judgeGate(makePoll({ prMergeable: false }));
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('PR is not mergeable');
    expect(verdict.prMergeable).toBe(false);
  });

  test('condition 4: prMergeable=null -> abstains (does not add a failing reason)', () => {
    const verdict = judgeGate(makePoll({ prMergeable: null }));
    expect(verdict.pass).toBe(true);
    expect(verdict.prMergeable).toBeNull();
  });

  test('condition 4: prMergeable=true -> passes', () => {
    const verdict = judgeGate(makePoll({ prMergeable: true }));
    expect(verdict.pass).toBe(true);
    expect(verdict.prMergeable).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Multiple conditions failing simultaneously
  // ---------------------------------------------------------------------------

  test('conditions 1+2 failing: all listed in reason, separated by "; "', () => {
    const verdict = judgeGate(
      makePoll({ terminalStatus: 'failed', validatorVerdict: 'needs_revision' })
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('terminal status: failed');
    expect(verdict.reason).toContain('validator verdict: needs_revision');
    // Both should appear in the same reason string
    expect(verdict.reason.split(';').length).toBeGreaterThanOrEqual(2);
  });

  test('conditions 2+4 failing: both appear in reason', () => {
    const verdict = judgeGate(makePoll({ validatorVerdict: 'needs_revision', prMergeable: false }));
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('validator verdict: needs_revision');
    expect(verdict.reason).toContain('PR is not mergeable');
  });

  test('conditions 1+2+4 failing (completed baseline broken): all three appear', () => {
    const verdict = judgeGate(
      makePoll({ terminalStatus: 'failed', validatorVerdict: 'needs_revision', prMergeable: false })
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('terminal status: failed');
    expect(verdict.reason).toContain('validator verdict: needs_revision');
    expect(verdict.reason).toContain('PR is not mergeable');
    // Condition 3 should NOT fire (terminalStatus != completed)
    expect(verdict.reason).not.toContain('no PR opened');
  });
});
