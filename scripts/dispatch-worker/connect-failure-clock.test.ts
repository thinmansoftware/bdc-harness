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

function fakeTime(): { now: () => number; set: (ms: number) => void; get: () => number } {
  let t = 0;
  return { now: () => t, set: (ms: number) => void (t = ms), get: () => t };
}

describe('connect failure clock (Test 8)', () => {
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

  test('a successful heartbeat alone resets it while polls keep failing', () => {
    const time = fakeTime();
    const clock = createConnectFailureClock({ now: time.now });
    // polls fail the whole time; a heartbeat success is recorded with the same call
    for (let t = 0; t <= 3_000_000; t += 300_000) {
      time.set(t);
      clock.recordFailure(connectError()); // poll failed
      clock.recordSuccess(); // heartbeat succeeded
      expect(clock.shouldExit(0)).toBe(false);
    }
  });

  test('an HTTP-status error never advances the clock toward exit', () => {
    const time = fakeTime();
    const clock = createConnectFailureClock({ now: time.now });
    for (let t = 0; t <= 3_600_000; t += 60_000) {
      time.set(t);
      clock.recordFailure(httpError(t % 120_000 === 0 ? 500 : 403));
      expect(clock.shouldExit(0)).toBe(false);
      expect(clock.failingForMs()).toBe(0);
    }
  });

  test('an HTTP-status error in the middle of a connect-failure run resets the window', () => {
    const time = fakeTime();
    const clock = createConnectFailureClock({ now: time.now });
    clock.recordFailure(connectError());
    time.set(599_000);
    clock.recordFailure(httpError(500));
    time.set(599_000 + 599_999);
    expect(clock.shouldExit(0)).toBe(false);
    time.set(599_000 + 600_000);
    expect(clock.shouldExit(0)).toBe(true);
  });

  test('an active execution blocks exit and exit happens once executions end', () => {
    const time = fakeTime();
    const clock = createConnectFailureClock({ now: time.now });
    time.set(3_600_000);
    expect(clock.shouldExit(1)).toBe(false);
    expect(clock.shouldExit(3)).toBe(false);
    expect(clock.shouldExit(0)).toBe(true);
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

function loopHarness(options: {
  pollImpl: (time: ReturnType<typeof fakeTime>) => Promise<void>;
  active?: () => number;
  stopWhen?: (time: ReturnType<typeof fakeTime>) => boolean;
}): { deps: PollLoopDeps; time: ReturnType<typeof fakeTime>; logs: string[]; sleeps: number[] } {
  const time = fakeTime();
  const logs: string[] = [];
  const sleeps: number[] = [];
  const deps: PollLoopDeps = {
    isStopping: () => options.stopWhen?.(time) ?? false,
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

describe('poll loop and shutdown order (Test 9)', () => {
  test('connect errors for the whole window end the loop with exactly one reason line', async () => {
    const { deps, time, logs } = loopHarness({
      pollImpl: async () => {
        throw connectError();
      },
    });
    const outcome = await runPollLoop(deps);
    expect(outcome).toBe('sustained_connect_failure');
    expect(time.get()).toBe(600_000);
    const reasonLines = logs.filter(line => line.startsWith('sustained connect failure'));
    expect(reasonLines).toHaveLength(1);
    expect(reasonLines[0]).toContain('600s');
    // the existing per-failure line is unchanged
    expect(logs.filter(line => line === 'poll failed').length).toBeGreaterThan(100);
    // no secret-bearing words in the reason line
    expect(reasonLines[0]).not.toMatch(/token|bearer|authorization|prompt/i);
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
    expect(outcome).toBe('sustained_connect_failure');
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
    expect(outcome).toBe('sustained_connect_failure');
    expect(time.get()).toBe(595_000 + 600_000);
  });

  test('HTTP 500 responses never end the loop', async () => {
    const { deps, time, logs } = loopHarness({
      pollImpl: async () => {
        throw httpError(500);
      },
      stopWhen: t => t.get() >= 3_600_000,
    });
    const outcome = await runPollLoop(deps);
    expect(outcome).toBe('stopped');
    expect(logs.some(line => line.startsWith('sustained connect failure'))).toBe(false);
    expect(time.get()).toBe(3_600_000);
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
    expect(outcome).toBe('sustained_connect_failure');
    expect(time.get()).toBe(1_800_000);
    expect(logs.filter(line => line.startsWith('sustained connect failure'))).toHaveLength(1);
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
