/**
 * Merge-sweep liveness alarm (WO-HARNESS-MERGE-SWEEP-LIVENESS-AND-PAGING-01).
 *
 * On 2026-11-04 the merge sweep stopped at 16:29Z and nobody knew for about an
 * hour. The watcher stamps progress here (pass start, heartbeat, each settled
 * record, iteration end); an INDEPENDENT timer compares the newest stamp to the
 * clock. Silence beyond the threshold logs an error and pages the operator
 * through the same dispatch path the Taskmaster dead-man checker uses.
 *
 * Exactly one operator message per silence episode; a failed post stays
 * un-armed and retries on the next check.
 */
import {
  createAuthenticatedMessage,
  type CreateAuthenticatedMessageData,
  type DispatchSenderContext,
} from '@archon/core/db/dispatch';
import { createLogger } from '@archon/paths';

const log = createLogger('overseer/merge-sweep-liveness');

export const DEFAULT_LIVENESS_MAX_SILENCE_MS = 600_000;
export const DEFAULT_LIVENESS_CHECK_MS = 60_000;

let lastProgressAtMs: number = Date.now();

/** Stamp that the sweep is alive. Cheap; safe to call from any hot path. */
export function recordSweepProgress(atMs: number = Date.now()): void {
  lastProgressAtMs = atMs;
}

export function getLastSweepProgressAt(): number {
  return lastProgressAtMs;
}

export interface LivenessLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface MergeSweepLivenessDeps {
  readonly now?: () => number;
  readonly createMessage?: (
    context: DispatchSenderContext,
    data: CreateAuthenticatedMessageData
  ) => Promise<unknown>;
  readonly logger?: LivenessLogger;
  /** Default: MERGE_SWEEP_LIVENESS_MAX_SILENCE_MS or 600000. 0 disables the monitor. */
  readonly maxSilenceMs?: number;
  /** Default: MERGE_SWEEP_LIVENESS_CHECK_MS or 60000. */
  readonly checkIntervalMs?: number;
  /** Tests: do not arm a real interval; drive check() by hand. */
  readonly startTimer?: boolean;
}

export interface MergeSweepLivenessMonitor {
  /** One liveness evaluation. Never throws. Returns true when an alarm is active. */
  check(): Promise<boolean>;
  stop(): void;
}

function readMs(raw: string | undefined, fallback: number, allowZero: boolean): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  if (value === 0 && !allowZero) return fallback;
  return value;
}

export function resolveLivenessMaxSilenceMs(
  raw = process.env.MERGE_SWEEP_LIVENESS_MAX_SILENCE_MS
): number {
  return readMs(raw, DEFAULT_LIVENESS_MAX_SILENCE_MS, true);
}

export function resolveLivenessCheckMs(raw = process.env.MERGE_SWEEP_LIVENESS_CHECK_MS): number {
  return readMs(raw, DEFAULT_LIVENESS_CHECK_MS, false);
}

/**
 * Start the monitor. Startup time counts as the first progress stamp. Returns
 * a handle whose stop() clears the timer; with max silence 0 no timer is armed
 * and check() is a no-op.
 */
export function startMergeSweepLivenessMonitor(
  deps: MergeSweepLivenessDeps = {}
): MergeSweepLivenessMonitor {
  const now = deps.now ?? ((): number => Date.now());
  const createMessage = deps.createMessage ?? createAuthenticatedMessage;
  const logger: LivenessLogger = deps.logger ?? log;
  const maxSilenceMs = deps.maxSilenceMs ?? resolveLivenessMaxSilenceMs();
  const checkIntervalMs = deps.checkIntervalMs ?? resolveLivenessCheckMs();

  if (maxSilenceMs === 0) {
    logger.info({}, 'merge-coordinator.liveness_monitor_disabled');
    return { check: () => Promise.resolve(false), stop: (): void => undefined };
  }

  recordSweepProgress(now());

  let alarmActive = false;
  let paged = false;
  let episodeKey: string | null = null;
  let checking = false;

  const check = async (): Promise<boolean> => {
    if (checking) return alarmActive;
    checking = true;
    try {
      const nowMs = now();
      const lastMs = lastProgressAtMs;
      const silenceMs = nowMs - lastMs;
      if (silenceMs <= maxSilenceMs) {
        if (alarmActive) {
          logger.info(
            { lastProgressAt: new Date(lastMs).toISOString() },
            'merge-coordinator.liveness_recovered'
          );
        }
        alarmActive = false;
        paged = false;
        episodeKey = null;
        return false;
      }

      if (!alarmActive || episodeKey === null) {
        alarmActive = true;
        // Stable for the episode: keyed on the last progress stamp that began it.
        episodeKey = `merge-sweep-liveness:${lastMs}`;
      }
      const silenceSeconds = Math.round(silenceMs / 1000);
      const lastProgressAt = new Date(lastMs).toISOString();
      logger.error(
        { lastProgressAt, silenceSeconds, maxSilenceMs, episodeKey },
        'merge-coordinator.liveness_alarm'
      );

      if (!paged) {
        try {
          await createMessage(
            { kind: 'system', sender: 'overseer' },
            {
              correlation_id: episodeKey,
              idempotency_key: `overseer:${episodeKey}`,
              task_type: 'agent_message',
              recipient: 'operator',
              priority: 'blocker',
              body:
                `Merge sweep liveness alarm (${new Date(nowMs).toISOString()}): no merge-coordinator ` +
                `pass has completed for ${silenceSeconds}s (last progress ${lastProgressAt}, ` +
                `threshold ${Math.round(maxSilenceMs / 1000)}s). Approved green PRs are NOT being ` +
                'merged automatically. Check archon-app-1 logs for ' +
                'overseer_runtime.watcher_exception_degraded and merge-coordinator.*; see ' +
                'docs/operations/merge-manager.md "Sweep liveness and supervision".',
            }
          );
          paged = true;
          logger.info({ episodeKey }, 'merge-coordinator.liveness_alarm_paged');
        } catch (error) {
          // Stay un-armed so the next check retries the page.
          logger.error(
            { err: error as Error, episodeKey },
            'merge-coordinator.liveness_alarm_page_failed'
          );
        }
      }
      return true;
    } catch (error) {
      logger.error({ err: error as Error }, 'merge-coordinator.liveness_check_failed');
      return alarmActive;
    } finally {
      checking = false;
    }
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  if (deps.startTimer !== false) {
    timer = setInterval(() => {
      void check();
    }, checkIntervalMs);
    // Never keep the process alive for a watchdog.
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    check,
    stop: (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
