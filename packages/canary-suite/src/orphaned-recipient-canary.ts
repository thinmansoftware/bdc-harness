import {
  failResult,
  openOutcomeDatabase,
  passResult,
  type OutcomeCanaryDeps,
  type OutcomeCanaryResult,
} from './outcome-canary';

export const ORPHAN_QUEUED_AFTER_MS = 24 * 60 * 60 * 1000;

export interface OrphanedRecipient {
  readonly recipient: string;
  readonly count: number;
  readonly oldest_age_seconds: number;
}

export interface OrphanedRecipientCanaryDeps extends OutcomeCanaryDeps {
  readonly queueUrl?: string;
  /** Heartbeat freshness window; defaults to WORKER_STALE_AFTER_MS. */
  readonly staleAfterMs?: number;
}

interface QueuedRecipientAgeRow {
  readonly recipient: string;
  readonly count: number | string;
  readonly oldest_created_at: string;
}

// Mirrors DEFAULT_WORKER_STALE_AFTER_MS in packages/core/src/db/dispatch.ts. Kept local so
// the canary package does not acquire a production dependency on @archon/core.
export const WORKER_STALE_AFTER_MS = 120_000;

interface WorkerRow {
  readonly worker_id: string;
  readonly capabilities: string;
  readonly status: string;
  readonly last_heartbeat_at: string;
}

interface QueueResponse {
  readonly orphaned?: readonly OrphanedRecipient[];
}

function workerCoversRecipient(worker: WorkerRow, recipient: string): boolean {
  let principal = '';
  try {
    const capabilities = JSON.parse(worker.capabilities) as { principal?: unknown };
    principal =
      typeof capabilities.principal === 'string' ? capabilities.principal.trim().toLowerCase() : '';
  } catch {
    principal = '';
  }
  const workerId = worker.worker_id.trim().toLowerCase();
  return principal === recipient || workerId === recipient;
}

function heartbeatIsFresh(lastHeartbeatAt: string, nowMs: number, staleAfterMs: number): boolean {
  const heartbeatMs = Date.parse(lastHeartbeatAt);
  return Number.isFinite(heartbeatMs) && nowMs - heartbeatMs <= staleAfterMs;
}

export function listOrphaned(
  rows: readonly QueuedRecipientAgeRow[],
  workers: readonly WorkerRow[],
  nowMs: number,
  staleAfterMs: number = WORKER_STALE_AFTER_MS
): OrphanedRecipient[] {
  // A worker covers a recipient only when it is available AND its heartbeat is fresh; a
  // row left 'available' by a dead worker must not hide stranded queue work.
  const live = workers.filter(
    worker =>
      worker.status === 'available' &&
      heartbeatIsFresh(worker.last_heartbeat_at, nowMs, staleAfterMs)
  );
  const orphaned: OrphanedRecipient[] = [];
  for (const row of rows) {
    const oldestMs = Date.parse(row.oldest_created_at);
    if (!Number.isFinite(oldestMs) || nowMs - oldestMs < ORPHAN_QUEUED_AFTER_MS) continue;
    const recipient = row.recipient.trim().toLowerCase();
    if (live.some(worker => workerCoversRecipient(worker, recipient))) continue;
    orphaned.push({
      recipient: row.recipient,
      count: Number(row.count),
      oldest_age_seconds: Math.max(0, Math.floor((nowMs - oldestMs) / 1000)),
    });
  }
  return orphaned;
}

async function fetchQueueOrphans(
  deps: OrphanedRecipientCanaryDeps
): Promise<OrphanedRecipient[] | null> {
  if (!deps.queueUrl || !deps.operatorToken) return null;
  try {
    const response = await (deps.fetcher ?? fetch)(deps.queueUrl, {
      headers: { 'x-archon-operator-token': deps.operatorToken },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as QueueResponse;
    return body.orphaned ? [...body.orphaned] : [];
  } catch {
    return null;
  }
}

export async function runOrphanedRecipientCanary(
  deps: OrphanedRecipientCanaryDeps
): Promise<OutcomeCanaryResult> {
  const liveOrphans = await fetchQueueOrphans(deps);
  let opened: ReturnType<typeof openOutcomeDatabase> | undefined;
  try {
    const nowMs = (deps.now ?? Date.now)();
    let orphaned: OrphanedRecipient[];
    if (liveOrphans) {
      orphaned = liveOrphans;
    } else {
      opened = openOutcomeDatabase(deps, 'c5_db_path_required');
      const rows = opened.db
        .query<QueuedRecipientAgeRow>(
          `SELECT recipient, COUNT(*) AS count, MIN(created_at) AS oldest_created_at
           FROM agent_dispatch_messages
           WHERE status = 'queued'
           GROUP BY recipient`
        )
        .all();
      const workers = opened.db
        .query<WorkerRow>(
          'SELECT worker_id, capabilities, status, last_heartbeat_at FROM agent_dispatch_workers'
        )
        .all();
      orphaned = listOrphaned(rows, workers, nowMs, deps.staleAfterMs);
    }
    const first = orphaned[0];
    if (first) {
      return failResult(`c5_orphaned_recipient:${first.recipient}`, [
        `count=${first.count}`,
        `oldest_age_seconds=${first.oldest_age_seconds}`,
      ]);
    }
    return passResult(['orphaned=0']);
  } catch (error) {
    return failResult('c5_orphaned_recipient:db_unreachable', [
      `error=${(error as Error).message}`,
    ]);
  } finally {
    opened?.close();
  }
}
