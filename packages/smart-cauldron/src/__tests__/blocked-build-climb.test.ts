import { describe, expect, test } from 'bun:test';
import { runCascade } from '../cascade.js';
import { classifyAttemptOutcome, judgeGate } from '../judge.js';
import type { FireResult, PollResult } from '../types.js';

// WO-HARNESS-BLOCKED-BUILD-NOT-COMPLETED-01: how the conductor treats a build that ended BLOCKED.
// Before the blocked-terminal-gate node the run ended `completed`; the conductor's gate then
// passed it whenever any pull request existed (for example one the agent opened mid-run).
// After the gate the run ends `failed` with `build_blocked: <status> <note>`, which the gate
// always fails, so the conductor climbs to the next rung.

const fire: FireResult = {
  ok: true,
  runId: 'fixture-run',
  conversationId: 'fixture',
  infraError: null,
};

const BLOCKED_ERROR =
  "DAG workflow 'bdc-feature-development-codex' completed with failures: 'blocked-terminal-gate': Bash node 'blocked-terminal-gate' failed [exit 1]: build_blocked: BLOCKED opus-made-changes-rereview-failed";

function poll(overrides: Partial<PollResult>): PollResult {
  return {
    runId: 'fixture-run',
    terminalStatus: 'completed',
    validatorVerdict: 'unknown',
    prUrl: null,
    prMergeable: null,
    servedModelId: null,
    rawMetadata: { teardown_confirmed_at: '2026-11-10T00:00:00Z' },
    ...overrides,
  };
}

const blockedFailed = poll({
  terminalStatus: 'failed',
  rawMetadata: {
    error: BLOCKED_ERROR,
    failed_nodes: ['blocked-terminal-gate'],
    teardown_confirmed_at: '2026-11-10T00:00:00Z',
  },
});

describe('blocked build and the conductor gate', () => {
  test('the old shape: a completed blocked build with a pull request is judged a WIN', () => {
    // This is the hole the gate closes: status completed + any PR url passes every condition.
    const oldShape = poll({ prUrl: 'https://github.com/o/r/pull/24' });
    expect(judgeGate(oldShape).pass).toBe(true);
    expect(classifyAttemptOutcome(fire, judgeGate(oldShape), oldShape)).toBe('won');
  });

  test('a completed blocked build with no pull request already failed the gate', () => {
    const noPr = poll({});
    expect(judgeGate(noPr).pass).toBe(false);
    expect(judgeGate(noPr).reason).toContain('no PR opened after completed run');
  });

  test('the new shape: a failed build_blocked run fails the gate and is a climb signal, not infra', () => {
    const verdict = judgeGate(blockedFailed);
    expect(verdict.pass).toBe(false);
    expect(verdict.cancelled).toBe(false);
    expect(verdict.reason).toContain('terminal status: failed');
    expect(classifyAttemptOutcome(fire, verdict, blockedFailed)).toBe('gate-failed');
  });

  test('the cascade climbs to the next rung after a build_blocked failure and can win there', async () => {
    let fires = 0;
    const record = await runCascade({
      woId: 'WO-BLOCKED-CLIMB-FIXTURE',
      project: 'fixture',
      entryOverride: 'cursor',
      token: 'fixture',
      deps: {
        findWoClaim: async () => null,
        listOpenWoPullRequests: async () => [],
        acquireWoLock: async (woId, project, cascadeId) => ({
          acquired: true,
          path: 'in-memory',
          record: { woId, project, cascadeId, status: 'running', createdAt: '', updatedAt: '' },
        }),
        releaseWoLock: async () => {},
        readRunDetail: async () => ({
          metadata: { teardown_confirmed_at: '2026-11-10T00:00:00Z' },
        }),
        fetchNodeTimeouts: async () => ({}),
        fire: async () => {
          fires++;
          return fire;
        },
        poll: async () =>
          fires === 1
            ? blockedFailed
            : poll({
                validatorVerdict: 'satisfied',
                prUrl: 'https://github.com/o/r/pull/1',
              }),
        writeRecord: async () => {},
        escalate: async () => {
          throw new Error('unexpected escalation');
        },
      },
    });
    expect(fires).toBe(2);
    expect(record.status).toBe('won');
    expect(record.attempts.map(attempt => attempt.outcome)).toEqual(['gate-failed', 'won']);
  });
});
