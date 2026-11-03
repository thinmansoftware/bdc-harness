/**
 * judge.test.ts -- pure-function coverage for judgeGate + classifyAttemptOutcome.
 *
 * Locks in Motion M-86: a cancelled run must NEVER be judged pass:true and must
 * classify as the distinct 'cancelled' outcome (not 'gate-failed', not 'won'),
 * regardless of the other gate fields. A naive fix that merely stops pushing
 * 'terminal status: cancelled' into failingReasons -- without forcing pass:false --
 * would compute pass:true for a realistic cancelled PollResult (prUrl:null,
 * prMergeable:null, validatorVerdict:'unknown'), the exact outcome the motion forbids.
 */

import { describe, test, expect } from 'bun:test';
import { judgeGate, classifyAttemptOutcome } from '../judge.js';
import { pollForTerminal } from '../poll.js';
import type { PollResult, FireResult } from '../types.js';

function makePoll(overrides?: Partial<PollResult>): PollResult {
  return {
    runId: 'run-stub',
    terminalStatus: 'completed',
    validatorVerdict: 'satisfied',
    prUrl: 'https://github.com/org/repo/pull/1',
    prMergeable: true,
    servedModelId: null,
    rawMetadata: {},
    ...overrides,
  };
}

function makeFireOk(): FireResult {
  return { ok: true, runId: 'run-1', conversationId: 'conv-1', infraError: null };
}

describe('judgeGate: cancelled', () => {
  test('cancelled with realistic empty fields is not a pass and is flagged cancelled', () => {
    const verdict = judgeGate(
      makePoll({
        terminalStatus: 'cancelled',
        prUrl: null,
        prMergeable: null,
        validatorVerdict: 'unknown',
      })
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.cancelled).toBe(true);
    expect(verdict.reason).toContain('cancelled externally');
  });

  test('cancelled with otherwise-clean fields is STILL not a pass', () => {
    // validator satisfied, PR opened + mergeable -- would pass if judged normally.
    const verdict = judgeGate(
      makePoll({
        terminalStatus: 'cancelled',
        validatorVerdict: 'satisfied',
        prUrl: 'https://github.com/org/repo/pull/9',
        prMergeable: true,
      })
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.cancelled).toBe(true);
  });
});

describe('judgeGate: non-cancelled paths carry cancelled:false', () => {
  test('completed + satisfied + mergeable PR passes with cancelled:false', () => {
    const verdict = judgeGate(makePoll());
    expect(verdict.pass).toBe(true);
    expect(verdict.cancelled).toBe(false);
  });

  test('failed is a climb signal (fails, not cancelled)', () => {
    const verdict = judgeGate(makePoll({ terminalStatus: 'failed', prUrl: null }));
    expect(verdict.pass).toBe(false);
    expect(verdict.cancelled).toBe(false);
    expect(verdict.reason).toContain('failed');
  });

  test('escalated is a climb signal (fails, not cancelled)', () => {
    const verdict = judgeGate(makePoll({ terminalStatus: 'escalated', prUrl: null }));
    expect(verdict.pass).toBe(false);
    expect(verdict.cancelled).toBe(false);
    expect(verdict.reason).toContain('escalated');
  });
});

describe('classifyAttemptOutcome: cancelled', () => {
  test('cancelled verdict classifies as cancelled, not gate-failed', () => {
    const verdict = judgeGate(
      makePoll({ terminalStatus: 'cancelled', prUrl: null, prMergeable: null })
    );
    expect(classifyAttemptOutcome(makeFireOk(), verdict)).toBe('cancelled');
  });

  test('failed verdict classifies as gate-failed', () => {
    const verdict = judgeGate(makePoll({ terminalStatus: 'failed', prUrl: null }));
    expect(classifyAttemptOutcome(makeFireOk(), verdict)).toBe('gate-failed');
  });

  test('passing verdict classifies as won', () => {
    const verdict = judgeGate(makePoll());
    expect(classifyAttemptOutcome(makeFireOk(), verdict)).toBe('won');
  });
});

