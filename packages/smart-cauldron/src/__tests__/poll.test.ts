import { afterEach, describe, expect, test } from 'bun:test';

import type { OpenWoPullRequest } from '../already-satisfied.js';
import { PollTransportError, pollForTerminal } from '../poll.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('pollForTerminal PR-detection race guard', () => {
  const hermeticPollGh: {
    ghPrListForBranch: (branch: string) => Promise<string | null>;
    checkPrMergeable: (prUrl: string) => Promise<boolean | null>;
    prBranchLookupDelayMs: number;
  } = {
    ghPrListForBranch: async (): Promise<string | null> => null,
    checkPrMergeable: async (): Promise<boolean | null> => null,
    prBranchLookupDelayMs: 1,
  };

  const completedRun = (events: unknown[]) =>
    new Response(
      JSON.stringify({
        run: { id: 'run-race', status: 'completed', metadata: {} },
        events,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );

  const openPrEvent = {
    event_type: 'node_completed',
    step_name: 'open-pr-if-needed',
    data: { output: 'PR_URL=https://github.com/thinmansoftware/bdc-harness/pull/488' },
  };

  test('retries the event read when the PR event lands after run-complete (2026-07-17 false-negative race)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      // First read: run already completed but open-pr event not yet recorded.
      // Second read (retry): event has landed.
      return calls === 1 ? completedRun([]) : completedRun([openPrEvent]);
    }) as unknown as typeof fetch;

    const result = await pollForTerminal({
      runId: 'run-race',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 3,
      prRetryDelayMs: 1,
      ...hermeticPollGh,
    });

    expect(result.terminalStatus).toBe('completed');
    expect(result.prUrl).toBe('https://github.com/thinmansoftware/bdc-harness/pull/488');
    expect(calls).toBe(2);
    // 30s, raised from 15s after a 15016ms CI failure (16ms over) on 2026-07-25.
    // NOTE for whoever touches this next: intervalMs and the retry delays here are
    // 1ms, so this test has no business taking 15 SECONDS -- the wall time is not
    // slowness, it is something in the PR-lookup path blocking. Raising the ceiling
    // unblocks the branch; it does NOT explain the duration. Worth a real look.
  });

  test('declares no PR only after exhausting retries', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return completedRun([]);
    }) as unknown as typeof fetch;

    const result = await pollForTerminal({
      runId: 'run-race-no-pr',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 3,
      prRetryDelayMs: 1,
      ...hermeticPollGh,
    });

    expect(result.prUrl).toBeNull();
    // 1 initial read + 3 retries
    expect(calls).toBe(4);
  });

  test('does not retry when the PR event is present on the first read', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return completedRun([openPrEvent]);
    }) as unknown as typeof fetch;

    const result = await pollForTerminal({
      runId: 'run-no-race',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 3,
      prRetryDelayMs: 1,
      ...hermeticPollGh,
    });

    expect(result.prUrl).toBe('https://github.com/thinmansoftware/bdc-harness/pull/488');
    expect(calls).toBe(1);
  });
});

describe('pollForTerminal transport truth', () => {
  test('surfaces an HTTP transport failure instead of converting it into a timeout', async () => {
    globalThis.fetch = (async () =>
      new Response('unavailable', { status: 503 })) as unknown as typeof fetch;

    await expect(
      pollForTerminal({
        runId: 'run-http-failure',
        apiBaseUrl: 'http://archon.test',
        timeoutMs: 60_000,
        intervalMs: 1,
      })
    ).rejects.toBeInstanceOf(PollTransportError);
  });

  test('surfaces a network failure instead of silently polling null', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection reset');
    }) as unknown as typeof fetch;

    await expect(
      pollForTerminal({
        runId: 'run-network-failure',
        apiBaseUrl: 'http://archon.test',
        timeoutMs: 60_000,
        intervalMs: 1,
      })
    ).rejects.toBeInstanceOf(PollTransportError);
  });
});

describe('pollForTerminal isTransitionalStatus hook (T3 consumer approve hand-off)', () => {
  const approvalHandOff = {
    run: { id: 'run-gate', status: 'failed', metadata: {} },
    events: [{ event_type: 'approval_received', step_name: 'gate', data: {} }],
  };
  const resumedAndDone = {
    run: { id: 'run-gate', status: 'completed', metadata: {} },
    events: [
      { event_type: 'approval_received', step_name: 'gate', data: {} },
      { event_type: 'node_completed', step_name: 'after-gate', data: {} },
    ],
  };
  function sequence(): typeof fetch {
    let calls = 0;
    return (async () => {
      calls += 1;
      return Response.json(calls === 1 ? approvalHandOff : resumedAndDone);
    }) as unknown as typeof fetch;
  }
  const base = {
    runId: 'run-gate',
    apiBaseUrl: 'http://archon.in-process',
    timeoutMs: 60_000,
    intervalMs: 1,
    prRetryAttempts: 0,
    prRetryDelayMs: 1,
    prBranchLookupAttempts: 0,
    prBranchLookupDelayMs: 1,
    ghPrListForBranch: async (): Promise<string | null> => null,
    checkPrMergeable: async (): Promise<boolean | null> => null,
  };

  test('with the hook, the approval hand-off failed is not terminal; polling continues', async () => {
    const result = await pollForTerminal({
      ...base,
      fetchImpl: sequence(),
      isTransitionalStatus: detail =>
        detail.run.status === 'failed' &&
        (detail.events ?? []).at(-1)?.event_type === 'approval_received',
    });
    expect(result.terminalStatus).toBe('completed');
  });

  test('without the hook (every existing caller), failed stays terminal', async () => {
    const result = await pollForTerminal({ ...base, fetchImpl: sequence() });
    expect(result.terminalStatus).toBe('failed');
  });
});

