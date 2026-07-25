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
});