describe('judgeGate: existing WO PR head', () => {
  const pushed = 'a'.repeat(40);
  const other = 'b'.repeat(40);

  test('gate_counts_existing_wo_pr', () => {
    const matched = judgeGate(
      makePoll({
        prUrl: null,
        prMergeable: null,
        runPushedHeadSha: pushed,
        openWoPrHeadSha: pushed.toUpperCase(),
      })
    );
    expect(matched.pass).toBe(true);
    expect(matched.reason).not.toContain('no PR opened after completed run');

    const differed = judgeGate(
      makePoll({
        prUrl: null,
        prMergeable: null,
        runPushedHeadSha: pushed,
        openWoPrHeadSha: other,
      })
    );
    expect(differed.pass).toBe(false);
    expect(differed.reason).toContain('no PR opened after completed run');

    const short = judgeGate(
      makePoll({
        prUrl: null,
        prMergeable: null,
        runPushedHeadSha: 'abc',
        openWoPrHeadSha: 'abc',
      })
    );
    expect(short.reason).toContain('no PR opened after completed run');

    const needsRevision = judgeGate(
      makePoll({
        prUrl: null,
        prMergeable: null,
        validatorVerdict: 'needs_revision',
        runPushedHeadSha: pushed,
        openWoPrHeadSha: pushed,
      })
    );
    expect(needsRevision.pass).toBe(false);
    expect(needsRevision.reason).toContain('needs_revision');
    expect(needsRevision.reason).not.toContain('no PR opened after completed run');

    const unmergeable = judgeGate(
      makePoll({
        prUrl: null,
        prMergeable: false,
        runPushedHeadSha: pushed,
        openWoPrHeadSha: pushed,
      })
    );
    expect(unmergeable.pass).toBe(false);
    expect(unmergeable.reason).toContain('not mergeable');
    expect(unmergeable.reason).not.toContain('no PR opened after completed run');
  });
});

describe('poll credit mergeability', () => {
  test('standard build lane emits the origin verification receipt', async () => {
    const lane = await Bun.file(
      new URL(
        '../../../../.archon/workflows/defaults/bdc-feature-development-zero.yaml',
        import.meta.url
      )
    ).text();
    expect(lane).toContain(
      'echo "VERIFIED: origin/${UNIQUE_BRANCH} == local HEAD (${LOCAL_HEAD})"'
    );
  });
  test.each(['output', 'node_output'])(
    'credits standard push receipt from %s and checks mergeability',
    async outputField => {
      const headSha = 'a'.repeat(40);
      const creditedUrl = 'https://github.com/thinmansoftware/bdc-harness/pull/4422';
      const checked: string[] = [];
      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            run: {
              id: 'run-credit',
              status: 'completed',
              metadata: {},
            },
            events: [
              {
                event_type: 'node_completed',
                step_name: 'commit-and-push',
                data: {
                  [outputField]: `VERIFIED: origin/fix/existing-branch == local HEAD (${headSha})\nunique_branch=fix/existing-branch`,
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );

      const poll = await pollForTerminal({
        runId: 'run-credit',
        apiBaseUrl: 'http://archon.test',
        fetchImpl,
        timeoutMs: 30_000,
        intervalMs: 1,
        prRetryAttempts: 0,
        prBranchLookupAttempts: 1,
        prBranchLookupDelayMs: 0,
        repo: 'thinmansoftware/bdc-harness',
        woId: 'WO-XO-BDC-BROWSER-KEEPER-04',
        ghPrListForBranch: async () => null,
        listOpenWoPullRequests: async () => [
          {
            number: 4422,
            headRefName: 'archon/task-web-worker-1-abc',
            headSha,
            url: creditedUrl,
            createdAt: '2026-11-03T10:47:06Z',
            isDraft: false,
            isFork: false,
            body: 'WO: WO-XO-BDC-BROWSER-KEEPER-04\n',
          },
        ],
        checkPrMergeable: async (url: string) => {
          checked.push(url);
          return false;
        },
      });

      expect(poll.prUrl).toBe(creditedUrl);
      expect(checked).toEqual([creditedUrl]);
      expect(poll.prMergeable).toBe(false);
      const verdict = judgeGate(poll);
      expect(verdict.pass).toBe(false);
      expect(verdict.reason).not.toContain('no PR opened after completed run');
    }
  );
});
