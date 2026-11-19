import { describe, expect, test } from 'bun:test';
import { runCascade, type CascadeDeps } from '../cascade.js';
import { classifyAttemptOutcome, judgeGate } from '../judge.js';
import type { FireResult, PollResult } from '../types.js';

const fire: FireResult = {
  ok: true,
  runId: 'fixture-run',
  conversationId: 'fixture',
  infraError: null,
};
function poll(error: string): PollResult {
  return {
    runId: 'fixture-run',
    terminalStatus: 'failed',
    validatorVerdict: 'unknown',
    prUrl: null,
    prMergeable: null,
    servedModelId: null,
    rawMetadata: {
      error,
      failed_nodes: ['manifest-evidence-check'],
      teardown_confirmed_at: '2026-11-09T00:00:00Z',
    },
  };
}
const sentinel =
  'Bash node manifest-evidence-check failed: ENVIRONMENT_UNAVAILABLE: postgres capability absent in this lane';

describe('environment unavailable', () => {
  test('a genuine assertion failure fires a second tier and can win', async () => {
    let fires = 0;
    const record = await runCascade({
      woId: 'WO-ASSERTION-FIXTURE',
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
          metadata: { teardown_confirmed_at: '2026-11-09T00:00:00Z' },
        }),
        fetchNodeTimeouts: async () => ({}),
        fire: async () => {
          fires++;
          return fire;
        },
        poll: async () =>
          fires === 1
            ? poll('AssertionError: 0/1; Cannot find module pg')
            : {
                ...poll(''),
                terminalStatus: 'completed',
                validatorVerdict: 'satisfied',
                prUrl: 'https://github.com/o/r/pull/1',
              },
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

  test('classifies the failed-run sentinel, never service-looking assertion output', () => {
    const unavailable = poll(sentinel);
    expect(classifyAttemptOutcome(fire, judgeGate(unavailable), unavailable)).toBe(
      'environment-unavailable'
    );
    const assertion = poll('Tests: 0/1 -- Cannot find module pg; connection refused');
    expect(classifyAttemptOutcome(fire, judgeGate(assertion), assertion)).toBe('gate-failed');
    const completed = {
      ...unavailable,
      terminalStatus: 'completed' as const,
      validatorVerdict: 'satisfied' as const,
      prUrl: 'https://github.com/o/r/pull/1',
    };
    expect(classifyAttemptOutcome(fire, judgeGate(completed), completed)).toBe('won');
  });

  for (const entry of ['codex', 'frontier']) {
    test(`stops blocked on ${entry}, with no climb, repair or escalation`, async () => {
      let fires = 0;
      let escalations = 0;
      let repairs = 0;
      const deps: CascadeDeps = {
        findWoClaim: async () => null,
        listOpenWoPullRequests: async () => [],
        acquireWoLock: async (woId, project, cascadeId) => ({
          acquired: true,
          path: 'in-memory',
          record: { woId, project, cascadeId, status: 'running', createdAt: '', updatedAt: '' },
        }),
        releaseWoLock: async () => {},
        fetchNodeTimeouts: async () => ({}),
        fire: async () => {
          fires++;
          return fire;
        },
        poll: async () => poll(sentinel),
        escalate: async () => {
          escalations++;
        },
        specRepair: async () => {
          repairs++;
          return { posted: false, issueRepo: null, issueNumber: null };
        },
        writeRecord: async () => {},
      };
      const record = await runCascade({
        woId: 'WO-ENV-FIXTURE',
        project: 'fixture',
        entryOverride: entry,
        token: 'fixture',
        deps,
      });
      expect(record.status).toBe('blocked');
      expect(record.blockedReason).toBe('environment_unavailable');
      expect(record.attempts).toHaveLength(1);
      expect(record.attempts[0].outcome).toBe('environment-unavailable');
      expect(record.attempts[0].gateFailReason).toContain('postgres capability absent');
      expect(record.telemetry.climbCount).toBe(0);
      expect([fires, escalations, repairs]).toEqual([1, 0, 0]);
    });
  }
});
