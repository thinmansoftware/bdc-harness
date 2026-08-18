import { randomUUID } from 'crypto';
import { getDatabase } from './connection';
import type { IDatabase } from './adapters/types';

export const OPERATOR_CARD_CHANNELS = ['dispatch', 'builder_monitor'] as const;
export type OperatorCardChannelName = (typeof OPERATOR_CARD_CHANNELS)[number];
export type DeliveryJobState = 'pending' | 'leased' | 'succeeded' | 'exhausted' | 'indeterminate';
export type DeliveryOutcome =
  | 'succeeded'
  | 'transient_failure'
  | 'permanent_failure'
  | 'indeterminate';
export type DeliveryReceiptPhase = 'started' | 'terminal';

export interface AppendOperatorCardInput {
  card_id: string;
  identity_version: string;
  canonical_event_identity: Record<string, unknown>;
  payload_digest: string;
  payload: Record<string, unknown>;
  run_id: string;
  wo_id: string;
  repository: string;
  branch: string | null;
  pr_url: string | null;
  pr_number: number | null;
  head_sha: string | null;
  base_branch: string | null;
  base_sha: string | null;
  checks: Record<string, unknown>;
  mergeability: string;
  blocker: string;
  mechanical_evidence: Record<string, unknown>;
  recovery_attempted: Record<string, unknown>;
  proposed_remediation: Record<string, unknown>;
  next_permitted_action: string;
  responsible_actor: string;
  actionable_event_at: string;
  required_ruling: string | null;
  evidence_links: Record<string, unknown>;
  lifecycle_classification: string;
  governance_classification: string;
  created_at?: string;
}

export interface OperatorCardRecord extends Omit<AppendOperatorCardInput, 'created_at'> {
  created_at: string;
}

export interface DeliveryJobRecord {
  card_id: string;
  channel: OperatorCardChannelName;
  state: DeliveryJobState;
  attempts_started: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  updated_at: string;
}

export interface AppendDeliveryReceiptInput {
  receipt_id?: string;
  card_id: string;
  channel: OperatorCardChannelName;
  attempt_number: number;
  phase: DeliveryReceiptPhase;
  started_at: string;
  completed_at?: string | null;
  outcome?: DeliveryOutcome | null;
  sanitized_status?: string | null;
  error_class?: string | null;
  next_attempt_at?: string | null;
  provider_receipt_id?: string | null;
  fencing_token: number;
  lease_owner: string;
  created_at?: string;
}

export interface DeliveryReceiptRecord {
  receipt_id: string;
  card_id: string;
  channel: OperatorCardChannelName;
  attempt_number: number;
  phase: DeliveryReceiptPhase;
  started_at: string;
  completed_at: string | null;
  outcome: DeliveryOutcome | null;
  sanitized_status: string | null;
  error_class: string | null;
  next_attempt_at: string | null;
  provider_receipt_id: string | null;
  fencing_token: number;
  created_at: string;
}

export interface OperatorCardView {
  card: OperatorCardRecord;
  jobs: DeliveryJobRecord[];
  receipts: DeliveryReceiptRecord[];
  delivery_summary: Record<OperatorCardChannelName, DeliveryJobRecord>;
}

interface OperatorCardRow extends Omit<
  OperatorCardRecord,
  | 'canonical_event_identity'
  | 'payload'
  | 'checks'
  | 'mechanical_evidence'
  | 'recovery_attempted'
  | 'proposed_remediation'
  | 'evidence_links'
  | 'created_at'
> {
  canonical_event_identity: unknown;
  payload: unknown;
  checks: unknown;
  mechanical_evidence: unknown;
  recovery_attempted: unknown;
  proposed_remediation: unknown;
  evidence_links: unknown;
  created_at: unknown;
}

interface DeliveryJobRow extends Omit<
  DeliveryJobRecord,
  'attempts_started' | 'fencing_token' | 'next_attempt_at' | 'lease_expires_at' | 'updated_at'
> {
  attempts_started: number | string;
  fencing_token: number | string;
  next_attempt_at: unknown;
  lease_expires_at: unknown;
  updated_at: unknown;
}

interface DeliveryReceiptRow extends Omit<
  DeliveryReceiptRecord,
  | 'attempt_number'
  | 'fencing_token'
  | 'started_at'
  | 'completed_at'
  | 'next_attempt_at'
  | 'created_at'
> {
  attempt_number: number | string;
  fencing_token: number | string;
  started_at: unknown;
  completed_at: unknown;
  next_attempt_at: unknown;
  created_at: unknown;
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : timestamp(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('overseer_operator_card_json_invalid');
  }
  return parsed as Record<string, unknown>;
}

