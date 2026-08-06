import { randomUUID } from 'crypto';
import { createLogger } from '@archon/paths';
import { getDatabase } from './connection';
import { appendBoardAuditEvent, resolveBoardRecipient } from './board-authority';
import type { QueryResult } from './adapters/types';

const log = createLogger('db/dispatch');

export type DispatchTaskType =
  | 'agent_message'
  | 'run_review'
  | 'draft_spec'
  | 'run_report'
  | 'board_motion';
export type DispatchMessageStatus = 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';
export type DispatchWorkerStatus = 'available' | 'unavailable';
export type DispatchMessagePriority = 'blocker' | 'normal' | 'heartbeat';
export type DispatchTaskOutcome = 'succeeded' | 'failed' | 'blocked';
export type DispatchRouteDisposition = 'unroutable' | 'superseded';
export type DispatchDeliveryMode =
  | 'worker_poll'
  | 'drain_on_start'
  | 'alias_resolved'
  | 'notify_only';

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
  recipient_alias: 'board' | null;
  motion_id: string | null;
  motion_revision_sha: string | null;
  resolved_recipient: string | null;
  resolved_xo_lease_id: string | null;
  resolved_xo_fencing_token: number | null;
  resolved_at: string | null;
  priority: DispatchMessagePriority;
  task_outcome: DispatchTaskOutcome | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  addressed_at: string | null;
  addressed_by: string | null;
  escalated_tg_at: string | null;
  escalated_sms_at: string | null;
  subject_key: string | null;
  route_disposition: DispatchRouteDisposition | null;
  supersedes_id: string | null;
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

interface DispatchMessageRow extends Omit<
  DispatchMessage,
  'fencing_token' | 'resolved_xo_fencing_token'
> {
  fencing_token: number | string;
  resolved_xo_fencing_token: number | string | null;
}

interface DispatchWorkerRow extends Omit<DispatchWorker, 'capabilities'> {
  capabilities: unknown;
}

interface DispatchPrincipalRow {
  principal_id: string;
  delivery_mode: DispatchDeliveryMode;
  active: boolean | number;
}

export type DispatchRecipientAssessment =
  | {
      ok: true;
      canonical_principal: string;
      delivery_mode: DispatchDeliveryMode;
      reason: null;
    }
  | {
      ok: false;
      canonical_principal: string;
      delivery_mode: DispatchDeliveryMode | null;
      reason: 'missing_principal' | 'inactive_principal';
    };

export type DispatchMailboxResult =
  | { ok: true; message: DispatchMessage }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'wrong_mode'
        | 'wrong_recipient'
        | 'not_queued'
        | 'address_before_ack'
        | 'actor_mismatch';
    };

export interface UnroutableQueuedDispatchMessage {
  id: string;
  recipient: string;
  task_type: DispatchTaskType;
  priority: DispatchMessagePriority;
  created_at: string;
}

export type DispatchQueryExecutor = <T>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;

export const DEFAULT_WORKER_STALE_AFTER_MS = 120_000;
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
    resolved_xo_fencing_token:
      row.resolved_xo_fencing_token === null || row.resolved_xo_fencing_token === undefined
        ? null
        : Number(row.resolved_xo_fencing_token),
    resolved_at: normalizeNullableTimestamp(row.resolved_at),
    acknowledged_at: normalizeNullableTimestamp(row.acknowledged_at),
    addressed_at: normalizeNullableTimestamp(row.addressed_at),
    escalated_tg_at: normalizeNullableTimestamp(row.escalated_tg_at),
    escalated_sms_at: normalizeNullableTimestamp(row.escalated_sms_at),
  };
}

function canonicalizePrincipal(principal: string): string {
  return principal.trim().toLowerCase();
}

function isActivePrincipal(row: DispatchPrincipalRow): boolean {
  return row.active === true || row.active === 1;
}

async function getDispatchPrincipal(
  query: DispatchQueryExecutor,
  principalId: string
): Promise<DispatchPrincipalRow | null> {
  const result = await query<DispatchPrincipalRow>(
    'SELECT principal_id, delivery_mode, active FROM dispatch_principals WHERE principal_id = $1',
    [principalId]
  );
  return result.rows[0] ?? null;
}

