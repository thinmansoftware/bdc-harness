import { randomUUID } from 'crypto';
import { getDatabase } from './connection';

export type DispatchTaskType = 'agent_message' | 'run_review' | 'draft_spec' | 'run_report';
export type DispatchMessageStatus = 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';
export type DispatchWorkerStatus = 'available' | 'unavailable';

export interface DispatchMessage {
  id: string;
  correlation_id: string;
  idempotency_key: string;
  task_type: DispatchTaskType;
  sender: string;
  recipient: string;
  body: string;
  status: DispatchMessageStatus;
  result_body: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  not_before: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
}

export interface DispatchWorker {
  worker_id: string;
  host: string;
  capabilities: Record<string, unknown>;
  max_concurrency: number;
  status: DispatchWorkerStatus;
  registered_at: string;
  last_heartbeat_at: string;
}

interface DispatchMessageRow extends Omit<DispatchMessage, 'fencing_token'> {
  fencing_token: number | string;
}

interface DispatchWorkerRow extends Omit<DispatchWorker, 'capabilities'> {
  capabilities: unknown;
}

const DEFAULT_WORKER_STALE_AFTER_MS = 120_000;
const DEFAULT_LEASE_DURATION_MS = 300_000;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeNullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : normalizeTimestamp(value);
}

function normalizeMessage(row: DispatchMessageRow): DispatchMessage {
  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at),
    claimed_at: normalizeNullableTimestamp(row.claimed_at),
    completed_at: normalizeNullableTimestamp(row.completed_at),
    not_before: normalizeNullableTimestamp(row.not_before),
    lease_expires_at: normalizeNullableTimestamp(row.lease_expires_at),
    fencing_token: Number(row.fencing_token),
  };
}

