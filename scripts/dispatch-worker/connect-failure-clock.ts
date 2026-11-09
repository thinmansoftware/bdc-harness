/**
 * Sustained connect-failure clock for the dispatch worker.
 *
 * WO-HARNESS-DISPATCH-WORKER-STALE-LOCK-01, 2026-11-09 amendment. Incident: a
 * worker process stayed alive for days with its SSH tunnel gone and no
 * launcher, catching and logging every poll and heartbeat failure forever.
 * A worker that exits after sustained connect failure becomes the dead-PID
 * case the watchdog and launcher supervisor already recover.
 *
 * Pure module: the time source and every side effect are injected so the
 * behavior is testable without a network, a lock file or index.ts.
 */

/** Exit after this long with no reachable server and no active execution. */
export const CONNECT_FAILURE_EXIT_MS = 600_000;

/**
 * requestJson in index.ts turns any HTTP error status into
 * Error('HTTP <status> <path>: <text>'). An error with that shape means the
 * server answered, so it is not a connect failure. Anything else thrown by a
 * request (for example fetch's "Unable to connect") never produced a status.
 */
export function isHttpStatusError(error: unknown): boolean {
  return error instanceof Error && /^HTTP \d{3} /.test(error.message);
}

export interface ConnectFailureClock {
  /** A poll or a heartbeat succeeded: the server is reachable. */
  recordSuccess(): void;
  /**
   * A request failed. A connect failure leaves the clock running. An HTTP
   * status error means the server answered, so it resets the clock instead.
   */
  recordFailure(error: unknown): void;
  /** Milliseconds since the server was last reachable (0 right after a reset). */
  failingForMs(): number;
  /** True once the window has passed and no agent execution is active. */
  shouldExit(activeExecutions: number): boolean;
}

export function createConnectFailureClock(options: {
  now: () => number;
  exitAfterMs?: number;
}): ConnectFailureClock {
  const exitAfterMs = options.exitAfterMs ?? CONNECT_FAILURE_EXIT_MS;
  let lastReachableAt = options.now();
  const failingForMs = (): number => Math.max(0, options.now() - lastReachableAt);
  return {
    recordSuccess(): void {
      lastReachableAt = options.now();
    },
    recordFailure(error: unknown): void {
      if (isHttpStatusError(error)) lastReachableAt = options.now();
    },
    failingForMs,
    shouldExit(activeExecutions: number): boolean {
      return activeExecutions === 0 && failingForMs() >= exitAfterMs;
    },
  };
}

export type PollLoopOutcome = 'stopped' | 'sustained_connect_failure';

export interface PollLoopDeps {
  isStopping: () => boolean;
  /** One poll pass. Rejects on any failed request, as poll() in index.ts does. */
  poll: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  /** Number of agent executions currently running. */
  activeExecutions: () => number;
  clock: ConnectFailureClock;
  logError: (message: string, error?: unknown) => Promise<void>;
}

/**
 * The poll loop of main(). Behavior is unchanged except for the exit: poll
 * failures are still caught and logged and the loop keeps going, until the
 * clock says the server has been unreachable for the whole window and nothing
 * is executing. Then it logs ONE line (no token, no prompt text, no error
 * object) and returns so the caller can release the lock and exit.
 */
export async function runPollLoop(deps: PollLoopDeps): Promise<PollLoopOutcome> {
  while (!deps.isStopping()) {
    await deps
      .poll()
      .then(() => {
        deps.clock.recordSuccess();
      })
      .catch(error => {
        deps.clock.recordFailure(error);
        void deps.logError('poll failed', error);
      });
    if (deps.clock.shouldExit(deps.activeExecutions())) {
      const seconds = Math.round(deps.clock.failingForMs() / 1000);
      await deps.logError(
        `sustained connect failure: no successful poll or heartbeat for ${seconds}s; exiting so the supervisor restarts the worker`
      );
      return 'sustained_connect_failure';
    }
    await deps.sleep(deps.pollIntervalMs);
  }
  return 'stopped';
}

export interface WorkerLoopDeps extends PollLoopDeps {
  /** Runs once when the loop ends for any reason: stop timers, log, release the lock. */
  release: () => Promise<void>;
  /** Process exit; called with 1 only after release, and only on sustained failure. */
  exit: (code: number) => void;
}

/** The poll loop plus the shutdown order main() needs: release first, then exit. */
export async function runWorkerLoop(deps: WorkerLoopDeps): Promise<PollLoopOutcome> {
  let outcome: PollLoopOutcome = 'stopped';
  try {
    outcome = await runPollLoop(deps);
  } finally {
    await deps.release();
  }
  if (outcome === 'sustained_connect_failure') deps.exit(1);
  return outcome;
}