export async function assessDispatchRecipient(
  recipient: string
): Promise<DispatchRecipientAssessment> {
  const canonicalPrincipal = canonicalizePrincipal(recipient);
  const principal = await getDispatchPrincipal(
    (sql, params) => getDatabase().query(sql, params),
    canonicalPrincipal
  );
  if (!principal) {
    return {
      ok: false,
      canonical_principal: canonicalPrincipal,
      delivery_mode: null,
      reason: 'missing_principal',
    };
  }
  if (!isActivePrincipal(principal)) {
    return {
      ok: false,
      canonical_principal: canonicalPrincipal,
      delivery_mode: principal.delivery_mode,
      reason: 'inactive_principal',
    };
  }
  return {
    ok: true,
    canonical_principal: canonicalPrincipal,
    delivery_mode: principal.delivery_mode,
    reason: null,
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
  } catch (err) {
    log.warn(
      {
        err: err as Error,
        valueType: typeof value,
        valuePreview: typeof value === 'string' ? value.slice(0, 100) : String(value),
      },
      'db.capabilities_parse_failed'
    );
    return {};
  }
}

function normalizeWorker(row: DispatchWorkerRow): DispatchWorker {
  return {
    ...row,
    capabilities: parseCapabilities(row.capabilities),
    max_concurrency: row.max_concurrency,
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
  priority?: DispatchMessagePriority;
  recipient_alias?: 'board' | null;
  motion_id?: string | null;
  motion_revision_sha?: string | null;
}): Promise<DispatchMessage> {
  const db = getDatabase();
  const existing = await db.query<DispatchMessageRow>(
    'SELECT * FROM agent_dispatch_messages WHERE idempotency_key = $1',
    [data.idempotency_key]
  );
  const existingRow = existing.rows[0];
  if (existingRow) return normalizeMessage(existingRow);

  const recipientAssessment = await assessDispatchRecipient(data.recipient);
  if (!recipientAssessment.ok) {
    throw new Error(`dispatch_recipient_rejected:${recipientAssessment.reason}`);
  }
  if (recipientAssessment.canonical_principal === 'board' && data.recipient_alias !== 'board') {
    throw new Error('dispatch_recipient_rejected:board_alias_metadata_required');
  }

  const now = nowIso();
  const result = await db.query<DispatchMessageRow>(
    `INSERT INTO agent_dispatch_messages
     (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, not_before, priority, fencing_token,
      recipient_alias, motion_id, motion_revision_sha)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, $10, 0, $11, $12, $13)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING *`,
    [
      randomUUID(),
      data.correlation_id,
      data.idempotency_key,
      data.task_type,
      data.sender,
      recipientAssessment.canonical_principal,
      data.body,
      now,
      data.not_before ?? null,
      data.priority ?? 'normal',
      data.recipient_alias ?? null,
      data.motion_id ?? null,
      data.motion_revision_sha ?? null,
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
  allowBoardAlias?: boolean;
}): Promise<DispatchMessage[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.recipient) {
    const canonicalRecipient = canonicalizePrincipal(filters.recipient);
    params.push(canonicalRecipient);
    const recipientParam = `$${params.length}`;
    if (filters.allowBoardAlias) {
      const resolved = await resolveDispatchRecipient('board');
      if (resolved.ok && resolved.recipient === canonicalRecipient) {
        clauses.push(
          `(recipient = ${recipientParam} OR (recipient_alias = 'board' AND status = 'queued'))`
        );
      } else {
        if (!resolved.ok && filters.status === 'queued') {
          await recordBoardDeferrals();
        }
        clauses.push(`recipient = ${recipientParam}`);
      }
    } else {
      clauses.push(`recipient = ${recipientParam}`);
    }
  }
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  if (filters.status === 'queued') {
    params.push(nowIso());
    clauses.push(`(not_before IS NULL OR not_before <= $${params.length})`);
    clauses.push('addressed_at IS NULL');
  }
  params.push(Math.max(1, Math.min(filters.limit ?? 100, 500)));
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const order =
    filters.status === 'queued'
      ? "ORDER BY CASE priority WHEN 'blocker' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at ASC"
      : 'ORDER BY created_at ASC';
  const result = await getDatabase().query<DispatchMessageRow>(
    `SELECT * FROM agent_dispatch_messages ${where} ${order} LIMIT $${params.length}`,
    params
  );
  return result.rows.map(normalizeMessage);
}

export async function resolveDispatchRecipient(recipient: string): Promise<
  | {
      ok: true;
      recipient: string;
      recipient_alias: 'board' | null;
      resolved_xo_lease_id: string | null;
      resolved_xo_fencing_token: number | null;
    }
  | { ok: false; reason: 'no_valid_xo_lease' }
> {
  if (recipient !== 'board') {
    return {
      ok: true,
      recipient,
      recipient_alias: null,
      resolved_xo_lease_id: null,
      resolved_xo_fencing_token: null,
    };
  }
  const resolved = await resolveBoardRecipient();
  if (!resolved.ok) return { ok: false, reason: 'no_valid_xo_lease' };
  return {
    ok: true,
    recipient: resolved.principal_id,
    recipient_alias: 'board',
    resolved_xo_lease_id: resolved.lease_id,
    resolved_xo_fencing_token: resolved.fencing_token,
  };
}

