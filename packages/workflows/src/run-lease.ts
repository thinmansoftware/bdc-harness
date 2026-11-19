import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { createLogger } from '@archon/paths';
import type { IWorkflowStore } from './store';
import { isTeardownConfirmed, isTerminalRunStatus } from './run-teardown';

const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const PROCESS_WORKER_ID =
  process.env.ARCHON_WORKER_ID ?? `${hostname()}:${String(process.pid)}:${randomUUID()}`;
const log = createLogger('workflow.run-lease');

/**
 * Why and when a run lost its lease (WO-HARNESS-RUN-LEASE-LOST-SAYS-SO-01, bdc-xo#5695). The lease stays lost
 * for the rest of the run (one refused heartbeat is final), so this is recorded once, when it happens.
 */
export interface RunLeaseLoss {
  /** `renewal_refused`: the store said no (the lease had expired); `renewal_error`: the renewal threw. */
  reason: 'renewal_refused' | 'renewal_error';
  /** Last successful renewal (or the acquire time), ISO. */
  lastRenewedAt: string;
  /** The expiry that was in force, ISO. */
  expiresAt: string;
  /** When the heartbeat callback saw the refusal, ISO. */
  detectedAt: string;
  /** Where the executor stopped the run because of it; set by the executor. */
  stoppedAt?: 'layer_boundary' | 'before_terminal';
}

const LOSS_REGISTRY_MAX = 200;
const lossByRun = new Map<string, RunLeaseLoss>();

/** Remember a loss for a run (the lease wrapper calls this; tests call it to stage a loss). */
export function recordRunLeaseLoss(runId: string, loss: RunLeaseLoss): void {
  if (!lossByRun.has(runId) && lossByRun.size >= LOSS_REGISTRY_MAX) {
    const oldest = lossByRun.keys().next().value;
    if (oldest !== undefined) lossByRun.delete(oldest);
  }
  lossByRun.set(runId, loss);
}

/** Test hook: forget every recorded loss. */
export function clearRunLeaseLossesForTests(): void {
  lossByRun.clear();
}

/** The recorded loss for a run in this process, or null. Read by the executor's backstop. */
export function getRunLeaseLoss(runId: string): RunLeaseLoss | null {
  return lossByRun.get(runId) ?? null;
}

/** Seconds from the lease expiry to `at` (never negative). */
export function runLeaseGapSeconds(loss: RunLeaseLoss, at: Date): number {
  const expires = Date.parse(loss.expiresAt);
  if (Number.isNaN(expires)) return 0;
  return Math.max(0, Math.round((at.getTime() - expires) / 1000));
}

export async function withRunLease<T>(
  store: IWorkflowStore,
  runId: string,
  operation: (isLeaseValid: () => boolean, getLoss: () => RunLeaseLoss | null) => Promise<T>,
  options: {
    ownerId?: string;
    leaseToken?: string;
    leaseDurationMs?: number;
    heartbeatIntervalMs?: number;
    now?: () => Date;
  } = {}
): Promise<T> {
  const authority = await store.getRunAuthority(runId);
  if (!authority) {
    return operation(
      () => true,
      () => null
    );
  }

  const now = options.now ?? ((): Date => new Date());
  const ownerId = options.ownerId ?? PROCESS_WORKER_ID;
  const leaseToken = options.leaseToken ?? randomUUID();
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const acquiredAt = now();
  const claimed = await store.claimRunLease({
    runId,
    ownerId,
    leaseToken,
    acquiredAt: acquiredAt.toISOString(),
    lastHeartbeatAt: acquiredAt.toISOString(),
    expiresAt: new Date(acquiredAt.getTime() + leaseDurationMs).toISOString(),
    releasedAt: null,
  });
  if (!claimed) throw new Error(`run_lease_conflict: active worker owns run ${runId}`);

  let leaseValid = true;
  let loss: RunLeaseLoss | null = null;
  let lastRenewedAt = acquiredAt.toISOString();
  let currentExpiresAt = new Date(acquiredAt.getTime() + leaseDurationMs).toISOString();
  const markLost = (reason: RunLeaseLoss['reason']): void => {
    leaseValid = false;
    if (loss) return;
    loss = {
      reason,
      lastRenewedAt,
      expiresAt: currentExpiresAt,
      detectedAt: now().toISOString(),
    };
    recordRunLeaseLoss(runId, loss);
    log.warn({ runId, ownerId, ...loss }, 'run_lease_lost_recorded');
  };
  let heartbeatInFlight = false;
  const timer = setInterval(() => {
    if (heartbeatInFlight || !leaseValid) return;
    heartbeatInFlight = true;
    const heartbeatAt = now();
    void store
      .heartbeatRunLease({
        runId,
        ownerId,
        leaseToken,
        heartbeatAt: heartbeatAt.toISOString(),
        expiresAt: new Date(heartbeatAt.getTime() + leaseDurationMs).toISOString(),
      })
      .then(renewed => {
        if (renewed) {
          lastRenewedAt = heartbeatAt.toISOString();
          currentExpiresAt = new Date(heartbeatAt.getTime() + leaseDurationMs).toISOString();
        } else {
          markLost('renewal_refused');
        }
      })
      .catch(() => {
        markLost('renewal_error');
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, heartbeatIntervalMs);
  timer.unref?.();

  try {
    return await operation(
      () => leaseValid,
      () => loss
    );
  } finally {
    clearInterval(timer);
    // N5 (WO-HARNESS-REPAIR-HOLDER-TEARDOWN-01): a terminal run whose teardown is
    // confirmed releases its lease even when a heartbeat renewal failed; a terminal
    // run whose teardown is unconfirmed keeps its lease. The release stays
    // token-matched, so a lease another worker re-claimed is never touched.
    // Non-terminal runs (paused, interrupted) keep the prior behavior.
    // When the final run state cannot be established (read failed, row missing,
    // store without getWorkflowRun) the lease is kept: release requires proof.
    const finalState = await readFinalRunState(store, runId);
    let shouldRelease = false;
    if (finalState === null) {
      log.warn({ runId, ownerId, leaseValid }, 'run_lease_held_final_state_unknown');
    } else if (finalState.terminal) {
      shouldRelease = finalState.teardownConfirmed;
      if (!finalState.teardownConfirmed) {
        log.warn({ runId, ownerId, leaseValid }, 'run_lease_held_teardown_unconfirmed');
      }
    } else {
      shouldRelease = leaseValid;
    }
    if (shouldRelease) {
      await store
        .releaseRunLease({
          runId,
          ownerId,
          leaseToken,
          releasedAt: now().toISOString(),
        })
        .catch((error: unknown) => {
          log.error({ err: error, runId, ownerId }, 'run_lease_release_failed');
        });
    }
  }
}

async function readFinalRunState(
  store: IWorkflowStore,
  runId: string
): Promise<{ terminal: boolean; teardownConfirmed: boolean } | null> {
  if (typeof store.getWorkflowRun !== 'function') return null;
  try {
    const run = await store.getWorkflowRun(runId);
    if (!run) return null;
    return {
      terminal: isTerminalRunStatus(run.status),
      teardownConfirmed: isTeardownConfirmed(run.metadata),
    };
  } catch (error) {
    log.warn({ err: error as Error, runId }, 'run_lease_final_state_read_failed');
    return null;
  }
}
