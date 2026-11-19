/**
 * Sustained contact-failure clock for the dispatch worker.
 *
 * WO-HARNESS-DISPATCH-WORKER-STALE-LOCK-01, 2026-11-09 amendment. Incident: a
 * worker process stayed alive for days with its SSH tunnel gone and no
 * launcher, catching and logging every poll and heartbeat failure forever.
 * A worker that exits after sustained failure becomes the dead-PID case the
 * watchdog and launcher supervisor already recover.
 *
 * CONTRACT (reachability is not health):
 * - The clock measures time since the last SUCCESSFUL poll or heartbeat, that
 *   is, a request that returned a 2xx response. Only a success resets it.
 * - A request that never produced an HTTP status (connection refused, tunnel
 *   gone, DNS, timeout) and a request that produced an HTTP error status
 *   (401, 403, 5xx, anything non-2xx) are BOTH failures. Neither resets the
 *   clock, so a mix of the two cannot extend the window.
 * - Why an HTTP error must not count as alive: the worker reads its operator
 *   token once at startup, so a rotated or wrong token answers 403 forever and
 *   only a restart can fix it. A server that answers 5xx forever is also not
 *   serving this worker; restarting is cheap and the server-side heartbeat
 *   alarm already reports it.
 * - What keeps the worker alive: a 2xx poll or heartbeat at least once per
 *   window, an active agent execution (never interrupted), or a stop signal.
 * - Known limit, deliberate: a 2xx heartbeat resets the clock even while every
 *   poll fails. A worker whose poll route is broken while its heartbeat route
 *   works is the poll-progress class that M-186 follow-through and the
 *   server-side canary own; this clock does not claim to detect it.
 *
 * The constant keeps its name from the merged spec; it now bounds any failure
 * to get a 2xx, not only connect failures.
 *
 * Pure module: the time source and every side effect are injected so the
 * behavior is testable without a network, a lock file or index.ts.
 */

/** Exit after this long without a successful poll or heartbeat and with no active execution. */
export const CONNECT_FAILURE_EXIT_MS = 600_000;

/**
 * requestJson in index.ts turns any HTTP error status into
 * Error('HTTP <status> <path>: <text>'). An error with that shape means the
 * server answered with a non-2xx status. Anything else thrown by a request
 * (for example fetch's "Unable to connect") never produced a status.
 */
export function isHttpStatusError(error: unknown): boolean {
  return error instanceof Error && /^HTTP \d{3} /.test(error.message);
}

/** What the most recent failed request looked like. 'none' means no failure since the last success. */
export type FailureKind = 'none' | 'no_http_status' | 'http_status';

export interface ConnectFailureClock {
  /** A poll or a heartbeat succeeded (2xx): the only event that resets the clock. */
  recordSuccess(): void;
  /** A request failed, with or without an HTTP status. The clock keeps running. */
  recordFailure(error: unknown): void;
  /** Milliseconds since the last success (or since the clock started). */
  failingForMs(): number;
  /** Kind of the latest failure since the last success, for the exit log line. */
  lastFailureKind(): FailureKind;
  /** True once the window has passed and no agent execution is active. */
  shouldExit(activeExecutions: number): boolean;
}

export function createConnectFailureClock(options: {
  now: () => number;
  exitAfterMs?: number;
}): ConnectFailureClock {
  const exitAfterMs = options.exitAfterMs ?? CONNECT_FAILURE_EXIT_MS;
  let lastSuccessAt = options.now();
  let lastKind: FailureKind = 'none';
  const failingForMs = (): number => Math.max(0, options.now() - lastSuccessAt);
  return {
    recordSuccess(): void {
      lastSuccessAt = options.now();
      lastKind = 'none';
    },
    recordFailure(error: unknown): void {
      lastKind = isHttpStatusError(error) ? 'http_status' : 'no_http_status';
    },
    failingForMs,
    lastFailureKind: (): FailureKind => lastKind,
    shouldExit(activeExecutions: number): boolean {
      return activeExecutions === 0 && failingForMs() >= exitAfterMs;
    },
  };
}

export type PollLoopOutcome = 'stopped' | 'sustained_contact_failure';

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
 * clock says no request has succeeded for the whole window and nothing is
 * executing. Then it logs ONE line (no token, no prompt text, no error object,
 * only the kind of the last failure) and returns so the caller can release the
 * lock and exit.
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
        `sustained contact failure: no successful poll or heartbeat for ${seconds}s (last failure: ${deps.clock.lastFailureKind()}); exiting so the supervisor restarts the worker`
      );
      return 'sustained_contact_failure';
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
  if (outcome === 'sustained_contact_failure') deps.exit(1);
  return outcome;
}
