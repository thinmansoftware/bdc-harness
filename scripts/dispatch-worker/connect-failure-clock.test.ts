import { describe, expect, test } from 'bun:test';
import {
  CONNECT_FAILURE_EXIT_MS,
  createConnectFailureClock,
  isHttpStatusError,
  runPollLoop,
  runWorkerLoop,
  type PollLoopDeps,
} from './connect-failure-clock';

const connectError = (): Error =>
  new TypeError('Unable to connect. Is the computer able to access the url?');
const httpError = (status = 500): Error =>
  new Error(`HTTP ${status} /api/dispatch/messages: server said no`);

type FakeTime = { now: () => number; set: (ms: number) => void; get: () => number };

function fakeTime(): FakeTime {
  let t = 0;
  return { now: () => t, set: (ms: number) => void (t = ms), get: () => t };
}

describe('contact failure clock (Test 8)', () => {
  test('the default window is ten minutes', () => {
    expect(CONNECT_FAILURE_EXIT_MS).toBe(600_000);
  });

  test('599999 ms without a success does not request exit; 600000 ms does', () => {
    const time = fakeTime();
    const clock = createConnectFailureClock({ now: time.now });
    clock.recordFailure(connectError());
    time.set(599_999);
    expect(clock.shouldExit(0)).toBe(false);
    time.set(600_000);
    expect(clock.shouldExit(0)).toBe(true);
  });

  test('a success at 599999 ms resets the clock', () => {
    const time = fakeTime();
    const clock = createConnectFailureClock({ now: time.now });
    time.set(599_999);
    clock.recordSuccess();
    time.set(599_999 + 599_999);
    expect(clock.shouldExit(0)).toBe(false);
    time.set(599_999 + 600_000);
    expect(clock.shouldExit(0)).toBe(true);
  });

  test('sustained HTTP 500 alone does NOT keep the worker alive: it exits at 600000 ms', () => {
    const time = fakeTime();
    const clock = createConnectFailureClock({ now: time.now });
    for (let t = 0; t <= 599_000; t += 1_000) {
      time.set(t);
      clock.recordFailure(httpError(500));
      expect(clock.shouldExit(0)).toBe(false);
    }
    time.set(600_000);
    clock.recordFailure(httpError(500));
    expect(clock.shouldExit(0)).toBe(true);
    expect(clock.lastFailureKind()).toBe('http_status');
  });

  test('sustained HTTP 403 (a rotated token) also ends the worker at 600000 ms', () => {
    const time = fakeTime();
    const clock = createConnectFailureClock({ now: time.now });
    for (let t = 0; t < 600_000; t += 5_000) {
      time.set(t);
      clock.recordFailure(httpError(403));
    }
    time.set(600_000);
    clock.recordFailure(httpError(403));
    expect(clock.shouldExit(0)).toBe(true);
  });

  test('alternating network failures and HTTP errors cannot extend the window', () => {
    const time = fakeTime();
    const clock = createConnectFailureClock({ now: time.now });
    // one failure a minute, alternating kinds and statuses, never a 2xx
    const sequence = [
      connectError(),
      httpError(500),
      connectError(),
      httpError(403),
      httpError(502),
    ];
    let step = 0;
    for (let t = 0; t < 600_000; t += 60_000) {
      time.set(t);
      clock.recordFailure(sequence[step++ % sequence.length]);
      expect(clock.shouldExit(0)).toBe(false);
    }
    time.set(599_999);
    expect(clock.shouldExit(0)).toBe(false);
    time.set(600_000);
    expect(clock.shouldExit(0)).toBe(true);
  });

  test('alternating failures with ONE 2xx at 599999 ms reset the window, then exit 600000 ms later', () => {
    const time = fakeTime();
    const clock = createConnectFailureClock({ now: time.now });
    clock.recordFailure(connectError());
    time.set(300_000);
    clock.recordFailure(httpError(500));
    time.set(599_999);
    clock.recordSuccess();
    time.set(599_999 + 300_000);
    clock.recordFailure(connectError());
    time.set(599_999 + 599_999);
    clock.recordFailure(httpError(503));
    expect(clock.shouldExit(0)).toBe(false);
    time.set(599_999 + 600_000);
    expect(clock.shouldExit(0)).toBe(true);
  });

  test('a successful heartbeat alone resets it while polls keep failing (documented limit)', () => {
    const time = fakeTime();
    const clock = createConnectFailureClock({ now: time.now });
    for (let t = 0; t <= 3_000_000; t += 300_000) {
      time.set(t);
      clock.recordFailure(httpError(500)); // poll failed
      clock.recordSuccess(); // heartbeat returned 2xx
      expect(clock.shouldExit(0)).toBe(false);
    }
  });

  test('an active execution blocks exit and exit happens once executions end', () => {
    const time = fakeTime();
    const clock = createConnectFailureClock({ now: time.now });
    time.set(3_600_000);
    expect(clock.shouldExit(1)).toBe(false);
    expect(clock.shouldExit(3)).toBe(false);
    expect(clock.shouldExit(0)).toBe(true);
  });

  test('the last failure kind is tracked and a success clears it', () => {
    const time = fakeTime();
    const clock = createConnectFailureClock({ now: time.now });
    expect(clock.lastFailureKind()).toBe('none');
    clock.recordFailure(connectError());
    expect(clock.lastFailureKind()).toBe('no_http_status');
    clock.recordFailure(httpError(500));
    expect(clock.lastFailureKind()).toBe('http_status');
    clock.recordSuccess();
    expect(clock.lastFailureKind()).toBe('none');
  });

  test('only errors shaped like requestJson HTTP errors count as HTTP-status errors', () => {
    expect(isHttpStatusError(httpError(500))).toBe(true);
    expect(isHttpStatusError(httpError(403))).toBe(true);
    expect(isHttpStatusError(connectError())).toBe(false);
    expect(isHttpStatusError(new Error('connect ECONNREFUSED 127.0.0.1:3900'))).toBe(false);
    expect(isHttpStatusError('HTTP 500 /x')).toBe(false);
    expect(isHttpStatusError(undefined)).toBe(false);
  });
});

