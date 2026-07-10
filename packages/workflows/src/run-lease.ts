import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { createLogger } from '@archon/paths';
import type { IWorkflowStore } from './store';

const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const PROCESS_WORKER_ID =
  process.env.ARCHON_WORKER_ID ?? `${hostname()}:${String(process.pid)}:${randomUUID()}`;
const log = createLogger('workflow.run-lease');

export async function withRunLease<T>(
  store: IWorkflowStore,
  runId: string,
  operation: (isLeaseValid: () => boolean) => Promise<T>,
  options: {
    ownerId?: string;
    leaseToken?: string;
    leaseDurationMs?: number;
    heartbeatIntervalMs?: number;
    now?: () => Date;
  } = {}
): Promise<T> {
  const authority = await store.getRunAuthority(runId);
  if (!authority) return operation(() => true);

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
        if (!renewed) leaseValid = false;
      })
      .catch(() => {
        leaseValid = false;
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, heartbeatIntervalMs);
  timer.unref?.();

  try {
    return await operation(() => leaseValid);
  } finally {
    clearInterval(timer);
    if (leaseValid) {
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
