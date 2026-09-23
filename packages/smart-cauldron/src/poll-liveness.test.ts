/**
 * Liveness (stall) detection in pollForTerminal.
 *
 * The behavior under test is the distinction that a fixed duration budget cannot
 * make: a run that is SLOW but working must survive, while a run that has gone
 * SILENT must be cut. Anchor (2026-07-25): the 30-minute budget killed
 * WO-HARNESS-DISPATCH-SYNC-BEFORE-RESOLVE-01 at exactly 30:00.000 while it was
 * still emitting tool events 56 seconds earlier. Measured over 252 real runs,
 * successful runs average 24.6 min and reach 74.3 min -- the budget sat BELOW the
 * success range.
 *
 * These tests drive wall-clock through an injected fetch + timer so they run in
 * milliseconds rather than hours.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { pollForTerminal, TimeoutError } from './poll.ts';

interface FakeEvent {
  event_type: string;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

/**
 * Install a fake clock: setTimeout resolves immediately but advances a virtual
 * "now" that Date.now() reads, so poll loops burn budget without real waiting.
 */
function installFakeTimers(): { advance: (ms: number) => void } {
  let offset = 0;
  const realNow = Date.now.bind(Date);
  const base = realNow();
  Date.now = () => base + offset;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    offset += ms ?? 0;
    queueMicrotask(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  return {
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

function eventAt(msSinceEpoch: number, type = 'tool_called'): FakeEvent {
  // SQLite-style "YYYY-MM-DD HH:MM:SS" with no zone marker -- the exact shape the
  // real API returns, and the one that parses as LOCAL time if not normalized.
  const iso = new Date(msSinceEpoch).toISOString();
  return {
    event_type: type,
    step_name: 'implement',
    data: {},
    created_at: `${iso.slice(0, 10)} ${iso.slice(11, 19)}`,
  };
}

/** Serve a run that never terminates, with an event stream the test controls. */
function serveRun(getEvents: () => FakeEvent[], status = 'running'): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ run: { id: 'r1', status, metadata: {} }, events: getEvents() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('pollForTerminal liveness', () => {
  test('a SLOW but active run is not killed -- events keep arriving past the old 30m budget', async () => {
    const clock = installFakeTimers();
    const start = Date.now();
    let events: FakeEvent[] = [eventAt(start)];
    let ticks = 0;

    // Emit a fresh event on every poll for the equivalent of ~50 minutes, then
    // terminate. Under the old fixed 30-minute budget this run died; it must not.
    globalThis.fetch = (async () => {
      ticks += 1;
      const terminal = ticks > 100;
      if (!terminal) events = [...events, eventAt(Date.now())];
      return new Response(
        JSON.stringify({
          run: { id: 'r1', status: terminal ? 'completed' : 'running', metadata: {} },
          events,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const result = await pollForTerminal({
      runId: 'r1',
      apiBaseUrl: 'http://x',
      token: 't',
      stallTimeoutMs: 1_200_000,
      intervalMs: 30_000,
    });

    expect(result.terminalStatus).toBe('completed');
    // Proves it ran well past the old 30-minute ceiling.
    expect(Date.now() - start).toBeGreaterThan(1_800_000);
    clock.advance(0);
  });

  test('a SILENT run is cut once the stall budget elapses', async () => {
    installFakeTimers();
    const frozen = Date.now();
    // Event stream never advances -- the run is emitting nothing.
    serveRun(() => [eventAt(frozen)]);

    await expect(
      pollForTerminal({
        runId: 'r1',
        apiBaseUrl: 'http://x',
        token: 't',
        stallTimeoutMs: 600_000,
        intervalMs: 30_000,
      })
    ).rejects.toThrow(TimeoutError);
  });

  test('the stall error names the stall, not a generic budget', async () => {
    installFakeTimers();
    const frozen = Date.now();
    serveRun(() => [eventAt(frozen)]);

    let message = '';
    try {
      await pollForTerminal({
        runId: 'r1',
        apiBaseUrl: 'http://x',
        token: 't',
        stallTimeoutMs: 600_000,
        intervalMs: 30_000,
      });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('stalled');
    expect(message).toContain('no new events');
  });

  test('the hard ceiling still fires on a runaway that never stops emitting', async () => {
    installFakeTimers();
    // Always-fresh events (never stalls) but never terminal -- the runaway case
    // the 12-hour observed max represents. Only the ceiling can stop this.
    serveRun(() => [eventAt(Date.now())]);

    let message = '';
    try {
      await pollForTerminal({
        runId: 'r1',
        apiBaseUrl: 'http://x',
        token: 't',
        timeoutMs: 3_600_000,
        stallTimeoutMs: 1_200_000,
        intervalMs: 30_000,
      });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('hard ceiling');
    expect(message).toContain('still emitting');
  });

  test('stall detection can be disabled with stallTimeoutMs: 0', async () => {
    installFakeTimers();
    const frozen = Date.now();
    serveRun(() => [eventAt(frozen)]);

    let message = '';
    try {
      await pollForTerminal({
        runId: 'r1',
        apiBaseUrl: 'http://x',
        token: 't',
        timeoutMs: 600_000,
        stallTimeoutMs: 0,
        intervalMs: 30_000,
      });
    } catch (err) {
      message = (err as Error).message;
    }

    // Falls through to the duration ceiling instead of the stall path.
    expect(message).toContain('hard ceiling');
  });

  test('a run with NO events yet is not instantly declared stalled', async () => {
    installFakeTimers();
    let ticks = 0;
    // No events at all for several polls, then it starts emitting and completes.
    globalThis.fetch = (async () => {
      ticks += 1;
      const terminal = ticks > 5;
      return new Response(
        JSON.stringify({
          run: { id: 'r1', status: terminal ? 'completed' : 'running', metadata: {} },
          events: terminal ? [eventAt(Date.now())] : [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const result = await pollForTerminal({
      runId: 'r1',
      apiBaseUrl: 'http://x',
      token: 't',
      stallTimeoutMs: 1_200_000,
      intervalMs: 30_000,
    });

    expect(result.terminalStatus).toBe('completed');
  });

  // ==== WO-HARNESS-CONDUCTOR-STALL-DETECTOR-FIX-01: queue-time + open-node carve-outs ====
  // Queue time is not stall time, and a single long open node is alive. Before
  // this fix, a run that sat `pending` (anchor: run 1388511a, cancelled with
  // zero events) or ran one long silent node (anchor: 95b27096, cancelled mid
  // 25-minute run-stop-tests) was judged stalled and cancelled.

  test('pending for 30 minutes, then starts: not stalled', async () => {
    installFakeTimers();
    const startBase = Date.now();
    let ticks = 0;
    // 60 polls * 30s = 30 minutes of `pending` with ZERO events (queue latency),
    // then it starts (emits node_started) and completes. Under the pre-fix code
    // this was cut at the 20-minute stall budget while still queued.
    globalThis.fetch = (async () => {
      ticks += 1;
      if (ticks <= 60) {
        return new Response(
          JSON.stringify({ run: { id: 'r1', status: 'pending', metadata: {} }, events: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      const terminal = ticks > 62;
      return new Response(
        JSON.stringify({
          run: { id: 'r1', status: terminal ? 'completed' : 'running', metadata: {} },
          events: [eventAt(Date.now(), 'node_started')],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const result = await pollForTerminal({
      runId: 'r1',
      apiBaseUrl: 'http://x',
      token: 't',
      stallTimeoutMs: 1_200_000,
      intervalMs: 30_000,
    });

    expect(result.terminalStatus).toBe('completed');
    // Proves it sat pending well past the 20-minute stall budget without a cut.
    expect(Date.now() - startBase).toBeGreaterThan(1_800_000);
  });

  test('one node started 25 minutes ago and still open: not stalled', async () => {
    installFakeTimers();
    const started = Date.now();
    // A single node_started that never gets a matching node_completed while it
    // works -- the exact shape of a long test-run node that emits nothing. It
    // stays open and SILENT for ~40 minutes (past the low 20-minute stall
    // budget, under the 60-minute open-node budget), then completes.
    const openEvent = eventAt(started, 'node_started');
    let ticks = 0;
    globalThis.fetch = (async () => {
      ticks += 1;
      const terminal = ticks > 80;
      return new Response(
        JSON.stringify({
          run: { id: 'r1', status: terminal ? 'completed' : 'running', metadata: {} },
          events: terminal ? [openEvent, eventAt(Date.now(), 'node_completed')] : [openEvent],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const result = await pollForTerminal({
      runId: 'r1',
      apiBaseUrl: 'http://x',
      token: 't',
      stallTimeoutMs: 1_200_000,
      openNodeBudgetMs: 3_600_000,
      intervalMs: 30_000,
    });

    expect(result.terminalStatus).toBe('completed');
    // Survived silence far past the 20-minute stall budget because the node was open.
    expect(Date.now() - started).toBeGreaterThan(1_200_000);
  });

  test("an open node's configured timeout (from the workflow) is honored above the 60m default", async () => {
    installFakeTimers();
    const started = Date.now();
    // The 'implement' node is configured with a 90-minute timeout in its workflow
    // definition. It stays open and SILENT for ~75 minutes -- past BOTH the
    // 20-minute stall budget AND the 60-minute open-node default -- then
    // completes. Under the fixed-60m code this healthy long node was cut at 60m
    // (Scope IN item 2: use the node's own configured timeout when available).
    const openEvent = eventAt(started, 'node_started'); // step_name === 'implement'
    let ticks = 0;
    globalThis.fetch = (async () => {
      ticks += 1;
      const terminal = ticks > 150; // 150 * 30s = 75 minutes of silence
      return new Response(
        JSON.stringify({
          run: { id: 'r1', status: terminal ? 'completed' : 'running', metadata: {} },
          events: terminal ? [openEvent, eventAt(Date.now(), 'node_completed')] : [openEvent],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const result = await pollForTerminal({
      runId: 'r1',
      apiBaseUrl: 'http://x',
      token: 't',
      stallTimeoutMs: 1_200_000,
      openNodeBudgetMs: 3_600_000, // 60m default that would have cut it
      nodeTimeoutsMs: { implement: 5_400_000 }, // 90m configured -- must win
      intervalMs: 30_000,
    });

    expect(result.terminalStatus).toBe('completed');
    // Survived silence past the 60-minute default because the configured 90m won.
    expect(Date.now() - started).toBeGreaterThan(3_600_000);
  });

  test('a configured timeout shorter than the 60m default governs: node is cut before 60m', async () => {
    installFakeTimers();
    const started = Date.now();
    // The 'implement' node is configured with a 10-minute timeout -- shorter than
    // the 60-minute open-node default but above the 2-minute stall floor. A silent
    // open node must be cut at ~10 minutes, not made to wait the full 60m default
    // (the configured timeout governs, it does not merely extend to the default).
    const openEvent = eventAt(started, 'node_started'); // step_name === 'implement'
    serveRun(() => [openEvent]);

    let message = '';
    try {
      await pollForTerminal({
        runId: 'r1',
        apiBaseUrl: 'http://x',
        token: 't',
        stallTimeoutMs: 120_000, // 2m stall floor
        openNodeBudgetMs: 3_600_000, // 60m default that must NOT govern here
        nodeTimeoutsMs: { implement: 600_000 }, // 10m configured -- governs
        timeoutMs: 7_200_000,
        intervalMs: 30_000,
      });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('stalled');
    // Cut at the 10-minute configured budget, well before the 60-minute default.
    expect(Date.now() - started).toBeGreaterThanOrEqual(600_000);
    expect(Date.now() - started).toBeLessThan(3_600_000);
  });

  test('truly silent after a node completed for longer than the budget: stalled', async () => {
    installFakeTimers();
    const t0 = Date.now();
    // The node started AND completed -- no node is open -- then the run emits
    // nothing further. With no open node the tight stall budget applies again.
    const frozen: FakeEvent[] = [eventAt(t0, 'node_started'), eventAt(t0, 'node_completed')];
    serveRun(() => frozen);

    await expect(
      pollForTerminal({
        runId: 'r1',
        apiBaseUrl: 'http://x',
        token: 't',
        stallTimeoutMs: 600_000,
        intervalMs: 30_000,
      })
    ).rejects.toThrow(TimeoutError);
  });
});