/** Two hours of fake time: far past every window any test expects. */
const SAFETY_CAP_MS = 7_200_000;

function loopHarness(options: {
  pollImpl: (time: FakeTime) => Promise<void>;
  active?: () => number;
  stopWhen?: (time: FakeTime) => boolean;
}): { deps: PollLoopDeps; time: FakeTime; logs: string[]; sleeps: number[] } {
  const time = fakeTime();
  const logs: string[] = [];
  const sleeps: number[] = [];
  const deps: PollLoopDeps = {
    // The hard cap makes a contract regression fail an assertion (outcome
    // 'stopped' at the cap) instead of spinning forever on the instant fake sleep.
    isStopping: () => time.get() >= SAFETY_CAP_MS || (options.stopWhen?.(time) ?? false),
    poll: () => options.pollImpl(time),
    sleep: async ms => {
      sleeps.push(ms);
      time.set(time.get() + ms);
    },
    pollIntervalMs: 5_000,
    activeExecutions: options.active ?? (() => 0),
    clock: createConnectFailureClock({ now: time.now }),
    logError: async message => {
      logs.push(message);
    },
  };
  return { deps, time, logs, sleeps };
}

const reasonLines = (logs: string[]): string[] =>
  logs.filter(line => line.startsWith('sustained contact failure'));