describe('pollForTerminal pushed-head credit', () => {
  const pushed = 'a'.repeat(40);
  const other = 'b'.repeat(40);

  function openPr(headSha: string, number = 7): OpenWoPullRequest {
    return {
      number,
      headRefName: 'feat/wo-foo-01-thread-ab12cd34',
      headSha,
      url: `https://github.com/thinmansoftware/bdc-harness/pull/${String(number)}`,
      createdAt: '2026-07-17T00:00:00Z',
      isDraft: false,
      isFork: false,
      body: 'WO: WO-FOO-01\n',
    };
  }

  function completed(events: unknown[]): Response {
    return Response.json({
      run: { id: 'run-pushed', status: 'completed', metadata: {} },
      events,
    });
  }

  /** The commit-and-push stdout every feature workflow already prints. */
  function commitAndPushOutput(head: string): string {
    return [
      `previous HEAD was ${other} in the agent log`,
      `VERIFIED: origin/feat/wo-foo-01-thread-ab12cd34 == local HEAD (${head})`,
      'unique_branch=feat/wo-foo-01-thread-ab12cd34',
    ].join('\n');
  }

  async function pollPushed(
    events: unknown[],
    opens: readonly OpenWoPullRequest[]
  ): Promise<Awaited<ReturnType<typeof pollForTerminal>>> {
    return pollForTerminal({
      runId: 'run-pushed',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 0,
      prRetryDelayMs: 1,
      prBranchLookupAttempts: 1,
      prBranchLookupDelayMs: 1,
      repo: 'thinmansoftware/bdc-harness',
      woId: 'WO-FOO-01',
      ghPrListForBranch: async (): Promise<string | null> => null,
      checkPrMergeable: async (): Promise<boolean | null> => null,
      fetchImpl: (async () => completed(events)) as unknown as typeof fetch,
      listOpenWoPullRequests: async () => opens,
    });
  }

  test('credits the SHA commit-and-push verified on origin', async () => {
    const result = await pollPushed(
      [
        {
          event_type: 'node_completed',
          step_name: 'commit-and-push',
          data: { node_output: commitAndPushOutput(pushed) },
        },
      ],
      [openPr(pushed.toUpperCase())]
    );

    expect(result.prUrl).toBeNull();
    expect(result.runPushedHeadSha).toBe(pushed);
    expect(result.openWoPrHeadSha).toBe(pushed);
  });

  test('a later origin re-check replaces the earlier verified SHA', async () => {
    const repushed = 'c'.repeat(40);
    const result = await pollPushed(
      [
        {
          event_type: 'node_completed',
          step_name: 'commit-and-push',
          data: { node_output: commitAndPushOutput(pushed) },
        },
        {
          event_type: 'node_completed',
          step_name: 'open-pr-if-needed',
          data: {
            node_output: `ORIGIN_PRECONDITION_OK: origin/feat/wo-foo-01-thread-ab12cd34 == ${repushed} (attempt 1)`,
          },
        },
      ],
      [openPr(repushed)]
    );

    expect(result.runPushedHeadSha).toBe(repushed);
    expect(result.openWoPrHeadSha).toBe(repushed);
  });

  test('ignores a prose SHA and a non-unique or different open head', async () => {
    const proseOnly = await pollPushed(
      [
        {
          event_type: 'node_completed',
          step_name: 'implement',
          data: { node_output: `pushed something at ${pushed} then stopped` },
        },
      ],
      [openPr(pushed)]
    );
    expect(proseOnly.runPushedHeadSha).toBeNull();
    expect(proseOnly.openWoPrHeadSha).toBeNull();

    const differed = await pollPushed(
      [
        {
          event_type: 'node_completed',
          step_name: 'commit-and-push',
          data: { node_output: commitAndPushOutput(pushed) },
        },
      ],
      [openPr(other)]
    );
    expect(differed.runPushedHeadSha).toBeNull();
    expect(differed.openWoPrHeadSha).toBeNull();

    const two = await pollPushed(
      [
        {
          event_type: 'node_completed',
          step_name: 'commit-and-push',
          data: { node_output: commitAndPushOutput(pushed) },
        },
      ],
      [openPr(pushed, 7), openPr(pushed, 8)]
    );
    expect(two.runPushedHeadSha).toBeNull();
    expect(two.openWoPrHeadSha).toBeNull();
  });

  test('quoted verification from another node does not receive credit', async () => {
    const quoted = 'd'.repeat(40);
    const quotedLine = `Earlier run said VERIFIED: origin/feat/wo-old == local HEAD (${quoted})`;

    const quotedOnly = await pollPushed(
      [
        {
          event_type: 'node_completed',
          step_name: 'implement',
          data: { node_output: quotedLine },
        },
        {
          event_type: 'node_completed',
          step_name: 'diff-review',
          data: {
            output: `ORIGIN_PRECONDITION_OK: origin/feat/wo-old == ${quoted}`,
          },
        },
      ],
      [openPr(quoted)]
    );
    expect(quotedOnly.runPushedHeadSha).toBeNull();
    expect(quotedOnly.openWoPrHeadSha).toBeNull();

    const quotedAfterPush = await pollPushed(
      [
        {
          event_type: 'node_completed',
          step_name: 'commit-and-push',
          data: { node_output: commitAndPushOutput(pushed) },
        },
        {
          event_type: 'node_completed',
          step_name: 'diff-review-final',
          data: { node_output: quotedLine },
        },
      ],
      [openPr(quoted), openPr(pushed, 8)]
    );
    expect(quotedAfterPush.runPushedHeadSha).toBe(pushed);
    expect(quotedAfterPush.openWoPrHeadSha).toBe(pushed);
  });
});