function normalizeCard(row: OperatorCardRow): OperatorCardRecord {
  return {
    ...row,
    canonical_event_identity: jsonObject(row.canonical_event_identity),
    payload: jsonObject(row.payload),
    checks: jsonObject(row.checks),
    mechanical_evidence: jsonObject(row.mechanical_evidence),
    recovery_attempted: jsonObject(row.recovery_attempted),
    proposed_remediation: jsonObject(row.proposed_remediation),
    evidence_links: jsonObject(row.evidence_links),
    created_at: timestamp(row.created_at),
  };
}

function normalizeJob(row: DeliveryJobRow): DeliveryJobRecord {
  return {
    ...row,
    attempts_started: Number(row.attempts_started),
    fencing_token: Number(row.fencing_token),
    next_attempt_at: timestamp(row.next_attempt_at),
    lease_expires_at: nullableTimestamp(row.lease_expires_at),
    updated_at: timestamp(row.updated_at),
  };
}

function normalizeReceipt(row: DeliveryReceiptRow): DeliveryReceiptRecord {
  return {
    ...row,
    attempt_number: Number(row.attempt_number),
    fencing_token: Number(row.fencing_token),
    started_at: timestamp(row.started_at),
    completed_at: nullableTimestamp(row.completed_at),
    next_attempt_at: nullableTimestamp(row.next_attempt_at),
    created_at: timestamp(row.created_at),
  };
}

function nowIso(value?: string): string {
  return value ?? new Date().toISOString();
}

function plusMilliseconds(value: string, milliseconds: number): string {
  return new Date(new Date(value).getTime() + milliseconds).toISOString();
}

async function selectCard(
  query: IDatabase['query'],
  cardId: string
): Promise<OperatorCardRecord | null> {
  const row = (
    await query<OperatorCardRow>('SELECT * FROM overseer_operator_cards WHERE card_id = $1', [
      cardId,
    ])
  ).rows[0];
  return row ? normalizeCard(row) : null;
}

async function selectJobs(query: IDatabase['query'], cardId: string): Promise<DeliveryJobRecord[]> {
  const result = await query<DeliveryJobRow>(
    'SELECT * FROM overseer_operator_card_delivery_jobs WHERE card_id = $1 ORDER BY channel',
    [cardId]
  );
  return result.rows.map(normalizeJob);
}

export async function appendOperatorCard(input: AppendOperatorCardInput): Promise<{
  card: OperatorCardRecord;
  jobs: DeliveryJobRecord[];
}> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const createdAt = nowIso(input.created_at);
    await query(
      `INSERT INTO overseer_operator_cards (
        card_id, identity_version, canonical_event_identity, payload_digest, payload,
        run_id, wo_id, repository, branch, pr_url, pr_number, head_sha, base_branch, base_sha,
        checks, mergeability, blocker, mechanical_evidence, recovery_attempted,
        proposed_remediation, next_permitted_action, responsible_actor, actionable_event_at,
        required_ruling, evidence_links, lifecycle_classification, governance_classification,
        created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28
      ) ON CONFLICT (card_id) DO NOTHING`,
      [
        input.card_id,
        input.identity_version,
        JSON.stringify(input.canonical_event_identity),
        input.payload_digest,
        JSON.stringify(input.payload),
        input.run_id,
        input.wo_id,
        input.repository,
        input.branch,
        input.pr_url,
        input.pr_number,
        input.head_sha,
        input.base_branch,
        input.base_sha,
        JSON.stringify(input.checks),
        input.mergeability,
        input.blocker,
        JSON.stringify(input.mechanical_evidence),
        JSON.stringify(input.recovery_attempted),
        JSON.stringify(input.proposed_remediation),
        input.next_permitted_action,
        input.responsible_actor,
        input.actionable_event_at,
        input.required_ruling,
        JSON.stringify(input.evidence_links),
        input.lifecycle_classification,
        input.governance_classification,
        createdAt,
      ]
    );

    const card = await selectCard(query, input.card_id);
    if (!card) throw new Error('operator_card_insert_failed');
    if (card.payload_digest !== input.payload_digest) {
      throw new Error('operator_card_digest_conflict');
    }
    for (const channel of OPERATOR_CARD_CHANNELS) {
      await query(
        `INSERT INTO overseer_operator_card_delivery_jobs (
          card_id, channel, state, attempts_started, next_attempt_at, fencing_token, updated_at
        ) VALUES ($1, $2, 'pending', 0, $3, 0, $3)
        ON CONFLICT (card_id, channel) DO NOTHING`,
        [input.card_id, channel, createdAt]
      );
    }
    return { card, jobs: await selectJobs(query, input.card_id) };
  });
}

const REGISTERED_CHANNELS = new Set<string>(OPERATOR_CARD_CHANNELS);