describe('poll loop and shutdown order (Test 9)', () => {
  test('connect errors for the whole window end the loop with exactly one reason line', async () => {
    const { deps, time, logs } = loopHarness({
      pollImpl: async () => {
        throw connectError();
      },
    });
    const outcome = await runPollLoop(deps);
    expect(outcome).toBe('sustained_contact_failure');
    expect(time.get()).toBe(600_000);
    expect(reasonLines(logs)).toHaveLength(1);
    expect(reasonLines(logs)[0]).toContain('600s');
    expect(reasonLines(logs)[0]).toContain('last failure: no_http_status');
    // the existing per-failure line is unchanged
    expect(logs.filter(line => line === 'poll failed').length).toBeGreaterThan(100);
    // no secret-bearing words in the reason line
    expect(reasonLines(logs)[0]).not.toMatch(/token|bearer|authorization|prompt/i);
  });

  test('sustained HTTP 500 on every poll ends the worker, it does not stay alive forever', async () => {
    const { deps, time, logs } = loopHarness({
      pollImpl: async () => {
        throw httpError(500);
      },
    });
    const outcome = await runPollLoop(deps);
    expect(outcome).toBe('sustained_contact_failure');
    expect(time.get()).toBe(600_000);
    expect(reasonLines(logs)).toHaveLength(1);
    expect(reasonLines(logs)[0]).toContain('last failure: http_status');
  });

  test('sustained HTTP 403 on every poll ends the worker', async () => {
    const { deps, time } = loopHarness({
      pollImpl: async () => {
        throw httpError(403);
      },
    });
    expect(await runPollLoop(deps)).toBe('sustained_contact_failure');
    expect(time.get()).toBe(600_000);
  });

  test('alternating network failures and HTTP errors on successive polls end the worker at 600000 ms', async () => {
    let call = 0;
    const { deps, time, logs } = loopHarness({
      pollImpl: async () => {
        call += 1;
        throw call % 2 === 0 ? httpError(502) : connectError();
      },
    });
    const outcome = await runPollLoop(deps);
    expect(outcome).toBe('sustained_contact_failure');
    expect(time.get()).toBe(600_000);
    expect(reasonLines(logs)).toHaveLength(1);
  });

  test('a 2xx poll every nine minutes keeps the worker alive indefinitely', async () => {
    const { deps, time, logs } = loopHarness({
      pollImpl: async t => {
        if (t.get() % 540_000 === 0 && t.get() > 0) return; // success once every 540 s
        throw httpError(500);
      },
      stopWhen: t => t.get() >= 5_400_000,
    });
    const outcome = await runPollLoop(deps);
    expect(outcome).toBe('stopped');
    expect(time.get()).toBe(5_400_000);
    expect(reasonLines(logs)).toHaveLength(0);
  });

  test('lock is released once, before the exit, and the exit code is 1', async () => {
    const { deps } = loopHarness({
      pollImpl: async () => {
        throw connectError();
      },
    });
    const events: string[] = [];
    const outcome = await runWorkerLoop({
      ...deps,
      release: async () => {
        events.push('release');
      },
      exit: code => {
        events.push(`exit:${code}`);
      },
    });
    expect(outcome).toBe('sustained_contact_failure');
    expect(events).toEqual(['release', 'exit:1']);
  });

  test('one successful poll at 595000 ms keeps the loop going for another full window', async () => {
    const { deps, time } = loopHarness({
      pollImpl: async t => {
        if (t.get() === 595_000) return; // success
        throw connectError();
      },
    });
    const outcome = await runPollLoop(deps);
    expect(outcome).toBe('sustained_contact_failure');
    expect(time.get()).toBe(595_000 + 600_000);
  });

  test('an active execution holds the worker up and it exits when executions end', async () => {
    let active = 1;
    const { deps, time, logs } = loopHarness({
      pollImpl: async t => {
        if (t.get() >= 1_800_000) active = 0;
        throw connectError();
      },
      active: () => active,
    });
    const outcome = await runPollLoop(deps);
    expect(outcome).toBe('sustained_contact_failure');
    expect(time.get()).toBe(1_800_000);
    expect(reasonLines(logs)).toHaveLength(1);
  });

  test('a normal stop releases the lock and never calls exit', async () => {
    const { deps } = loopHarness({
      pollImpl: async () => {},
      stopWhen: t => t.get() >= 20_000,
    });
    const events: string[] = [];
    const outcome = await runWorkerLoop({
      ...deps,
      release: async () => {
        events.push('release');
      },
      exit: code => {
        events.push(`exit:${code}`);
      },
    });
    expect(outcome).toBe('stopped');
    expect(events).toEqual(['release']);
  });
});
