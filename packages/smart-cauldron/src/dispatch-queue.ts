/**
 * dispatch-queue.ts -- Serialized in-process FIFO dispatch queue for cascade fires.
 *
 * John's requirement (2026-08-18: "shouldnt it go to a queue that spaces them
 * out"). Defense-in-depth on top of the deterministic dispatch_token: even when
 * many cascades fire in the same process tick, their dispatch+discovery critical
 * sections run strictly one at a time, in the order they were enqueued (FIFO --
 * priorities are NEVER silently reordered), with a small inter-fire spacing
 * between contended fires. This gives ordering + backpressure so the Archon API
 * is never hit by a co-fire thundering herd.
 *
 * The critical section wrapped here is the WHOLE fire (dispatch + run
 * discovery): one fire resolves its run (or honestly fails) before the next
 * begins. A single, module-level `cascadeDispatchQueue` singleton serializes
 * every cascade fire in this process -- that shared state is exactly what closes
 * the co-fire race across concurrent runCascade() calls.
 *
 * Spacing is applied only when another fire is actually waiting (contention).
 * A lone fire incurs no delay, so sequential single-cascade tier climbs are
 * unaffected; the spacing exists precisely to "space out" bursts.
 */

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

export interface DispatchQueueOptions {
  /**
   * Inter-fire spacing (ms) inserted before the next queued fire begins, applied
   * only when a subsequent fire is already waiting. Default 2000 (~2s).
   */
  spacingMs?: number;
  /** Sleep primitive; injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Depth-telemetry sink; injectable for tests. Defaults to console.log. */
  log?: (message: string) => void;
}

/**
 * A strictly-serial FIFO queue. Every `enqueue`d task runs after all previously
 * enqueued tasks have settled; the returned promise mirrors the task's own
 * result/rejection. A prior task's failure never breaks ordering for the rest.
 */
export class DispatchQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;
  private readonly spacingMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;

  constructor(options: DispatchQueueOptions = {}) {
    this.spacingMs = options.spacingMs ?? 2_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.log =
      options.log ??
      ((message: string): void => {
        console.log(message);
      });
  }

  /** Number of fires currently queued or in flight. */
  get depthNow(): number {
    return this.depth;
  }

  /**
   * Enqueue one dispatch+discovery critical section. Resolves with the task's
   * result once every earlier fire has settled (and its inter-fire spacing has
   * elapsed). Logs queue depth whenever more than one fire is outstanding.
   */
  enqueue<T>(label: string, task: () => Promise<T>): Promise<T> {
    this.depth += 1;
    if (this.depth > 1) {
      this.log(
        `[smart-cauldron] dispatch queue depth=${this.depth} -- fire ${label} waiting behind ` +
          `${this.depth - 1} in-flight/queued dispatch(es)`
      );
    }

    const previous = this.tail;
    const result = (async (): Promise<T> => {
      // Wait for the prior critical section (and its spacing). A prior failure
      // must not break FIFO for this fire, so its outcome is swallowed here --
      // the prior caller already owns that result/error via its own promise.
      try {
        await previous;
      } catch {
        // ignore prior failure; ordering is preserved regardless
      }
      try {
        return await task();
      } finally {
        this.depth -= 1;
      }
    })();

    // The next fire waits for this one to settle, THEN a spacing delay -- but
    // only while others remain queued (depth > 0 after this fire's decrement).
    this.tail = result.then(
      () => this.spaceIfContended(),
      () => this.spaceIfContended()
    );

    return result;
  }

  private async spaceIfContended(): Promise<void> {
    if (this.depth > 0 && this.spacingMs > 0) {
      await this.sleep(this.spacingMs);
    }
  }
}

/**
 * Resolve the configured inter-fire spacing. Defaults to 2000ms; overridable via
 * SMART_CAULDRON_DISPATCH_SPACING_MS (non-negative integer) for operators tuning
 * backpressure without a redeploy.
 */
function resolveSpacingMs(): number {
  const raw = process.env.SMART_CAULDRON_DISPATCH_SPACING_MS;
  if (raw === undefined) return 2_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2_000;
}

/**
 * Process-wide singleton serializing every cascade fire. Shared across all
 * concurrent runCascade() invocations in this process -- the shared queue is
 * what serializes co-fires and closes the thundering-herd race.
 */
export const cascadeDispatchQueue = new DispatchQueue({ spacingMs: resolveSpacingMs() });
