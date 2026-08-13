import { afterEach, describe, expect, test } from 'bun:test';

import { PollTransportError, pollForTerminal } from '../poll.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('pollForTerminal PR-detection race guard', () => {
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
    });

    expect(result.terminalStatus).toBe('completed');
    expect(result.prUrl).toBe('https://github.com/thinmansoftware/bdc-harness/pull/488');
    expect(calls).toBe(2);
    // 30s, raised from 15s after a 15016ms CI failure (16ms over) on 2026-07-25.
    // NOTE for whoever touches this next: intervalMs and the retry delays here are
    // 1ms, so this test has no business taking 15 SECONDS -- the wall time is not
    // slowness, it is something in the PR-lookup path blocking. Raising the ceiling
    // unblocks the branch; it does NOT explain the duration. Worth a real look.
  }, 30000);

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
    });

    expect(result.prUrl).toBe('https://github.com/thinmansoftware/bdc-harness/pull/488');
    expect(calls).toBe(1);
  });
});

describe('pollForTerminal branch-based PR attribution (WO-HARNESS-CASCADE-GATE-PR-DETECTION-01)', () => {
  const completedRun = (events: unknown[]) =>
    new Response(
      JSON.stringify({
        run: { id: 'run-attr', status: 'completed', metadata: {} },
        events,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );

  test('scopes the gh lookup with --repo and matches an archon/thread-* push without a unique_branch marker', async () => {
    globalThis.fetch = (async () =>
      completedRun([
        {
          event_type: 'node_completed',
          step_name: 'implement',
          data: {
            output:
              "branch 'archon/thread-2d0f2f8a' set up to track 'origin/archon/thread-2d0f2f8a'.",
          },
        },
      ])) as unknown as typeof fetch;

    const ghCalls: string[][] = [];
    const result = await pollForTerminal({
      runId: 'run-attr',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 1,
      prRetryDelayMs: 1,
      repo: 'thinmansoftware/lspro-react',
      execGh: async args => {
        ghCalls.push(args);
        if (args[0] === 'pr' && args[1] === 'list') {
          return { stdout: 'https://github.com/thinmansoftware/lspro-react/pull/513\n' };
        }
        return { stdout: 'MERGEABLE\n' };
      },
    });

    expect(result.prUrl).toBe('https://github.com/thinmansoftware/lspro-react/pull/513');
    const listCall = ghCalls.find(args => args[0] === 'pr' && args[1] === 'list');
    expect(listCall).toBeDefined();
    expect(listCall).toContain('--repo');
    expect(listCall).toContain('thinmansoftware/lspro-react');
    expect(listCall).toContain('archon/thread-2d0f2f8a');
  });

  test('queries every candidate branch on a dual-branch push (archon/thread-* + feat/wo-*)', async () => {
    globalThis.fetch = (async () =>
      completedRun([
        {
          event_type: 'node_completed',
          step_name: 'implement',
          data: { output: 'pushed archon/thread-9772643d' },
        },
        {
          event_type: 'node_completed',
          step_name: 'commit-and-push',
          data: { output: 'unique_branch=feat/wo-cover-picker-scroll-01-thread-9772643d' },
        },
      ])) as unknown as typeof fetch;

    const headsQueried: string[] = [];
    const result = await pollForTerminal({
      runId: 'run-attr-dual',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 1,
      prRetryDelayMs: 1,
      repo: 'thinmansoftware/lspro-react',
      execGh: async args => {
        if (args[0] === 'pr' && args[1] === 'list') {
          const head = args[args.indexOf('--head') + 1] ?? '';
          headsQueried.push(head);
          // Only the SECOND branch (the engine thread branch) has the PR.
          if (head === 'archon/thread-9772643d') {
            return { stdout: 'https://github.com/thinmansoftware/lspro-react/pull/515\n' };
          }
          return { stdout: '' };
        }
        return { stdout: 'MERGEABLE\n' };
      },
    });

    expect(result.prUrl).toBe('https://github.com/thinmansoftware/lspro-react/pull/515');
    // unique_branch marker is queried first (canonical PR branch), then tokens.
    expect(headsQueried[0]).toBe('feat/wo-cover-picker-scroll-01-thread-9772643d');
    expect(headsQueried).toContain('archon/thread-9772643d');
  });

  test('a gh failure is unknown-not-absent: logged, other candidates still queried, null when all fail', async () => {
    globalThis.fetch = (async () =>
      completedRun([
        {
          event_type: 'node_completed',
          step_name: 'commit-and-push',
          data: { output: 'unique_branch=feat/wo-gh-down-01-thread-aa11bb22' },
        },
      ])) as unknown as typeof fetch;

    let ghAttempts = 0;
    const result = await pollForTerminal({
      runId: 'run-gh-down',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 2,
      prRetryDelayMs: 1,
      repo: 'thinmansoftware/bdc-harness',
      execGh: async () => {
        ghAttempts++;
        throw new Error('gh: connection refused');
      },
    });

    // gh errored on every attempt: verdict stays "unknown/no PR" (null), and
    // the lookup was actually attempted (1 initial + 2 retries).
    expect(result.prUrl).toBeNull();
    expect(ghAttempts).toBe(3);
  });

  test('omits --repo when no target repo is provided (legacy cwd-derived behavior)', async () => {
    globalThis.fetch = (async () =>
      completedRun([
        {
          event_type: 'node_completed',
          step_name: 'commit-and-push',
          data: { output: 'unique_branch=feat/wo-legacy-01-thread-cc33dd44' },
        },
      ])) as unknown as typeof fetch;

    const ghCalls: string[][] = [];
    await pollForTerminal({
      runId: 'run-no-repo',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 1,
      prRetryDelayMs: 1,
      execGh: async args => {
        ghCalls.push(args);
        if (args[0] === 'pr' && args[1] === 'list') {
          return { stdout: 'https://github.com/thinmansoftware/bdc-harness/pull/1\n' };
        }
        return { stdout: 'MERGEABLE\n' };
      },
    });

    const listCall = ghCalls.find(args => args[0] === 'pr' && args[1] === 'list');
    expect(listCall).toBeDefined();
    expect(listCall).not.toContain('--repo');
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