function parseCapabilities(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeWorker(row: DispatchWorkerRow): DispatchWorker {
  return {
    ...row,
    capabilities: parseCapabilities(row.capabilities),
    max_concurrency: Number(row.max_concurrency),
    registered_at: normalizeTimestamp(row.registered_at),
    last_heartbeat_at: normalizeTimestamp(row.last_heartbeat_at),
  };
}

function addMillisecondsIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function staleCutoffIso(staleAfterMs: number): string {
  return new Date(Date.now() - staleAfterMs).toISOString();
}

export async function createMessage(data: {
  correlation_id: string;
  idempotency_key: string;
  task_type: DispatchTaskType;
  sender: string;
  recipient: string;
  body: string;
  not_before?: string | null;
}): Promise<DispatchMessage> {
  const db = getDatabase();
  const now = nowIso();
  const result = await db.query<DispatchMessageRow>(
    `INSERT INTO agent_dispatch_messages
     (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, not_before, fencing_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, 0)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING *`,
    [
      randomUUID(),
      data.correlation_id,
      data.idempotency_key,
      data.task_type,
      data.sender,
      data.recipient,
      data.body,
      now,
      data.not_before ?? null,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create dispatch message');
  return normalizeMessage(row);
}

export async function getMessage(id: string): Promise<DispatchMessage | null> {
  const result = await getDatabase().query<DispatchMessageRow>(
    'SELECT * FROM agent_dispatch_messages WHERE id = $1',
    [id]
  );
  const row = result.rows[0];
  return row ? normalizeMessage(row) : null;
}

export async function listMessages(filters: {
  recipient?: string;
  status?: DispatchMessageStatus;
  limit?: number;
}): Promise<DispatchMessage[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.recipient) {
    params.push(filters.recipient);
    clauses.push(`recipient = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(filters.limit ?? 100, 500)));
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await getDatabase().query<DispatchMessageRow>(
    `SELECT * FROM agent_dispatch_messages ${where} ORDER BY created_at ASC LIMIT $${params.length}`,
    params
  );
  return result.rows.map(normalizeMessage);
}

export async function registerWorker(data: {
  worker_id: string;
  host: string;
  capabilities: Record<string, unknown>;
  max_concurrency: number;
}): Promise<DispatchWorker> {
  const now = nowIso();
  const capabilitiesJson = JSON.stringify(data.capabilities);
  const result = await getDatabase().query<DispatchWorkerRow>(
    `INSERT INTO agent_dispatch_workers
     (worker_id, host, capabilities, max_concurrency, status, registered_at, last_heartbeat_at)
     VALUES ($1, $2, $3, $4, 'available', $5, $5)
     ON CONFLICT (worker_id) DO UPDATE SET
       host = EXCLUDED.host,
       capabilities = EXCLUDED.capabilities,
       max_concurrency = EXCLUDED.max_concurrency,
       status = 'available',
       last_heartbeat_at = EXCLUDED.last_heartbeat_at
     RETURNING *`,
    [data.worker_id, data.host, capabilitiesJson, data.max_concurrency, now]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to register dispatch worker');
  return normalizeWorker(row);
}

export async function heartbeatWorker(data: {
  worker_id: string;
  status?: DispatchWorkerStatus;
}): Promise<DispatchWorker | null> {
  const db = getDatabase();
  const now = nowIso();
  if (db.dialect === 'postgres') {
    const result = await db.query<DispatchWorkerRow>(
      `UPDATE agent_dispatch_workers
       SET status = $2, last_heartbeat_at = $3
       WHERE worker_id = $1
       RETURNING *`,
      [data.worker_id, data.status ?? 'available', now]
    );
    const row = result.rows[0];
    return row ? normalizeWorker(row) : null;
  }

  const result = await db.query(
    `UPDATE agent_dispatch_workers
     SET status = $2, last_heartbeat_at = $3
     WHERE worker_id = $1`,
    [data.worker_id, data.status ?? 'available', now]
  );
  if (result.rowCount !== 1) return null;
  return getWorker(data.worker_id);
}

export async function getWorker(workerId: string): Promise<DispatchWorker | null> {
  const result = await getDatabase().query<DispatchWorkerRow>(
    'SELECT * FROM agent_dispatch_workers WHERE worker_id = $1',
    [workerId]
  );
  const row = result.rows[0];
  return row ? normalizeWorker(row) : null;
}

export async function evaluateWorkerStaleness(
  staleAfterMs = DEFAULT_WORKER_STALE_AFTER_MS
): Promise<number> {
  const result = await getDatabase().query(
    `UPDATE agent_dispatch_workers
     SET status = 'unavailable'
     WHERE status = 'available' AND last_heartbeat_at < $1`,
    [staleCutoffIso(staleAfterMs)]
  );
  return result.rowCount;
}

export async function claimMessage(data: {
  id: string;
  worker_id: string;
  leaseDurationMs?: number;
  workerStaleAfterMs?: number;
}): Promise<DispatchMessage | null> {
  const db = getDatabase();
  await evaluateWorkerStaleness(data.workerStaleAfterMs ?? DEFAULT_WORKER_STALE_AFTER_MS);
  const now = nowIso();
  const leaseExpiresAt = addMillisecondsIso(data.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS);
  return db.withTransaction(async txQuery => {
    const worker = await txQuery<DispatchWorkerRow>(
      `SELECT * FROM agent_dispatch_workers
       WHERE worker_id = $1 AND status = 'available' AND last_heartbeat_at >= $2`,
      [data.worker_id, staleCutoffIso(data.workerStaleAfterMs ?? DEFAULT_WORKER_STALE_AFTER_MS)]
    );
    if (worker.rowCount !== 1) return null;

    const existing = await txQuery<DispatchMessageRow>(
      `SELECT * FROM agent_dispatch_messages WHERE id = $1`,
      [data.id]
    );
    const row = existing.rows[0];
    if (!row) return null;
    const current = normalizeMessage(row);
    const claimable =
      current.status === 'queued' ||
      (current.status === 'claimed' &&
        current.lease_expires_at !== null &&
        new Date(current.lease_expires_at).getTime() <= Date.now());
    const notBeforeReady =
      current.not_before === null || new Date(current.not_before).getTime() <= Date.now();
    if (!claimable || !notBeforeReady) return null;

    await txQuery(
      `UPDATE agent_dispatch_messages
       SET status = 'claimed',
           claimed_at = $2,
           lease_owner = $3,
           lease_expires_at = $4,
           fencing_token = fencing_token + 1
       WHERE id = $1
         AND (
           status = 'queued'
           OR (status = 'claimed' AND lease_expires_at <= $2)
         )
         AND (not_before IS NULL OR not_before <= $2)`,
      [data.id, now, data.worker_id, leaseExpiresAt]
    );
    const claimed = await txQuery<DispatchMessageRow>(
      'SELECT * FROM agent_dispatch_messages WHERE id = $1 AND lease_owner = $2',
      [data.id, data.worker_id]
    );
    const claimedRow = claimed.rows[0];
    return claimedRow ? normalizeMessage(claimedRow) : null;
  });
}

export async function postResult(data: {
  id: string;
  worker_id: string;
  fencing_token: number;
  result_body: string;
  status?: 'done' | 'failed';
}): Promise<DispatchMessage | null> {
  const db = getDatabase();
  const now = nowIso();
  const status = data.status ?? 'done';
  if (db.dialect === 'postgres') {
    const result = await db.query<DispatchMessageRow>(
      `UPDATE agent_dispatch_messages
       SET status = $4,
           result_body = $5,
           completed_at = $6,
           lease_expires_at = NULL
       WHERE id = $1
         AND lease_owner = $2
         AND fencing_token = $3
         AND status = 'claimed'
       RETURNING *`,
      [data.id, data.worker_id, data.fencing_token, status, data.result_body, now]
    );
    const row = result.rows[0];
    return row ? normalizeMessage(row) : null;
  }

  const result = await db.query(
    `UPDATE agent_dispatch_messages
     SET status = $4,
         result_body = $5,
         completed_at = $6,
         lease_expires_at = NULL
     WHERE id = $1
       AND lease_owner = $2
       AND fencing_token = $3
       AND status = 'claimed'`,
    [data.id, data.worker_id, data.fencing_token, status, data.result_body, now]
  );
  if (result.rowCount !== 1) return null;
  return getMessage(data.id);
}

export async function cancelMessage(id: string): Promise<DispatchMessage | null> {
  const db = getDatabase();
  const now = nowIso();
  if (db.dialect === 'postgres') {
    const result = await db.query<DispatchMessageRow>(
      `UPDATE agent_dispatch_messages
       SET status = 'cancelled',
           completed_at = $2,
           lease_expires_at = NULL
       WHERE id = $1 AND status IN ('queued', 'claimed')
       RETURNING *`,
      [id, now]
    );
    const row = result.rows[0];
    return row ? normalizeMessage(row) : getMessage(id);
  }

  await db.query(
    `UPDATE agent_dispatch_messages
     SET status = 'cancelled',
         completed_at = $2,
         lease_expires_at = NULL
     WHERE id = $1 AND status IN ('queued', 'claimed')`,
    [id, now]
  );
  return getMessage(id);
}
