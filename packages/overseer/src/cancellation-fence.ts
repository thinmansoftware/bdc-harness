/**
 * Cancellation fences for record handlers (WO-HARNESS-MERGE-SWEEP-LIVENESS-AND-PAGING-01).
 *
 * A record handler that timed out or was stopped holds an aborted AbortSignal.
 * Every REAL mutation it can still reach (merge, approval, comment, action-row
 * write, verdict claim/outcome) checks that signal immediately before it runs and
 * throws RecordHandlerCancelledError instead, so a handler that resumes after
 * cancellation unwinds without acting. Reads pass through untouched.
 */

/**
 * Thrown by a fence when the signal has aborted. Callers log it and unwind; it is
 * never a failure of the work itself.
 */
export class RecordHandlerCancelledError extends Error {
  readonly point: string;

  constructor(point: string) {
    super(`record_handler_cancelled_before_${point}`);
    this.name = 'RecordHandlerCancelledError';
    this.point = point;
  }
}

export function throwIfFenced(signal: AbortSignal | undefined, point: string): void {
  if (signal?.aborted) throw new RecordHandlerCancelledError(point);
}

/**
 * Return a view of `target` whose named methods check `signal` immediately before
 * delegating. Names that are absent or not functions are skipped. `this` stays
 * bound to the original object. Everything else reads through the prototype chain.
 *
 * `shouldFence` lets a caller waive the fence for a specific call (for example the
 * recording of an outcome AFTER a merge was already sent, which is the truth of
 * what happened and must not be lost).
 */
export function fenceMethods<T extends object>(
  target: T,
  names: readonly string[],
  signal: AbortSignal,
  shouldFence: (name: string) => boolean = (): boolean => true
): T {
  const fenced = Object.create(target) as Record<string, unknown>;
  const source = target as Record<string, unknown>;
  for (const name of names) {
    const original = source[name];
    if (typeof original !== 'function') continue;
    fenced[name] = (...args: unknown[]): unknown => {
      if (shouldFence(name)) throwIfFenced(signal, name);
      return (original as (...a: unknown[]) => unknown).apply(target, args);
    };
  }
  return fenced as T;
}

/** The mutating GitHub and action-store dependencies shared by handlers. */
export const MUTATING_DEP_NAMES = [
  'insertOverseerAction',
  'mergePullRequest',
  'commentOnPullRequest',
  'approvePullRequest',
] as const;
