/**
 * Async generator idle timeout utility.
 *
 * Wraps an async generator with an idle timeout -- if no value is yielded
 * within `timeoutMs`, the wrapper returns normally, converting a hang
 * into a clean exit.
 *
 * This is the primary defense against subprocess hangs where the AI process
 * completes its work but fails to exit (stuck MCP connection, dangling child
 * process, etc.). Without this, the `for await` loop blocks indefinitely and
 * `step_completed` / `node_completed` is never recorded.
 */

/**
 * Default idle timeout: 30 minutes.
 *
 * This is a deadlock detector, not a work limiter. The timer resets on every
 * message type, so it only fires when the subprocess goes completely silent.
 * 30 minutes is generous enough to never interrupt legitimate work while still
 * catching genuine hangs. Per-node `idle_timeout` overrides this default.
 */
export const STEP_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Default idle timeout for a single loop iteration (plan-review, implement, etc.).
 *
 * STEP_IDLE_TIMEOUT_MS is 30 minutes (step-level deadlock detector). Loop
 * iterations on open models can hang a silent OpenRouter call for nearly that
 * entire window (anchor: zero-open re-fire 42ee6575 plan-review iter 2 sat
 * ~28 minutes until human cancel). Per-iteration idle default is much shorter
 * so a dead stream fails closed instead of looking "stuck forever".
 *
 * Override per node with `idle_timeout` (ms). Env: ARCHON_LOOP_ITERATION_IDLE_MS.
 */
export const LOOP_ITERATION_IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes of silence

/**
 * Absolute wall-clock cap for one loop iteration (even if the stream emits
 * keepalives that would reset idle). Env: ARCHON_LOOP_ITERATION_WALL_MS.
 */
export const LOOP_ITERATION_WALL_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes absolute

/**
 * Resolve per-iteration idle timeout at call time so env overrides work in
 * tests and ops without reloading the module.
 */
export function resolveLoopIterationIdleTimeoutMs(nodeOverride?: number): number {
  if (nodeOverride != null && Number.isFinite(nodeOverride) && nodeOverride > 0) {
    return nodeOverride;
  }
  const fromEnv = Number.parseInt(process.env.ARCHON_LOOP_ITERATION_IDLE_MS ?? '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return LOOP_ITERATION_IDLE_TIMEOUT_MS;
}

/**
 * Resolve per-iteration wall timeout at call time so node and env overrides
 * work in tests and ops without reloading the module.
 */
export function resolveLoopIterationWallTimeoutMs(nodeOverride?: number): number {
  if (nodeOverride != null && Number.isFinite(nodeOverride) && nodeOverride > 0) {
    return nodeOverride;
  }
  const fromEnv = Number.parseInt(process.env.ARCHON_LOOP_ITERATION_WALL_MS ?? '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return LOOP_ITERATION_WALL_TIMEOUT_MS;
}

/** Sentinel value to distinguish idle timeout from normal generator completion */
const IDLE_TIMEOUT_SENTINEL = Symbol('IDLE_TIMEOUT');

/**
 * Wraps an async generator with an idle timeout. If no value is yielded within
 * `timeoutMs`, the wrapper returns normally -- converting a hang into a clean exit.
 *
 * When `shouldResetTimer` is provided and returns `false` for a yielded value, the
 * timer is NOT reset -- it keeps counting from the previous reset point. Most callers
 * should omit this parameter (every message resets the timer, which is the correct
 * default for a deadlock detector).
 *
 * When timeout fires:
 * 1. `onTimeout` callback is invoked (use this to abort the subprocess and log)
 * 2. The pending `generator.next()` promise gets a `.catch()` to prevent unhandled rejection
 * 3. We do NOT call `generator.return()` -- it would block on the pending `.next()`
 * 4. The subprocess is cleaned up asynchronously via the abort signal from `onTimeout`
 *
 * @param generator - The async generator to wrap
 * @param timeoutMs - Maximum idle time in milliseconds before terminating
 * @param onTimeout - Optional callback invoked when idle timeout fires (before return)
 * @param shouldResetTimer - Optional predicate; return false to NOT reset the timer for a value
 */
export async function* withIdleTimeout<T>(
  generator: AsyncGenerator<T>,
  timeoutMs: number,
  onTimeout?: () => void,
  shouldResetTimer?: (value: T) => boolean
): AsyncGenerator<T> {
  let timedOut = false;
  let timerStartedAt = Date.now();

  try {
    while (true) {
      const elapsed = Date.now() - timerStartedAt;
      const remaining = Math.max(0, timeoutMs - elapsed);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<typeof IDLE_TIMEOUT_SENTINEL>(resolve => {
        timer = setTimeout(() => {
          resolve(IDLE_TIMEOUT_SENTINEL);
        }, remaining);
      });

      // Start waiting for the next value from the generator
      const nextPromise = generator.next();

      const result = await Promise.race([nextPromise, timeoutPromise]);
      clearTimeout(timer);

      if (result === IDLE_TIMEOUT_SENTINEL) {
        timedOut = true;
        // Prevent unhandled rejection when the subprocess is aborted via onTimeout
        nextPromise.catch((_err: unknown) => {
          // Intentional: swallow rejection from aborted subprocess
        });
        onTimeout?.();
        return;
      }

      if (result.done) return;

      // Reset the timer unless the predicate says not to
      if (!shouldResetTimer || shouldResetTimer(result.value)) {
        timerStartedAt = Date.now();
      }

      yield result.value;
    }
  } finally {
    if (!timedOut) {
      // Normal exit (generator exhausted or consumer broke out) -- safe to clean up
      try {
        await generator.return(undefined as never);
      } catch (e) {
        // Generator cleanup errors are non-fatal but worth logging for diagnostics
        // Dynamic import to avoid circular deps -- this module has zero @archon/* imports
        try {
          const { createLogger } = await import('@archon/paths');
          createLogger('idle-timeout').warn(
            { err: e as Error },
            'idle_timeout.generator_cleanup_failed'
          );
        } catch {
          // If logger is unavailable, swallow -- cleanup is best-effort
        }
      }
    }
    // If timed out, don't call generator.return() -- it would hang on the pending .next()
    // The onTimeout callback aborts the subprocess, which causes the pending .next()
    // to reject (caught by nextPromise.catch above) and the generator to finalize
  }
}