export async function getOperatorCard(cardId: string): Promise<OperatorCardView | null> {
  const db = getDatabase();
  const card = await selectCard(db.query.bind(db), cardId);
  if (!card) return null;
  // Filter to the active channel registry so legacy rows for retired channels
  // (e.g. pre-removal 'notion' jobs/receipts still persisted in the DB) never
  // surface in the view and drift from the narrowed OpenAPI channel enum.
  const jobs = (await selectJobs(db.query.bind(db), cardId)).filter(job =>
    REGISTERED_CHANNELS.has(job.channel)
  );
  const receiptRows = await db.query<DeliveryReceiptRow>(
    `SELECT * FROM overseer_operator_card_delivery_receipts
     WHERE card_id = $1 ORDER BY channel, attempt_number, phase`,
    [cardId]
  );
  const receipts = receiptRows.rows
    .map(normalizeReceipt)
    .filter(receipt => REGISTERED_CHANNELS.has(receipt.channel));
  const summary = Object.fromEntries(jobs.map(job => [job.channel, job])) as Record<
    OperatorCardChannelName,
    DeliveryJobRecord
  >;
  return {
    card,
    jobs,
    receipts,
    delivery_summary: summary,
  };
}

function parseCursor(cursor: string): { createdAt: string; cardId: string } {
  const separator = cursor.lastIndexOf(',');
  if (separator <= 0 || separator === cursor.length - 1) {
    throw new Error('operator_card_cursor_invalid');
  }
  const createdAt = cursor.slice(0, separator);
  const cardId = cursor.slice(separator + 1);
  timestamp(createdAt);
  if (!/^[0-9a-f]{64}$/.test(cardId)) throw new Error('operator_card_cursor_invalid');
  return { createdAt, cardId };
}

export async function listOperatorCards(
  input: {
    limit?: number;
    cursor?: string;
  } = {}
): Promise<{ items: OperatorCardView[]; next_cursor: string | null }> {
  const db = getDatabase();
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  const cursor = input.cursor ? parseCursor(input.cursor) : null;
  const rows = cursor
    ? await db.query<OperatorCardRow>(
        `SELECT * FROM overseer_operator_cards
         WHERE created_at < $1 OR (created_at = $1 AND card_id < $2)
         ORDER BY created_at DESC, card_id DESC LIMIT $3`,
        [cursor.createdAt, cursor.cardId, limit + 1]
      )
    : await db.query<OperatorCardRow>(
        'SELECT * FROM overseer_operator_cards ORDER BY created_at DESC, card_id DESC LIMIT $1',
        [limit + 1]
      );
  const selected = rows.rows.slice(0, limit).map(normalizeCard);
  const items: OperatorCardView[] = [];
  for (const card of selected) {
    const view = await getOperatorCard(card.card_id);
    if (view) items.push(view);
  }
  const last = selected.at(-1);
  return {
    items,
    next_cursor: rows.rows.length > limit && last ? `${last.created_at},${last.card_id}` : null,
  };
}

export async function claimDueDeliveryJob(input: {
  channel?: OperatorCardChannelName;
  owner: string;
  now?: string;
  lease_duration_ms?: number;
}): Promise<DeliveryJobRecord | null> {
  const db = getDatabase();
  const now = nowIso(input.now);
  const leaseExpiresAt = plusMilliseconds(now, input.lease_duration_ms ?? 60_000);
  return db.withTransaction(async query => {
    const params: unknown[] = [now];
    const channelClause = input.channel ? 'AND channel = $2' : '';
    if (input.channel) params.push(input.channel);
    const selected = (
      await query<DeliveryJobRow>(
        `SELECT * FROM overseer_operator_card_delivery_jobs
         WHERE ((state = 'pending' AND attempts_started < 3 AND next_attempt_at <= $1)
             OR (state = 'leased' AND lease_expires_at <= $1))
           ${channelClause}
         ORDER BY next_attempt_at, card_id, channel LIMIT 1`,
        params
      )
    ).rows[0];
    if (!selected) return null;
    const current = normalizeJob(selected);
    const nextAttempt =
      current.state === 'pending' ? current.attempts_started + 1 : current.attempts_started;
    const updated = await query(
      `UPDATE overseer_operator_card_delivery_jobs
       SET state = 'leased', attempts_started = $1, lease_owner = $2,
           lease_expires_at = $3, fencing_token = fencing_token + 1, updated_at = $4
       WHERE card_id = $5 AND channel = $6 AND fencing_token = $7
         AND ((state = 'pending' AND next_attempt_at <= $4)
           OR (state = 'leased' AND lease_expires_at <= $4))`,
      [
        nextAttempt,
        input.owner,
        leaseExpiresAt,
        now,
        current.card_id,
        current.channel,
        current.fencing_token,
      ]
    );
    if (updated.rowCount !== 1) return null;
    const row = (
      await query<DeliveryJobRow>(
        `SELECT * FROM overseer_operator_card_delivery_jobs
         WHERE card_id = $1 AND channel = $2`,
        [current.card_id, current.channel]
      )
    ).rows[0];
    return row ? normalizeJob(row) : null;
  });
}