async function recordBoardDeferrals(): Promise<void> {
  const result = await getDatabase().query<
    Pick<DispatchMessageRow, 'id' | 'motion_id' | 'motion_revision_sha'>
  >(
    `SELECT id, motion_id, motion_revision_sha
     FROM agent_dispatch_messages
     WHERE recipient_alias = 'board' AND status = 'queued'
     ORDER BY created_at ASC
     LIMIT 100`
  );
  for (const row of result.rows) {
    await appendBoardAuditEvent({
      event_type: 'board_recipient_deferred',
      actor_principal_id: 'dispatch',
      motion_id: row.motion_id,
      motion_revision_sha: row.motion_revision_sha,
      details: { dispatch_message_id: row.id, reason: 'no_valid_xo_lease' },
    });
  }
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

export async function listWorkers(
  staleAfterMs = DEFAULT_WORKER_STALE_AFTER_MS
): Promise<DispatchWorker[]> {
  await evaluateWorkerStaleness(staleAfterMs);
  const result = await getDatabase().query<DispatchWorkerRow>(
    'SELECT * FROM agent_dispatch_workers ORDER BY worker_id ASC'
  );
  return result.rows.map(normalizeWorker);
}

export async function claimMessage(data: {
  id: string;
  worker_id: string;
  delivery_principal?: string | null;
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
      'SELECT * FROM agent_dispatch_messages WHERE id = $1',
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
    let resolvedRecipient: {
      principal_id: string;
      lease_id: string;
      fencing_token: number;
    } | null = null;
    if (current.recipient_alias === 'board') {
      if (!data.delivery_principal) return null;
      const lease = (
        await txQuery<{
          lease_id: string;
          principal_id: string;
          fencing_token: number | string;
        }>(
          `SELECT lease_id, principal_id, fencing_token
           FROM board_xo_leases
           WHERE id = 1 AND released_at IS NULL AND expires_at > $1`,
          [now]
        )
      ).rows[0];
      if (lease?.principal_id !== data.delivery_principal) return null;
      resolvedRecipient = {
        principal_id: lease.principal_id,
        lease_id: lease.lease_id,
        fencing_token: Number(lease.fencing_token),
      };
    }

    const recipientPrincipal = await getDispatchPrincipal(
      txQuery,
      canonicalizePrincipal(current.resolved_recipient ?? current.recipient)
    );
    if (
      recipientPrincipal?.delivery_mode === 'drain_on_start' ||
      recipientPrincipal?.delivery_mode === 'notify_only'
    ) {
      return null;
    }

    await txQuery(
      `UPDATE agent_dispatch_messages
       SET status = 'claimed',
           claimed_at = $2,
           lease_owner = $3,
           lease_expires_at = $4,
           fencing_token = fencing_token + 1,
           resolved_recipient = COALESCE($5, resolved_recipient),
           resolved_xo_lease_id = COALESCE($6, resolved_xo_lease_id),
           resolved_xo_fencing_token = COALESCE($7, resolved_xo_fencing_token),
           resolved_at = CASE WHEN $5 IS NULL THEN resolved_at ELSE $2 END
       WHERE id = $1
         AND (
           status = 'queued'
           OR (status = 'claimed' AND lease_expires_at <= $2)
         )
         AND (not_before IS NULL OR not_before <= $2)`,
      [
        data.id,
        now,
        data.worker_id,
        leaseExpiresAt,
        resolvedRecipient?.principal_id ?? null,
        resolvedRecipient?.lease_id ?? null,
        resolvedRecipient?.fencing_token ?? null,
      ]
    );
    const claimed = await txQuery<DispatchMessageRow>(
      'SELECT * FROM agent_dispatch_messages WHERE id = $1 AND lease_owner = $2',
      [data.id, data.worker_id]
    );
    const claimedRow = claimed.rows[0];
    if (claimedRow?.recipient_alias === 'board' && resolvedRecipient) {
      await txQuery(
        `INSERT INTO board_audit_events (
           id, event_type, actor_principal_id, actor_seat_id, xo_lease_id, xo_fencing_token,
           motion_id, motion_revision_sha, details, created_at
         )
         VALUES ($1, 'board_alias_resolved', $2, NULL, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          resolvedRecipient.principal_id,
          resolvedRecipient.lease_id,
          resolvedRecipient.fencing_token,
          claimedRow.motion_id,
          claimedRow.motion_revision_sha,
          JSON.stringify({ dispatch_message_id: claimedRow.id, worker_id: data.worker_id }),
          now,
        ]
      );
    }
    return claimedRow ? normalizeMessage(claimedRow) : null;
  });
}

function isMailboxDeliveryMode(mode: DispatchDeliveryMode | undefined): boolean {
  return mode === 'drain_on_start' || mode === 'notify_only';
}

async function readMessageInTransaction(
  query: DispatchQueryExecutor,
  id: string
): Promise<DispatchMessage | null> {
  const result = await query<DispatchMessageRow>(
    'SELECT * FROM agent_dispatch_messages WHERE id = $1',
    [id]
  );
  const row = result.rows[0];
  return row ? normalizeMessage(row) : null;
}

async function validateMailboxActor(
  query: DispatchQueryExecutor,
  message: DispatchMessage,
  principalId: string
): Promise<Exclude<DispatchMailboxResult, { ok: true }> | null> {
  const resolvedRecipient = canonicalizePrincipal(message.resolved_recipient ?? message.recipient);
  if (resolvedRecipient !== principalId) return { ok: false, reason: 'wrong_recipient' };
  const recipientPrincipal = await getDispatchPrincipal(query, resolvedRecipient);
  if (!recipientPrincipal || !isMailboxDeliveryMode(recipientPrincipal.delivery_mode)) {
    return { ok: false, reason: 'wrong_mode' };
  }
  if (message.status !== 'queued') return { ok: false, reason: 'not_queued' };
  return null;
}

function isRetriableMailboxTransactionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes('cannot start a transaction within a transaction') ||
    error.message.includes('database is locked') ||
    error.message.includes('SQLITE_BUSY')
  );
}

async function withRetriedMailboxTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetriableMailboxTransactionError(error) || attempt === maxAttempts) throw error;
      await Bun.sleep(attempt * 10);
    }
  }
  throw new Error('mailbox_transaction_retry_exhausted');
}

export async function acknowledgeMessage(data: {
  id: string;
  principal_id: string;
}): Promise<DispatchMailboxResult> {
  const db = getDatabase();
  const principalId = canonicalizePrincipal(data.principal_id);
  const now = nowIso();
  return withRetriedMailboxTransaction(() =>
    db.withTransaction(async txQuery => {
      const message = await readMessageInTransaction(txQuery, data.id);
      if (!message) return { ok: false, reason: 'not_found' };
      const invalid = await validateMailboxActor(txQuery, message, principalId);
      if (invalid) return invalid;
      if (message.acknowledged_by !== null) {
        return message.acknowledged_by === principalId
          ? { ok: true, message }
          : { ok: false, reason: 'actor_mismatch' };
      }

      const update = await txQuery(
        `UPDATE agent_dispatch_messages
       SET acknowledged_at = $2,
           acknowledged_by = $3
       WHERE id = $1
         AND status = 'queued'
         AND acknowledged_at IS NULL
         AND acknowledged_by IS NULL
         AND LOWER(TRIM(COALESCE(resolved_recipient, recipient))) = $3
         AND EXISTS (
           SELECT 1
           FROM dispatch_principals AS recipient_principal
           WHERE recipient_principal.principal_id = LOWER(TRIM(COALESCE(resolved_recipient, recipient)))
             AND recipient_principal.delivery_mode IN ('drain_on_start', 'notify_only')
         )`,
        [data.id, now, principalId]
      );
      const finalMessage = await readMessageInTransaction(txQuery, data.id);
      if (!finalMessage) return { ok: false, reason: 'not_found' };
      const finalInvalid = await validateMailboxActor(txQuery, finalMessage, principalId);
      if (finalInvalid) return finalInvalid;
      if (finalMessage.acknowledged_by === principalId) return { ok: true, message: finalMessage };
      if (update.rowCount === 0 && finalMessage.acknowledged_by === null) {
        return { ok: false, reason: 'actor_mismatch' };
      }
      return { ok: false, reason: 'actor_mismatch' };
    })
  );
}

export async function addressMessage(data: {
  id: string;
  principal_id: string;
}): Promise<DispatchMailboxResult> {
  const db = getDatabase();
  const principalId = canonicalizePrincipal(data.principal_id);
  const now = nowIso();
  return withRetriedMailboxTransaction(() =>
    db.withTransaction(async txQuery => {
      const message = await readMessageInTransaction(txQuery, data.id);
      if (!message) return { ok: false, reason: 'not_found' };
      const invalid = await validateMailboxActor(txQuery, message, principalId);
      if (invalid) return invalid;
      if (message.acknowledged_by === null) return { ok: false, reason: 'address_before_ack' };
      if (message.acknowledged_by !== principalId) return { ok: false, reason: 'actor_mismatch' };
      if (message.addressed_by !== null) {
        return message.addressed_by === principalId
          ? { ok: true, message }
          : { ok: false, reason: 'actor_mismatch' };
      }

      const update = await txQuery(
        `UPDATE agent_dispatch_messages
       SET addressed_at = $2,
           addressed_by = $3
       WHERE id = $1
         AND status = 'queued'
         AND acknowledged_by = $3
         AND addressed_at IS NULL
         AND addressed_by IS NULL
         AND LOWER(TRIM(COALESCE(resolved_recipient, recipient))) = $3
         AND EXISTS (
           SELECT 1
           FROM dispatch_principals AS recipient_principal
           WHERE recipient_principal.principal_id = LOWER(TRIM(COALESCE(resolved_recipient, recipient)))
             AND recipient_principal.delivery_mode IN ('drain_on_start', 'notify_only')
         )`,
        [data.id, now, principalId]
      );
      const finalMessage = await readMessageInTransaction(txQuery, data.id);
      if (!finalMessage) return { ok: false, reason: 'not_found' };
      const finalInvalid = await validateMailboxActor(txQuery, finalMessage, principalId);
      if (finalInvalid) return finalInvalid;
      if (finalMessage.acknowledged_by !== principalId) {
        return { ok: false, reason: 'actor_mismatch' };
      }
      if (finalMessage.addressed_by === principalId) return { ok: true, message: finalMessage };
      if (update.rowCount === 0 && finalMessage.addressed_by === null) {
        return { ok: false, reason: 'actor_mismatch' };
      }
      return { ok: false, reason: 'actor_mismatch' };
    })
  );
}

interface UnroutableQueuedDispatchMessageRow extends Omit<
  UnroutableQueuedDispatchMessage,
  'created_at'
> {
  created_at: unknown;
}

export async function listUnroutableQueuedMessages(
  query?: DispatchQueryExecutor
): Promise<UnroutableQueuedDispatchMessage[]> {
  const execute =
    query ??
    (<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> =>
      getDatabase().query<T>(sql, params));
  const result = await execute<UnroutableQueuedDispatchMessageRow>(
    `SELECT message.id, message.recipient, message.task_type, message.priority, message.created_at
     FROM agent_dispatch_messages AS message
     LEFT JOIN dispatch_principals AS principal
       ON principal.principal_id = LOWER(TRIM(message.recipient))
     WHERE message.status = 'queued'
       AND message.recipient_alias IS NULL
       AND (principal.principal_id IS NULL OR CAST(principal.active AS TEXT) IN ('0', 'false'))
     ORDER BY message.created_at ASC`
  );
  return result.rows.map(row => ({
    ...row,
    created_at: normalizeTimestamp(row.created_at),
  }));
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

/**
 * Extends the lease on a claimed message without changing its fencing token.
 *
 * WO-HARNESS-ACP-DISPATCH-SLICE-01 (M-118 ruling order 4): lease renewal is a
 * mandatory acceptance criterion. Before this, a lease was set once at claim
 * time and never extended, so any agent run longer than the lease duration
 * became silently reclaimable by another worker while still executing.
 *
 * Guards are deliberately identical to postResult: only the current lease
 * owner, holding the current fencing token, on a message still in 'claimed',
 * may renew. The fencing token is NOT incremented -- renewal is not a new
 * claim, and bumping it would invalidate the caller's own in-flight token.
 */
export async function renewMessageLease(data: {
  id: string;
  worker_id: string;
  fencing_token: number;
  leaseDurationMs?: number;
}): Promise<DispatchMessage | null> {
  const db = getDatabase();
  const leaseExpiresAt = addMillisecondsIso(data.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS);
  if (db.dialect === 'postgres') {
    const result = await db.query<DispatchMessageRow>(
      `UPDATE agent_dispatch_messages
       SET lease_expires_at = $4
       WHERE id = $1
         AND lease_owner = $2
         AND fencing_token = $3
         AND status = 'claimed'
       RETURNING *`,
      [data.id, data.worker_id, data.fencing_token, leaseExpiresAt]
    );
    const row = result.rows[0];
    return row ? normalizeMessage(row) : null;
  }

  const result = await db.query(
    `UPDATE agent_dispatch_messages
     SET lease_expires_at = $4
     WHERE id = $1
       AND lease_owner = $2
       AND fencing_token = $3
       AND status = 'claimed'`,
    [data.id, data.worker_id, data.fencing_token, leaseExpiresAt]
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
