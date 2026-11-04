/**
 * Deadline wrapper for every await inside a merge-sweep pass
 * (WO-HARNESS-MERGE-SWEEP-LIVENESS-AND-PAGING-01).
 *
 * A pass that awaits a promise that never settles never reaches its heartbeat
 * and never schedules the next pass. withBoundedAwait turns "hangs forever"
 * into a named, catchable error so each call site can isolate it exactly like
 * the throw path it already handles.
 */

export const DEFAULT_STEP_TIMEOUT_MS = 60_000;
export const DEFAULT_RECORD_TIMEOUT_MS = 180_000;
export const DEFAULT_PASS_TIMEOUT_MS = 300_000;

export class BoundedAwaitTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`bounded_await_timeout: ${label} did not settle within ${timeoutMs}ms`);
    this.name = 'BoundedAwaitTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/** The caller's own signal aborted (aggregate deadline, shutdown): the wait was cancelled. */
export class BoundedAwaitAbortedError extends Error {
  readonly label: string;

  constructor(label: string) {
    super(`bounded_await_aborted: ${label} was cancelled by its caller`);
    this.name = 'BoundedAwaitAbortedError';
    this.label = label;
  }
}

export interface BoundedAwaitOptions {
  /**
   * Outer cancellation. When it aborts, the wait rejects at once with
   * BoundedAwaitAbortedError and the signal handed to `fn` is aborted.
   */
  readonly signal?: AbortSignal;
  /** Called once, just before the timeout rejection, so the caller can log it. */
  readonly onTimeout?: (error: BoundedAwaitTimeoutError) => void;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function readPositiveMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function resolveStepTimeoutMs(raw = process.env.MERGE_SWEEP_STEP_TIMEOUT_MS): number {
  return readPositiveMs(raw, DEFAULT_STEP_TIMEOUT_MS);
}

export function resolveRecordTimeoutMs(raw = process.env.MERGE_SWEEP_RECORD_TIMEOUT_MS): number {
  return readPositiveMs(raw, DEFAULT_RECORD_TIMEOUT_MS);
}

export function resolvePassTimeoutMs(raw = process.env.MERGE_SWEEP_PASS_TIMEOUT_MS): number {
  return readPositiveMs(raw, DEFAULT_PASS_TIMEOUT_MS);
}

/**
 * Run `fn(signal)` and reject with BoundedAwaitTimeoutError at the deadline.
 *
 * - The timer is cleared on every path (resolve, reject, sync throw, timeout).
 * - On timeout the signal handed to `fn` is aborted so cooperative callees stop.
 * - The abandoned promise gets a no-op catch, so a late rejection can never
 *   surface as an unhandled rejection.
 * - A synchronous throw from `fn` rejects with the original error.
 */
export function withBoundedAwait<T>(
  label: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  options: BoundedAwaitOptions = {}
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onOuterAbort);
      const error = new BoundedAwaitTimeoutError(label, timeoutMs);
      controller.abort(error);
      try {
        options.onTimeout?.(error);
      } catch {
        // A logging fault must not mask the timeout.
      }
      reject(error);
    }, timeoutMs);

    const outer = options.signal;
    const onOuterAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const error = new BoundedAwaitAbortedError(label);
      controller.abort(error);
      reject(error);
    };
    if (outer) {
      if (outer.aborted) {
        onOuterAbort();
        return;
      }
      outer.addEventListener('abort', onOuterAbort, { once: true });
    }
    const cleanup = (): void => outer?.removeEventListener('abort', onOuterAbort);

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(fn(controller.signal));
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(toError(error));
      return;
    }
    pending.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(toError(error));
      }
    );
  });
}