export async function appendDeliveryReceipt(
  input: AppendDeliveryReceiptInput
): Promise<DeliveryReceiptRecord> {
  const startedAt = nowIso(input.started_at);
  const createdAt = nowIso(input.created_at ?? input.completed_at ?? input.started_at);
  const database = getDatabase();
  const lockClause = database.dialect === 'postgres' ? ' FOR UPDATE' : '';
  return database.withTransaction(async query => {
    const jobRow = (
      await query<DeliveryJobRow>(
        `SELECT * FROM overseer_operator_card_delivery_jobs
         WHERE card_id = $1 AND channel = $2${lockClause}`,
        [input.card_id, input.channel]
      )
    ).rows[0];
    if (!jobRow) throw new Error('delivery_job_not_found');
    const job = normalizeJob(jobRow);
    if (
      job.state !== 'leased' ||
      job.lease_owner !== input.lease_owner ||
      job.fencing_token !== input.fencing_token ||
      job.attempts_started !== input.attempt_number
    ) {
      throw new Error('delivery_receipt_stale_fence');
    }
    const result = await query<DeliveryReceiptRow>(
      `INSERT INTO overseer_operator_card_delivery_receipts (
        receipt_id, card_id, channel, attempt_number, phase, started_at, completed_at,
        outcome, sanitized_status, error_class, next_attempt_at, provider_receipt_id,
        fencing_token, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        input.receipt_id ?? randomUUID(),
        input.card_id,
        input.channel,
        input.attempt_number,
        input.phase,
        startedAt,
        input.completed_at ?? null,
        input.outcome ?? null,
        input.sanitized_status ?? null,
        input.error_class ?? null,
        input.next_attempt_at ?? null,
        input.provider_receipt_id ?? null,
        input.fencing_token,
        createdAt,
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error('delivery_receipt_insert_failed');
    return normalizeReceipt(row);
  });
}

export async function completeDeliveryJob(input: {
  card_id: string;
  channel: OperatorCardChannelName;
  owner: string;
  fencing_token: number;
  outcome: DeliveryOutcome;
  now?: string;
}): Promise<DeliveryJobRecord> {
  const db = getDatabase();
  const now = nowIso(input.now);
  return db.withTransaction(async query => {
    const jobRow = (
      await query<DeliveryJobRow>(
        `SELECT * FROM overseer_operator_card_delivery_jobs
         WHERE card_id = $1 AND channel = $2`,
        [input.card_id, input.channel]
      )
    ).rows[0];
    if (!jobRow) throw new Error('delivery_job_not_found');
    const job = normalizeJob(jobRow);
    if (
      job.state !== 'leased' ||
      job.lease_owner !== input.owner ||
      job.fencing_token !== input.fencing_token
    ) {
      throw new Error('delivery_job_stale_fence');
    }
    const card = await selectCard(query, input.card_id);
    if (!card) throw new Error('operator_card_not_found');

    let state: DeliveryJobState;
    let nextAttemptAt = job.next_attempt_at;
    if (input.outcome === 'succeeded') state = 'succeeded';
    else if (input.outcome === 'indeterminate') state = 'indeterminate';
    else if (input.outcome === 'permanent_failure' || job.attempts_started >= 3) {
      state = 'exhausted';
    } else {
      state = 'pending';
      const offset = job.attempts_started === 1 ? 30_000 : 120_000;
      nextAttemptAt = plusMilliseconds(card.created_at, offset);
    }

    const updated = await query(
      `UPDATE overseer_operator_card_delivery_jobs
       SET state = $1, next_attempt_at = $2, lease_owner = NULL, lease_expires_at = NULL,
           updated_at = $3
       WHERE card_id = $4 AND channel = $5 AND state = 'leased'
         AND lease_owner = $6 AND fencing_token = $7`,
      [state, nextAttemptAt, now, input.card_id, input.channel, input.owner, input.fencing_token]
    );
    if (updated.rowCount !== 1) throw new Error('delivery_job_stale_fence');
    const completed = (
      await query<DeliveryJobRow>(
        `SELECT * FROM overseer_operator_card_delivery_jobs
         WHERE card_id = $1 AND channel = $2`,
        [input.card_id, input.channel]
      )
    ).rows[0];
    if (!completed) throw new Error('delivery_job_not_found');
    return normalizeJob(completed);
  });
}
