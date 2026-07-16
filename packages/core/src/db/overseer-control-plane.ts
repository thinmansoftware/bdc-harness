/**
 * Overseer control-plane persistence (WO-HARNESS-OVERSEER-CONTROL-PLANE-01).
 *
 * Persistent, restart-safe shared-resource controls that M-42 requires before
 * actions run concurrently:
 *   - at most 10 active parent commitments (children reuse the parent slot);
 *   - one live mutating lease per repository with a fencing token;
 *   - a content-addressed, independence-checked verifier registry;
 *   - atomic Fusion budget reservations in integer microusd.
 *
 * Every mutation returns a discriminated result `{ ok: true, value }` or
 * `{ ok: false, code }`; contract denials do NOT throw. Unexpected database
 * failures still throw and roll back. No public input accepts a caller clock,
 * UTC bucket, lease duration, event identity, sequence, or digest.
 *
 * This module grants NO provider, paid-call, credential, or activation authority.
 * The frozen contract lives at docs/contracts/overseer-control-plane-v1.md.
 */
import { createHash, randomUUID } from 'crypto';
import { getDatabase } from './connection';
import type { IDatabase, QueryResult } from './adapters/types';
import {
  withOverseerControlPlaneImmediateTransaction,
  type ControlPlaneTxQuery,
} from './overseer-control-plane-sqlite';

export const OVERSEER_CONTROL_PLANE_SCHEMA_VERSION = 'overseer-control-plane-v1' as const;
export const OVERSEER_VERIFIER_REGISTRY_SCHEMA_VERSION = 'overseer-verifier-registry-v1' as const;
export const OVERSEER_CONTROL_EVENT_DOMAIN = 'overseer-control-event-v1' as const;
export const OVERSEER_VERIFIER_REGISTRY_DOMAIN = 'overseer-verifier-registry-v1' as const;

/** Fixed lease TTL in seconds; callers cannot choose the duration. */
export const OVERSEER_PARENT_LEASE_TTL_SECONDS = 300;
export const OVERSEER_REPOSITORY_LEASE_TTL_SECONDS = 300;

/** Fusion caps in integer microusd. */
export const FUSION_PER_CALL_CAP_MICROUSD = 3_000_000;
export const FUSION_PER_DAY_CAP_MICROUSD = 20_000_000;
export const FUSION_PER_MONTH_CAP_MICROUSD = 100_000_000;

export const MAX_ACTIVE_PARENTS = 10;

const PARENT_ACTIVE_STATES = [
  'BUILDING',
  'REVIEW',
  'STAGING',
  'RECOVERY',
  'ACTION_PENDING',
] as const;
const PARENT_TERMINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type OverseerParentActiveState = (typeof PARENT_ACTIVE_STATES)[number];
export type OverseerParentTerminalState = (typeof PARENT_TERMINAL_STATES)[number];
export type OverseerParentState = OverseerParentActiveState | OverseerParentTerminalState;

const CHILD_TERMINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type OverseerChildState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type FusionCallKind = 'PRIMARY' | 'RETRY' | 'FALLBACK' | 'INDIRECT';
export type FusionReservationStatus = 'RESERVED' | 'IN_FLIGHT' | 'RECONCILED' | 'RELEASED';
export type FusionReleaseReason =
  | 'call_cancelled_before_start'
  | 'authorization_revoked_before_start'
  | 'provider_unavailable_before_start';

export type VerifierRole = 'REVIEWER' | 'RED_TEAM' | 'FUSION' | 'MERGE_STEWARD';
const VERIFIER_ROLES: readonly VerifierRole[] = ['REVIEWER', 'RED_TEAM', 'FUSION', 'MERGE_STEWARD'];

export type OverseerControlResourceKind =
  | 'PARENT'
  | 'CHILD'
  | 'REPOSITORY_LEASE'
  | 'VERIFIER_REGISTRY'
  | 'FUSION_BUDGET';

export type OverseerControlEventKind =
  | 'ADMITTED'
  | 'HEARTBEAT'
  | 'STATE_CHANGED'
  | 'CHILD_LINKED'
  | 'CRASH_RECONCILED'
  | 'LEASE_ACQUIRED'
  | 'LEASE_TAKEN_OVER'
  | 'LEASE_RELEASED'
  | 'REGISTRY_FROZEN'
  | 'BUDGET_RESERVED'
  | 'BUDGET_CALL_STARTED'
  | 'BUDGET_RECONCILED'
  | 'BUDGET_OVERAGE_RECORDED'
  | 'BUDGET_RELEASED';

export type OverseerControlFailure =
  | 'parent_capacity_reached'
  | 'parent_identity_conflict'
  | 'parent_lease_stale'
  | 'parent_not_found'
  | 'parent_transition_invalid'
  | 'parent_children_active'
  | 'child_orphaned'
  | 'child_identity_conflict'
  | 'child_not_found'
  | 'child_transition_invalid'
  | 'lease_conflict'
  | 'lease_stale'
  | 'lease_not_found'
  | 'registry_invalid'
  | 'registry_digest_mismatch'
  | 'registry_digest_conflict'
  | 'verifier_registry_missing'
  | 'verifier_unknown'
  | 'verifier_disabled'
  | 'verifier_role_mismatch'
  | 'verifier_not_independent'
  | 'budget_cap_exceeded'
  | 'budget_reservation_stale'
  | 'budget_transition_invalid'
  | 'budget_reservation_not_found'
  | 'budget_overage_recorded';

export type ControlResult<T> =
  | { readonly ok: true; readonly value: T; readonly created?: boolean }
  | { readonly ok: false; readonly code: OverseerControlFailure };

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface OverseerParentCommitment {
  readonly parent_id: string;
  readonly state: OverseerParentState;
  readonly owner_id: string;
  readonly correlation_id: string;
  readonly fencing_token: number;
  readonly admitted_at: string;
  readonly heartbeat_at: string;
  readonly lease_expires_at: string;
  readonly released_at: string | null;
  readonly terminal_reason: string | null;
}

export interface OverseerParentChild {
  readonly parent_id: string;
  readonly child_id: string;
  readonly state: OverseerChildState;
  readonly created_at: string;
  readonly terminal_at: string | null;
}

export interface OverseerRepositoryLease {
  readonly repository: string;
  readonly lease_id: string;
  readonly owner_id: string;
  readonly execution_id: string;
  readonly action_kind: string;
  readonly capability: string;
  readonly fencing_token: number;
  readonly state: 'ACTIVE' | 'RELEASED' | 'EXPIRED';
  readonly acquired_at: string;
  readonly heartbeat_at: string;
  readonly expires_at: string;
  readonly released_at: string | null;
}

export interface OverseerVerifierEntry {
  readonly verifier_id: string;
  readonly provider: string;
  readonly model_family: string;
  readonly roles: readonly VerifierRole[];
  readonly enabled: boolean;
}

export interface OverseerVerifierRegistry {
  readonly registry_digest: string;
  readonly schema_version: typeof OVERSEER_VERIFIER_REGISTRY_SCHEMA_VERSION;
  readonly frozen_at: string;
  readonly created_at: string;
  readonly source_artifact_path: string;
  readonly source_git_blob: string;
  readonly entries: readonly OverseerVerifierEntry[];
}

export interface OverseerFusionReservation {
  readonly reservation_id: string;
  readonly call_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly provider: string;
  readonly model: string;
  readonly call_kind: FusionCallKind;
  readonly utc_day: string;
  readonly utc_month: string;
  readonly requested_microusd: number;
  readonly actual_microusd: number | null;
  readonly status: FusionReservationStatus;
  readonly reserved_at: string;
  readonly call_started_at: string | null;
  readonly reconciled_at: string | null;
  readonly released_at: string | null;
}

export interface OverseerControlEvent {
  readonly event_id: string;
  readonly resource_kind: OverseerControlResourceKind;
  readonly resource_key: string;
  readonly event_kind: OverseerControlEventKind;
  readonly actor: string;
  readonly event_sequence: number;
  readonly evidence: unknown;
  readonly previous_event_digest: string | null;
  readonly event_digest: string;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AdmitOverseerParentInput {
  readonly parent_id: string;
  readonly owner_id: string;
  readonly correlation_id: string;
  readonly state: OverseerParentActiveState;
  readonly actor: string;
}
export interface HeartbeatOverseerParentInput {
  readonly parent_id: string;
  readonly owner_id: string;
  readonly fencing_token: number;
  readonly actor: string;
}
export interface TransitionOverseerParentStateInput {
  readonly parent_id: string;
  readonly owner_id: string;
  readonly fencing_token: number;
  readonly state: OverseerParentActiveState;
  readonly actor: string;
}
export interface LinkOverseerChildInput {
  readonly parent_id: string;
  readonly child_id: string;
  readonly owner_id: string;
  readonly fencing_token: number;
  readonly actor: string;
}
export interface TransitionOverseerChildStateInput {
  readonly parent_id: string;
  readonly child_id: string;
  readonly owner_id: string;
  readonly fencing_token: number;
  readonly state: OverseerChildState;
  readonly actor: string;
}
export interface ReleaseOverseerParentInput {
  readonly parent_id: string;
  readonly owner_id: string;
  readonly fencing_token: number;
  readonly state: OverseerParentTerminalState;
  readonly terminal_reason: string;
  readonly actor: string;
}
export interface AcquireRepositoryMutationLeaseInput {
  readonly repository: string;
  readonly lease_id: string;
  readonly owner_id: string;
  readonly execution_id: string;
  readonly action_kind: string;
  readonly capability: string;
  readonly actor: string;
}
export interface HeartbeatRepositoryMutationLeaseInput {
  readonly repository: string;
  readonly lease_id: string;
  readonly owner_id: string;
  readonly execution_id: string;
  readonly fencing_token: number;
  readonly actor: string;
}
export type ReleaseRepositoryMutationLeaseInput = HeartbeatRepositoryMutationLeaseInput;

export interface RegisterVerifierRegistryInput {
  readonly schema_version: string;
  readonly registry_digest: string;
  readonly entries: readonly OverseerVerifierEntry[];
  readonly source_artifact_path: string;
  readonly source_git_blob: string;
  readonly actor: string;
}
export interface AssertIndependentVerifierInput {
  readonly operator_provider: string;
  readonly operator_model_family: string;
  readonly registry_digest: string;
  readonly verifier_id: string;
  readonly required_role: VerifierRole;
}
export interface ReserveFusionBudgetInput {
  readonly reservation_id: string;
  readonly call_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly provider: string;
  readonly model: string;
  readonly call_kind: FusionCallKind;
  readonly requested_microusd: number;
  readonly actor: string;
}
export interface MarkFusionBudgetCallStartedInput {
  readonly reservation_id: string;
  readonly call_id: string;
  readonly actor: string;
}
export interface ReconcileFusionBudgetInput {
  readonly reservation_id: string;
  readonly call_id: string;
  readonly actual_microusd: number;
  readonly actor: string;
}
export interface ReleaseFusionBudgetReservationInput {
  readonly reservation_id: string;
  readonly call_id: string;
  readonly release_reason: FusionReleaseReason;
  readonly actor: string;
}
export interface ListOverseerControlEventsFilter {
  readonly resource_kind?: OverseerControlResourceKind;
  readonly resource_key?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DIGEST_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[a-z0-9][a-z0-9._/-]*$/;

type Dialect = 'postgres' | 'sqlite';

function fail(code: OverseerControlFailure): {
  readonly ok: false;
  readonly code: OverseerControlFailure;
} {
  return { ok: false, code };
}
function ok<T>(
  value: T,
  created?: boolean
): { readonly ok: true; readonly value: T; readonly created?: boolean } {
  return created === undefined ? { ok: true, value } : { ok: true, value, created };
}
/** Fail fast when a row is unexpectedly absent immediately after a successful write. */
function must<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function canonicalToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}
/** RFC 8785-style canonical JSON (sorted keys; only strings/ints/bools/arrays used). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}
function toText(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}
function isoValid(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
function normalizeMs(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) throw new Error('overseer_control_plane_invalid_time');
  return new Date(parsed).toISOString();
}
function addSeconds(ts: string, seconds: number): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) throw new Error('overseer_control_plane_invalid_time');
  return new Date(parsed + seconds * 1000).toISOString();
}
function isExpired(now: string, expiresAt: string): boolean {
  return Date.parse(now) >= Date.parse(expiresAt);
}

async function txNow(query: ControlPlaneTxQuery, dialect: Dialect): Promise<string> {
  const sql =
    dialect === 'sqlite'
      ? "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now"
      : 'SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS now';
  const row = (await query<{ now: string }>(sql)).rows[0];
  if (!row?.now || !isoValid(row.now)) {
    throw new Error('overseer_control_plane_database_clock_unavailable');
  }
  return normalizeMs(row.now);
}

/**
 * Run `fn` inside a serialized control-plane transaction with the advisory lock
 * derived from `lockKey`. PostgreSQL uses SERIALIZABLE plus a transaction advisory
 * lock; SQLite uses the isolated BEGIN IMMEDIATE helper.
 */
async function runControlTx<T>(
  db: IDatabase,
  lockKey: string,
  fn: (query: ControlPlaneTxQuery, dialect: Dialect) => Promise<T>
): Promise<T> {
  if (db.dialect === 'postgres') {
    return db.withTransaction(async query => {
      await query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
      return fn(query as ControlPlaneTxQuery, 'postgres');
    });
  }
  return withOverseerControlPlaneImmediateTransaction(db, query => fn(query, 'sqlite'));
}

async function readTx<T>(
  db: IDatabase,
  fn: (query: ControlPlaneTxQuery, dialect: Dialect) => Promise<T>
): Promise<T> {
  const dialect = db.dialect;
  const query: ControlPlaneTxQuery = <U>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<U>> => db.query<U>(sql, params);
  return fn(query, dialect);
}

// ---------------------------------------------------------------------------
// Event chain
// ---------------------------------------------------------------------------

interface AppendEventInput {
  readonly resource_kind: OverseerControlResourceKind;
  readonly resource_key: string;
  readonly event_kind: OverseerControlEventKind;
  readonly actor: string;
  readonly evidence: Record<string, unknown>;
  readonly now: string;
}

async function appendControlEvent(
  query: ControlPlaneTxQuery,
  input: AppendEventInput
): Promise<OverseerControlEvent> {
  const tip = (
    await query<{ event_sequence: number | string; event_digest: string }>(
      'SELECT event_sequence, event_digest FROM overseer_control_events WHERE resource_kind=$1 AND resource_key=$2 ORDER BY event_sequence DESC LIMIT 1',
      [input.resource_kind, input.resource_key]
    )
  ).rows[0];
  const eventSequence = tip ? toNumber(tip.event_sequence) + 1 : 1;
  const previousDigest = tip ? tip.event_digest : null;
  const eventId = `ocp-event-${randomUUID()}`;
  const createdAt = normalizeMs(input.now);
  const evidenceCanonical = canonicalize(input.evidence);
  const payload = {
    event_id: eventId,
    resource_kind: input.resource_kind,
    resource_key: input.resource_key,
    event_kind: input.event_kind,
    actor: input.actor,
    event_sequence: eventSequence,
    evidence_json: evidenceCanonical,
    previous_event_digest: previousDigest,
    created_at: createdAt,
  };
  const eventDigest = sha256Hex(`${OVERSEER_CONTROL_EVENT_DOMAIN}\n${canonicalJson(payload)}`);
  await query(
    `INSERT INTO overseer_control_events
       (event_id, resource_kind, resource_key, event_kind, actor, event_sequence,
        evidence_json, previous_event_digest, event_digest, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      eventId,
      input.resource_kind,
      input.resource_key,
      input.event_kind,
      input.actor,
      eventSequence,
      JSON.stringify(evidenceCanonical),
      previousDigest,
      eventDigest,
      createdAt,
    ]
  );
  return {
    event_id: eventId,
    resource_kind: input.resource_kind,
    resource_key: input.resource_key,
    event_kind: input.event_kind,
    actor: input.actor,
    event_sequence: eventSequence,
    evidence: evidenceCanonical,
    previous_event_digest: previousDigest,
    event_digest: eventDigest,
    created_at: createdAt,
  };
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function parentFromRow(row: Record<string, unknown>): OverseerParentCommitment {
  return {
    parent_id: String(row.parent_id),
    state: String(row.state) as OverseerParentState,
    owner_id: String(row.owner_id),
    correlation_id: String(row.correlation_id),
    fencing_token: toNumber(row.fencing_token),
    admitted_at: normalizeMs(String(row.admitted_at)),
    heartbeat_at: normalizeMs(String(row.heartbeat_at)),
    lease_expires_at: normalizeMs(String(row.lease_expires_at)),
    released_at: row.released_at == null ? null : normalizeMs(toText(row.released_at)),
    terminal_reason: row.terminal_reason == null ? null : toText(row.terminal_reason),
  };
}
function childFromRow(row: Record<string, unknown>): OverseerParentChild {
  return {
    parent_id: String(row.parent_id),
    child_id: String(row.child_id),
    state: String(row.state) as OverseerChildState,
    created_at: normalizeMs(String(row.created_at)),
    terminal_at: row.terminal_at == null ? null : normalizeMs(toText(row.terminal_at)),
  };
}
function leaseFromRow(row: Record<string, unknown>): OverseerRepositoryLease {
  return {
    repository: String(row.repository),
    lease_id: String(row.lease_id),
    owner_id: String(row.owner_id),
    execution_id: String(row.execution_id),
    action_kind: String(row.action_kind),
    capability: String(row.capability),
    fencing_token: toNumber(row.fencing_token),
    state: String(row.state) as OverseerRepositoryLease['state'],
    acquired_at: normalizeMs(String(row.acquired_at)),
    heartbeat_at: normalizeMs(String(row.heartbeat_at)),
    expires_at: normalizeMs(String(row.expires_at)),
    released_at: row.released_at == null ? null : normalizeMs(toText(row.released_at)),
  };
}
function reservationFromRow(row: Record<string, unknown>): OverseerFusionReservation {
  return {
    reservation_id: String(row.reservation_id),
    call_id: String(row.call_id),
    proposal_id: String(row.proposal_id),
    execution_id: String(row.execution_id),
    provider: String(row.provider),
    model: String(row.model),
    call_kind: String(row.call_kind) as FusionCallKind,
    utc_day: String(row.utc_day),
    utc_month: String(row.utc_month),
    requested_microusd: toNumber(row.requested_microusd),
    actual_microusd: row.actual_microusd == null ? null : toNumber(row.actual_microusd),
    status: String(row.status) as FusionReservationStatus,
    reserved_at: normalizeMs(String(row.reserved_at)),
    call_started_at: row.call_started_at == null ? null : normalizeMs(toText(row.call_started_at)),
    reconciled_at: row.reconciled_at == null ? null : normalizeMs(toText(row.reconciled_at)),
    released_at: row.released_at == null ? null : normalizeMs(toText(row.released_at)),
  };
}
function eventFromRow(row: Record<string, unknown>): OverseerControlEvent {
  return {
    event_id: String(row.event_id),
    resource_kind: String(row.resource_kind) as OverseerControlResourceKind,
    resource_key: String(row.resource_key),
    event_kind: String(row.event_kind) as OverseerControlEventKind,
    actor: String(row.actor),
    event_sequence: toNumber(row.event_sequence),
    evidence: parseJson(row.evidence_json),
    previous_event_digest:
      row.previous_event_digest == null ? null : toText(row.previous_event_digest),
    event_digest: String(row.event_digest),
    created_at: normalizeMs(String(row.created_at)),
  };
}

async function selectParent(
  query: ControlPlaneTxQuery,
  parentId: string
): Promise<Record<string, unknown> | undefined> {
  return (
    await query<Record<string, unknown>>(
      'SELECT * FROM overseer_parent_commitments WHERE parent_id=$1',
      [parentId]
    )
  ).rows[0];
}

// ---------------------------------------------------------------------------
// Parent admission + lifecycle
// ---------------------------------------------------------------------------

const PARENT_ADMISSION_LOCK = 'overseer-control:parent-admission';
const FUSION_BUDGET_LOCK = 'overseer-control:fusion-budget';
function parentLock(parentId: string): string {
  return `overseer-control:parent:${parentId}`;
}
function repoLock(repository: string): string {
  return `overseer-control:repo:${repository}`;
}
function registryLock(digest: string): string {
  return `overseer-control:registry:${digest}`;
}

/** Internal crash-recovery transition; runs inside an already-open transaction. */
async function reconcileExpiredParentsTx(query: ControlPlaneTxQuery, now: string): Promise<void> {
  const activePlaceholders = PARENT_ACTIVE_STATES.map((_s, i) => `$${i + 1}`).join(',');
  const activeRows = (
    await query<Record<string, unknown>>(
      `SELECT * FROM overseer_parent_commitments WHERE state IN (${activePlaceholders})`,
      [...PARENT_ACTIVE_STATES]
    )
  ).rows;
  for (const raw of activeRows) {
    const parent = parentFromRow(raw);
    if (!isExpired(now, parent.lease_expires_at)) continue;
    const nextToken = parent.fencing_token + 1;
    await query(
      `UPDATE overseer_parent_commitments
         SET state='FAILED', terminal_reason='owner_lease_expired',
             released_at=$2, fencing_token=$3
       WHERE parent_id=$1`,
      [parent.parent_id, now, nextToken]
    );
    const failedChildren = (
      await query<Record<string, unknown>>(
        "SELECT child_id FROM overseer_parent_children WHERE parent_id=$1 AND state IN ('PENDING','RUNNING')",
        [parent.parent_id]
      )
    ).rows.map(r => String(r.child_id));
    await query(
      "UPDATE overseer_parent_children SET state='FAILED', terminal_at=$2 WHERE parent_id=$1 AND state IN ('PENDING','RUNNING')",
      [parent.parent_id, now]
    );
    await appendControlEvent(query, {
      resource_kind: 'PARENT',
      resource_key: parent.parent_id,
      event_kind: 'CRASH_RECONCILED',
      actor: 'system',
      evidence: {
        reason: 'owner_lease_expired',
        previous_fencing_token: parent.fencing_token,
        fencing_token: nextToken,
        failed_children: failedChildren,
      },
      now,
    });
  }
}

export async function reconcileExpiredParentCommitments(
  db: IDatabase = getDatabase()
): Promise<{ readonly reconciled: number }> {
  return runControlTx(db, PARENT_ADMISSION_LOCK, async (query, dialect) => {
    const now = await txNow(query, dialect);
    const before = (
      await query<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM overseer_control_events WHERE event_kind='CRASH_RECONCILED'"
      )
    ).rows[0];
    await reconcileExpiredParentsTx(query, now);
    const after = (
      await query<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM overseer_control_events WHERE event_kind='CRASH_RECONCILED'"
      )
    ).rows[0];
    return { reconciled: toNumber(after?.n ?? 0) - toNumber(before?.n ?? 0) };
  });
}

export async function admitOverseerParent(
  input: AdmitOverseerParentInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerParentCommitment>> {
  if (
    !nonEmpty(input.parent_id) ||
    !nonEmpty(input.owner_id) ||
    !nonEmpty(input.correlation_id) ||
    !nonEmpty(input.actor) ||
    !(PARENT_ACTIVE_STATES as readonly string[]).includes(input.state)
  ) {
    throw new Error('overseer_control_plane_admit_invalid_input');
  }
  return runControlTx(db, PARENT_ADMISSION_LOCK, async (query, dialect) => {
    const now = await txNow(query, dialect);
    await reconcileExpiredParentsTx(query, now);

    const existing = await selectParent(query, input.parent_id);
    if (existing) {
      const parent = parentFromRow(existing);
      if (parent.owner_id === input.owner_id && parent.correlation_id === input.correlation_id) {
        return ok(parent);
      }
      return fail('parent_identity_conflict');
    }
    const byCorrelation = (
      await query<Record<string, unknown>>(
        'SELECT parent_id FROM overseer_parent_commitments WHERE correlation_id=$1',
        [input.correlation_id]
      )
    ).rows[0];
    if (byCorrelation) return fail('parent_identity_conflict');

    const activePlaceholders = PARENT_ACTIVE_STATES.map((_s, i) => `$${i + 1}`).join(',');
    const activeCount = toNumber(
      (
        await query<{ n: number | string }>(
          `SELECT COUNT(*) AS n FROM overseer_parent_commitments WHERE state IN (${activePlaceholders})`,
          [...PARENT_ACTIVE_STATES]
        )
      ).rows[0]?.n ?? 0
    );
    if (activeCount >= MAX_ACTIVE_PARENTS) return fail('parent_capacity_reached');

    const leaseExpires = addSeconds(now, OVERSEER_PARENT_LEASE_TTL_SECONDS);
    await query(
      `INSERT INTO overseer_parent_commitments
         (parent_id, state, owner_id, correlation_id, fencing_token,
          admitted_at, heartbeat_at, lease_expires_at, released_at, terminal_reason)
       VALUES ($1,$2,$3,$4,1,$5,$5,$6,NULL,NULL)`,
      [input.parent_id, input.state, input.owner_id, input.correlation_id, now, leaseExpires]
    );
    await appendControlEvent(query, {
      resource_kind: 'PARENT',
      resource_key: input.parent_id,
      event_kind: 'ADMITTED',
      actor: input.actor,
      evidence: {
        owner_id: input.owner_id,
        correlation_id: input.correlation_id,
        state: input.state,
      },
      now,
    });
    const row = await selectParent(query, input.parent_id);
    return ok(parentFromRow(must(row, 'overseer_control_plane_parent_missing_after_write')), true);
  });
}

/** Fetch the active parent row and verify owner/token/liveness for a mutating op. */
function verifyLiveOwner(
  parent: OverseerParentCommitment,
  ownerId: string,
  token: number,
  now: string
): boolean {
  if ((PARENT_TERMINAL_STATES as readonly string[]).includes(parent.state)) return false;
  if (parent.owner_id !== ownerId || parent.fencing_token !== token) return false;
  if (isExpired(now, parent.lease_expires_at)) return false;
  return true;
}

export async function heartbeatOverseerParent(
  input: HeartbeatOverseerParentInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerParentCommitment>> {
  if (!nonEmpty(input.parent_id) || !nonEmpty(input.owner_id) || !nonEmpty(input.actor)) {
    throw new Error('overseer_control_plane_heartbeat_invalid_input');
  }
  return runControlTx(db, parentLock(input.parent_id), async (query, dialect) => {
    const now = await txNow(query, dialect);
    const raw = await selectParent(query, input.parent_id);
    if (!raw) return fail('parent_not_found');
    const parent = parentFromRow(raw);
    if (!verifyLiveOwner(parent, input.owner_id, input.fencing_token, now)) {
      return fail('parent_lease_stale');
    }
    const leaseExpires = addSeconds(now, OVERSEER_PARENT_LEASE_TTL_SECONDS);
    await query(
      'UPDATE overseer_parent_commitments SET heartbeat_at=$2, lease_expires_at=$3 WHERE parent_id=$1',
      [input.parent_id, now, leaseExpires]
    );
    await appendControlEvent(query, {
      resource_kind: 'PARENT',
      resource_key: input.parent_id,
      event_kind: 'HEARTBEAT',
      actor: input.actor,
      evidence: { fencing_token: input.fencing_token, lease_expires_at: leaseExpires },
      now,
    });
    return ok(
      parentFromRow(
        must(
          await selectParent(query, input.parent_id),
          'overseer_control_plane_parent_missing_after_write'
        )
      )
    );
  });
}

export async function transitionOverseerParentState(
  input: TransitionOverseerParentStateInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerParentCommitment>> {
  if (!nonEmpty(input.parent_id) || !nonEmpty(input.owner_id) || !nonEmpty(input.actor)) {
    throw new Error('overseer_control_plane_transition_invalid_input');
  }
  if (!(PARENT_ACTIVE_STATES as readonly string[]).includes(input.state)) {
    return fail('parent_transition_invalid');
  }
  return runControlTx(db, parentLock(input.parent_id), async (query, dialect) => {
    const now = await txNow(query, dialect);
    const raw = await selectParent(query, input.parent_id);
    if (!raw) return fail('parent_not_found');
    const parent = parentFromRow(raw);
    if ((PARENT_TERMINAL_STATES as readonly string[]).includes(parent.state)) {
      return fail('parent_transition_invalid');
    }
    if (!verifyLiveOwner(parent, input.owner_id, input.fencing_token, now)) {
      return fail('parent_lease_stale');
    }
    await query('UPDATE overseer_parent_commitments SET state=$2 WHERE parent_id=$1', [
      input.parent_id,
      input.state,
    ]);
    await appendControlEvent(query, {
      resource_kind: 'PARENT',
      resource_key: input.parent_id,
      event_kind: 'STATE_CHANGED',
      actor: input.actor,
      evidence: { from_state: parent.state, to_state: input.state },
      now,
    });
    return ok(
      parentFromRow(
        must(
          await selectParent(query, input.parent_id),
          'overseer_control_plane_parent_missing_after_write'
        )
      )
    );
  });
}

export async function linkOverseerChild(
  input: LinkOverseerChildInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerParentChild>> {
  if (
    !nonEmpty(input.parent_id) ||
    !nonEmpty(input.child_id) ||
    !nonEmpty(input.owner_id) ||
    !nonEmpty(input.actor)
  ) {
    throw new Error('overseer_control_plane_link_child_invalid_input');
  }
  return runControlTx(db, parentLock(input.parent_id), async (query, dialect) => {
    const now = await txNow(query, dialect);
    const raw = await selectParent(query, input.parent_id);
    if (!raw) return fail('child_orphaned');
    const parent = parentFromRow(raw);

    const existingChild = (
      await query<Record<string, unknown>>(
        'SELECT * FROM overseer_parent_children WHERE child_id=$1',
        [input.child_id]
      )
    ).rows[0];
    if (existingChild) {
      const child = childFromRow(existingChild);
      if (child.parent_id === input.parent_id) return ok(child);
      return fail('child_identity_conflict');
    }
    if (!verifyLiveOwner(parent, input.owner_id, input.fencing_token, now)) {
      return fail('parent_lease_stale');
    }
    await query(
      `INSERT INTO overseer_parent_children (parent_id, child_id, state, created_at, terminal_at)
       VALUES ($1,$2,'PENDING',$3,NULL)`,
      [input.parent_id, input.child_id, now]
    );
    await appendControlEvent(query, {
      resource_kind: 'CHILD',
      resource_key: input.child_id,
      event_kind: 'CHILD_LINKED',
      actor: input.actor,
      evidence: { parent_id: input.parent_id, state: 'PENDING' },
      now,
    });
    const child = (
      await query<Record<string, unknown>>(
        'SELECT * FROM overseer_parent_children WHERE parent_id=$1 AND child_id=$2',
        [input.parent_id, input.child_id]
      )
    ).rows[0];
    return ok(childFromRow(must(child, 'overseer_control_plane_child_missing_after_write')));
  });
}

function childEdgeValid(from: OverseerChildState, to: OverseerChildState): boolean {
  if ((CHILD_TERMINAL_STATES as readonly string[]).includes(from)) return false;
  if (from === 'PENDING')
    return to === 'RUNNING' || (CHILD_TERMINAL_STATES as readonly string[]).includes(to);
  if (from === 'RUNNING') return (CHILD_TERMINAL_STATES as readonly string[]).includes(to);
  return false;
}

export async function transitionOverseerChildState(
  input: TransitionOverseerChildStateInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerParentChild>> {
  if (
    !nonEmpty(input.parent_id) ||
    !nonEmpty(input.child_id) ||
    !nonEmpty(input.owner_id) ||
    !nonEmpty(input.actor)
  ) {
    throw new Error('overseer_control_plane_child_transition_invalid_input');
  }
  return runControlTx(db, parentLock(input.parent_id), async (query, dialect) => {
    const now = await txNow(query, dialect);
    const childRaw = (
      await query<Record<string, unknown>>(
        'SELECT * FROM overseer_parent_children WHERE parent_id=$1 AND child_id=$2',
        [input.parent_id, input.child_id]
      )
    ).rows[0];
    if (!childRaw) return fail('child_not_found');
    const parentRaw = await selectParent(query, input.parent_id);
    if (!parentRaw) return fail('child_not_found');
    const parent = parentFromRow(parentRaw);
    if (!verifyLiveOwner(parent, input.owner_id, input.fencing_token, now)) {
      return fail('parent_lease_stale');
    }
    const child = childFromRow(childRaw);
    if (!childEdgeValid(child.state, input.state)) return fail('child_transition_invalid');
    const terminal = (CHILD_TERMINAL_STATES as readonly string[]).includes(input.state);
    await query(
      'UPDATE overseer_parent_children SET state=$3, terminal_at=$4 WHERE parent_id=$1 AND child_id=$2',
      [input.parent_id, input.child_id, input.state, terminal ? now : null]
    );
    await appendControlEvent(query, {
      resource_kind: 'CHILD',
      resource_key: input.child_id,
      event_kind: 'STATE_CHANGED',
      actor: input.actor,
      evidence: { parent_id: input.parent_id, from_state: child.state, to_state: input.state },
      now,
    });
    const updated = (
      await query<Record<string, unknown>>(
        'SELECT * FROM overseer_parent_children WHERE parent_id=$1 AND child_id=$2',
        [input.parent_id, input.child_id]
      )
    ).rows[0];
    return ok(childFromRow(must(updated, 'overseer_control_plane_child_missing_after_write')));
  });
}

export async function releaseOverseerParent(
  input: ReleaseOverseerParentInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerParentCommitment>> {
  if (
    !nonEmpty(input.parent_id) ||
    !nonEmpty(input.owner_id) ||
    !nonEmpty(input.terminal_reason) ||
    !nonEmpty(input.actor) ||
    !(PARENT_TERMINAL_STATES as readonly string[]).includes(input.state)
  ) {
    throw new Error('overseer_control_plane_release_invalid_input');
  }
  return runControlTx(db, parentLock(input.parent_id), async (query, dialect) => {
    const now = await txNow(query, dialect);
    const raw = await selectParent(query, input.parent_id);
    if (!raw) return fail('parent_not_found');
    const parent = parentFromRow(raw);

    if ((PARENT_TERMINAL_STATES as readonly string[]).includes(parent.state)) {
      if (parent.state === input.state && parent.terminal_reason === input.terminal_reason) {
        return ok(parent);
      }
      return fail('parent_transition_invalid');
    }
    if (!verifyLiveOwner(parent, input.owner_id, input.fencing_token, now)) {
      return fail('parent_lease_stale');
    }
    const activeChildren = (
      await query<Record<string, unknown>>(
        "SELECT child_id FROM overseer_parent_children WHERE parent_id=$1 AND state IN ('PENDING','RUNNING')",
        [input.parent_id]
      )
    ).rows.map(r => String(r.child_id));
    if (input.state === 'COMPLETED' && activeChildren.length > 0) {
      return fail('parent_children_active');
    }

    if (input.state !== 'COMPLETED' && activeChildren.length > 0) {
      await query(
        "UPDATE overseer_parent_children SET state=$2, terminal_at=$3 WHERE parent_id=$1 AND state IN ('PENDING','RUNNING')",
        [input.parent_id, input.state, now]
      );
      for (const childId of activeChildren) {
        await appendControlEvent(query, {
          resource_kind: 'CHILD',
          resource_key: childId,
          event_kind: 'STATE_CHANGED',
          actor: input.actor,
          evidence: { parent_id: input.parent_id, to_state: input.state, cause: 'parent_release' },
          now,
        });
      }
    }
    const nextToken = parent.fencing_token + 1;
    await query(
      `UPDATE overseer_parent_commitments
         SET state=$2, terminal_reason=$3, released_at=$4, fencing_token=$5
       WHERE parent_id=$1`,
      [input.parent_id, input.state, input.terminal_reason, now, nextToken]
    );
    await appendControlEvent(query, {
      resource_kind: 'PARENT',
      resource_key: input.parent_id,
      event_kind: 'STATE_CHANGED',
      actor: input.actor,
      evidence: {
        from_state: parent.state,
        to_state: input.state,
        terminal_reason: input.terminal_reason,
        fencing_token: nextToken,
      },
      now,
    });
    return ok(
      parentFromRow(
        must(
          await selectParent(query, input.parent_id),
          'overseer_control_plane_parent_missing_after_write'
        )
      )
    );
  });
}

// ---------------------------------------------------------------------------
// Repository mutation leases
// ---------------------------------------------------------------------------

async function selectLease(
  query: ControlPlaneTxQuery,
  repository: string
): Promise<Record<string, unknown> | undefined> {
  return (
    await query<Record<string, unknown>>(
      'SELECT * FROM overseer_repository_mutation_leases WHERE repository=$1',
      [repository]
    )
  ).rows[0];
}

export async function acquireRepositoryMutationLease(
  input: AcquireRepositoryMutationLeaseInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerRepositoryLease>> {
  if (
    !nonEmpty(input.repository) ||
    !nonEmpty(input.lease_id) ||
    !nonEmpty(input.owner_id) ||
    !nonEmpty(input.execution_id) ||
    !nonEmpty(input.action_kind) ||
    !nonEmpty(input.capability) ||
    !nonEmpty(input.actor)
  ) {
    throw new Error('overseer_control_plane_lease_acquire_invalid_input');
  }
  return runControlTx(db, repoLock(input.repository), async (query, dialect) => {
    const now = await txNow(query, dialect);
    const expires = addSeconds(now, OVERSEER_REPOSITORY_LEASE_TTL_SECONDS);
    const raw = await selectLease(query, input.repository);
    if (!raw) {
      await query(
        `INSERT INTO overseer_repository_mutation_leases
           (repository, lease_id, owner_id, execution_id, action_kind, capability,
            fencing_token, state, acquired_at, heartbeat_at, expires_at, released_at)
         VALUES ($1,$2,$3,$4,$5,$6,1,'ACTIVE',$7,$7,$8,NULL)`,
        [
          input.repository,
          input.lease_id,
          input.owner_id,
          input.execution_id,
          input.action_kind,
          input.capability,
          now,
          expires,
        ]
      );
      await appendControlEvent(query, {
        resource_kind: 'REPOSITORY_LEASE',
        resource_key: input.repository,
        event_kind: 'LEASE_ACQUIRED',
        actor: input.actor,
        evidence: { lease_id: input.lease_id, owner_id: input.owner_id, fencing_token: 1 },
        now,
      });
      return ok(
        leaseFromRow(
          must(
            await selectLease(query, input.repository),
            'overseer_control_plane_lease_missing_after_write'
          )
        ),
        true
      );
    }
    const lease = leaseFromRow(raw);
    const live = lease.state === 'ACTIVE' && !isExpired(now, lease.expires_at);
    if (live) {
      if (
        lease.lease_id === input.lease_id &&
        lease.owner_id === input.owner_id &&
        lease.execution_id === input.execution_id
      ) {
        return ok(lease); // idempotent re-acquire by the live owner
      }
      return fail('lease_conflict');
    }
    // Takeover: the prior lease is released or expired. Increment the fence.
    const nextToken = lease.fencing_token + 1;
    await query(
      `UPDATE overseer_repository_mutation_leases
         SET lease_id=$2, owner_id=$3, execution_id=$4, action_kind=$5, capability=$6,
             fencing_token=$7, state='ACTIVE', acquired_at=$8, heartbeat_at=$8,
             expires_at=$9, released_at=NULL
       WHERE repository=$1`,
      [
        input.repository,
        input.lease_id,
        input.owner_id,
        input.execution_id,
        input.action_kind,
        input.capability,
        nextToken,
        now,
        expires,
      ]
    );
    await appendControlEvent(query, {
      resource_kind: 'REPOSITORY_LEASE',
      resource_key: input.repository,
      event_kind: 'LEASE_TAKEN_OVER',
      actor: input.actor,
      evidence: {
        lease_id: input.lease_id,
        owner_id: input.owner_id,
        previous_fencing_token: lease.fencing_token,
        fencing_token: nextToken,
      },
      now,
    });
    return ok(
      leaseFromRow(
        must(
          await selectLease(query, input.repository),
          'overseer_control_plane_lease_missing_after_write'
        )
      )
    );
  });
}

export async function heartbeatRepositoryMutationLease(
  input: HeartbeatRepositoryMutationLeaseInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerRepositoryLease>> {
  if (
    !nonEmpty(input.repository) ||
    !nonEmpty(input.lease_id) ||
    !nonEmpty(input.owner_id) ||
    !nonEmpty(input.execution_id) ||
    !nonEmpty(input.actor)
  ) {
    throw new Error('overseer_control_plane_lease_heartbeat_invalid_input');
  }
  return runControlTx(db, repoLock(input.repository), async (query, dialect) => {
    const now = await txNow(query, dialect);
    const raw = await selectLease(query, input.repository);
    if (!raw) return fail('lease_not_found');
    const lease = leaseFromRow(raw);
    if (
      lease.state !== 'ACTIVE' ||
      lease.lease_id !== input.lease_id ||
      lease.owner_id !== input.owner_id ||
      lease.execution_id !== input.execution_id ||
      lease.fencing_token !== input.fencing_token ||
      isExpired(now, lease.expires_at)
    ) {
      return fail('lease_stale');
    }
    const expires = addSeconds(now, OVERSEER_REPOSITORY_LEASE_TTL_SECONDS);
    await query(
      'UPDATE overseer_repository_mutation_leases SET heartbeat_at=$2, expires_at=$3 WHERE repository=$1',
      [input.repository, now, expires]
    );
    return ok(
      leaseFromRow(
        must(
          await selectLease(query, input.repository),
          'overseer_control_plane_lease_missing_after_write'
        )
      )
    );
  });
}

export async function releaseRepositoryMutationLease(
  input: ReleaseRepositoryMutationLeaseInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerRepositoryLease>> {
  if (
    !nonEmpty(input.repository) ||
    !nonEmpty(input.lease_id) ||
    !nonEmpty(input.owner_id) ||
    !nonEmpty(input.execution_id) ||
    !nonEmpty(input.actor)
  ) {
    throw new Error('overseer_control_plane_lease_release_invalid_input');
  }
  return runControlTx(db, repoLock(input.repository), async (query, dialect) => {
    const now = await txNow(query, dialect);
    const raw = await selectLease(query, input.repository);
    if (!raw) return fail('lease_not_found');
    const lease = leaseFromRow(raw);
    const identityMatches =
      lease.lease_id === input.lease_id &&
      lease.owner_id === input.owner_id &&
      lease.execution_id === input.execution_id &&
      lease.fencing_token === input.fencing_token;
    if (lease.state === 'RELEASED') {
      if (identityMatches) return ok(lease); // idempotent release replay
      return fail('lease_stale');
    }
    if (lease.state !== 'ACTIVE' || !identityMatches || isExpired(now, lease.expires_at)) {
      return fail('lease_stale');
    }
    await query(
      "UPDATE overseer_repository_mutation_leases SET state='RELEASED', released_at=$2 WHERE repository=$1",
      [input.repository, now]
    );
    await appendControlEvent(query, {
      resource_kind: 'REPOSITORY_LEASE',
      resource_key: input.repository,
      event_kind: 'LEASE_RELEASED',
      actor: input.actor,
      evidence: { lease_id: input.lease_id, fencing_token: input.fencing_token },
      now,
    });
    return ok(
      leaseFromRow(
        must(
          await selectLease(query, input.repository),
          'overseer_control_plane_lease_missing_after_write'
        )
      )
    );
  });
}

// ---------------------------------------------------------------------------
// Verifier registry
// ---------------------------------------------------------------------------

function normalizeEntry(entry: OverseerVerifierEntry): OverseerVerifierEntry | null {
  if (
    !canonicalToken(entry.verifier_id) ||
    !canonicalToken(entry.provider) ||
    !canonicalToken(entry.model_family) ||
    typeof entry.enabled !== 'boolean' ||
    !Array.isArray(entry.roles) ||
    entry.roles.length === 0
  ) {
    return null;
  }
  const uniqueRoles = [...new Set(entry.roles)];
  if (uniqueRoles.length !== entry.roles.length) return null;
  for (const role of uniqueRoles) {
    if (!VERIFIER_ROLES.includes(role)) return null;
  }
  const sortedRoles = [...uniqueRoles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    verifier_id: entry.verifier_id,
    provider: entry.provider,
    model_family: entry.model_family,
    roles: sortedRoles,
    enabled: entry.enabled,
  };
}

const sortStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Content bytes: RFC 8785 canonical JSON of the exact frozen registry object.
 * Entries sort by verifier_id and roles sort within each entry, so the digest is
 * independent of caller ordering. */
function registryCanonicalBytes(entries: readonly OverseerVerifierEntry[]): string {
  const sortedEntries = [...entries]
    .map(e => ({
      enabled: e.enabled,
      model_family: e.model_family,
      provider: e.provider,
      roles: [...e.roles].sort(sortStr),
      verifier_id: e.verifier_id,
    }))
    .sort((a, b) => sortStr(a.verifier_id, b.verifier_id));
  return canonicalJson({
    schema_version: OVERSEER_VERIFIER_REGISTRY_SCHEMA_VERSION,
    entries: sortedEntries,
  });
}

export function computeVerifierRegistryDigest(entries: readonly OverseerVerifierEntry[]): string {
  return sha256Hex(`${OVERSEER_VERIFIER_REGISTRY_DOMAIN}\n${registryCanonicalBytes(entries)}`);
}

export async function registerVerifierRegistry(
  input: RegisterVerifierRegistryInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerVerifierRegistry>> {
  if (
    !nonEmpty(input.actor) ||
    !nonEmpty(input.source_artifact_path) ||
    !nonEmpty(input.source_git_blob) ||
    input.schema_version !== OVERSEER_VERIFIER_REGISTRY_SCHEMA_VERSION ||
    !Array.isArray(input.entries) ||
    input.entries.length === 0 ||
    !DIGEST_RE.test(input.registry_digest)
  ) {
    return fail('registry_invalid');
  }
  const normalized: OverseerVerifierEntry[] = [];
  const seen = new Set<string>();
  for (const entry of input.entries) {
    const clean = normalizeEntry(entry);
    if (!clean) return fail('registry_invalid');
    if (seen.has(clean.verifier_id)) return fail('registry_invalid');
    seen.add(clean.verifier_id);
    normalized.push(clean);
  }
  normalized.sort((a, b) =>
    a.verifier_id < b.verifier_id ? -1 : a.verifier_id > b.verifier_id ? 1 : 0
  );

  const computedDigest = computeVerifierRegistryDigest(normalized);
  if (computedDigest !== input.registry_digest) return fail('registry_digest_mismatch');

  return runControlTx(db, registryLock(computedDigest), async (query, dialect) => {
    const now = await txNow(query, dialect);
    const existing = (
      await query<Record<string, unknown>>(
        'SELECT * FROM overseer_verifier_registries WHERE registry_digest=$1',
        [computedDigest]
      )
    ).rows[0];
    if (existing) {
      const stored = await loadRegistry(query, computedDigest);
      if (
        stored?.source_artifact_path === input.source_artifact_path &&
        stored.source_git_blob === input.source_git_blob &&
        registryCanonicalBytes(stored.entries) === registryCanonicalBytes(normalized)
      ) {
        return ok(stored); // exact idempotent re-registration
      }
      return fail('registry_digest_conflict');
    }
    await query(
      `INSERT INTO overseer_verifier_registries
         (registry_digest, schema_version, frozen_at, created_at, source_artifact_path, source_git_blob)
       VALUES ($1,$2,$3,$3,$4,$5)`,
      [
        computedDigest,
        OVERSEER_VERIFIER_REGISTRY_SCHEMA_VERSION,
        now,
        input.source_artifact_path,
        input.source_git_blob,
      ]
    );
    for (const entry of normalized) {
      await query(
        `INSERT INTO overseer_verifier_entries
           (registry_digest, verifier_id, provider, model_family, roles_json, enabled)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          computedDigest,
          entry.verifier_id,
          entry.provider,
          entry.model_family,
          JSON.stringify(entry.roles),
          entry.enabled,
        ]
      );
    }
    await appendControlEvent(query, {
      resource_kind: 'VERIFIER_REGISTRY',
      resource_key: computedDigest,
      event_kind: 'REGISTRY_FROZEN',
      actor: input.actor,
      evidence: { entry_count: normalized.length, source_git_blob: input.source_git_blob },
      now,
    });
    const registry = await loadRegistry(query, computedDigest);
    return ok(must(registry, 'overseer_control_plane_registry_missing_after_write'), true);
  });
}

async function loadRegistry(
  query: ControlPlaneTxQuery,
  digest: string
): Promise<OverseerVerifierRegistry | null> {
  const header = (
    await query<Record<string, unknown>>(
      'SELECT * FROM overseer_verifier_registries WHERE registry_digest=$1',
      [digest]
    )
  ).rows[0];
  if (!header) return null;
  const entries = (
    await query<Record<string, unknown>>(
      'SELECT * FROM overseer_verifier_entries WHERE registry_digest=$1 ORDER BY verifier_id',
      [digest]
    )
  ).rows.map(row => ({
    verifier_id: String(row.verifier_id),
    provider: String(row.provider),
    model_family: String(row.model_family),
    roles: parseJson(row.roles_json) as VerifierRole[],
    enabled: row.enabled === true || row.enabled === 1 || row.enabled === '1',
  }));
  return {
    registry_digest: String(header.registry_digest),
    schema_version: OVERSEER_VERIFIER_REGISTRY_SCHEMA_VERSION,
    frozen_at: normalizeMs(String(header.frozen_at)),
    created_at: normalizeMs(String(header.created_at)),
    source_artifact_path: String(header.source_artifact_path),
    source_git_blob: String(header.source_git_blob),
    entries,
  };
}

export interface IndependentVerifierDecision {
  readonly allowed: true;
  readonly verifier_id: string;
  readonly provider: string;
  readonly model_family: string;
  readonly role: VerifierRole;
}

export async function assertIndependentVerifier(
  input: AssertIndependentVerifierInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<IndependentVerifierDecision>> {
  if (
    !canonicalToken(input.operator_provider) ||
    !canonicalToken(input.operator_model_family) ||
    !DIGEST_RE.test(input.registry_digest) ||
    !canonicalToken(input.verifier_id) ||
    !VERIFIER_ROLES.includes(input.required_role)
  ) {
    return fail('verifier_registry_missing');
  }
  return readTx(db, async query => {
    const registry = await loadRegistry(query, input.registry_digest);
    if (!registry) return fail('verifier_registry_missing');
    const entry = registry.entries.find(e => e.verifier_id === input.verifier_id);
    if (!entry) return fail('verifier_unknown');
    if (!entry.enabled) return fail('verifier_disabled');
    if (!entry.roles.includes(input.required_role)) return fail('verifier_role_mismatch');
    if (
      entry.provider === input.operator_provider ||
      entry.model_family === input.operator_model_family
    ) {
      return fail('verifier_not_independent');
    }
    return ok({
      allowed: true as const,
      verifier_id: entry.verifier_id,
      provider: entry.provider,
      model_family: entry.model_family,
      role: input.required_role,
    });
  });
}

// ---------------------------------------------------------------------------
// Fusion budget
// ---------------------------------------------------------------------------

function chargeOf(row: OverseerFusionReservation): number {
  if (row.status === 'RESERVED' || row.status === 'IN_FLIGHT') return row.requested_microusd;
  if (row.status === 'RECONCILED') return row.actual_microusd ?? 0;
  return 0; // RELEASED
}

async function bucketCharge(
  query: ControlPlaneTxQuery,
  column: 'utc_day' | 'utc_month',
  bucket: string,
  excludeReservationId?: string
): Promise<number> {
  const rows = (
    await query<Record<string, unknown>>(
      `SELECT * FROM overseer_fusion_budget_reservations WHERE ${column}=$1`,
      [bucket]
    )
  ).rows.map(reservationFromRow);
  let total = 0;
  for (const row of rows) {
    if (excludeReservationId && row.reservation_id === excludeReservationId) continue;
    total += chargeOf(row);
  }
  return total;
}

async function selectReservation(
  query: ControlPlaneTxQuery,
  reservationId: string
): Promise<Record<string, unknown> | undefined> {
  return (
    await query<Record<string, unknown>>(
      'SELECT * FROM overseer_fusion_budget_reservations WHERE reservation_id=$1',
      [reservationId]
    )
  ).rows[0];
}

export async function reserveFusionBudget(
  input: ReserveFusionBudgetInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerFusionReservation>> {
  if (
    !nonEmpty(input.reservation_id) ||
    !nonEmpty(input.call_id) ||
    !nonEmpty(input.proposal_id) ||
    !nonEmpty(input.execution_id) ||
    !nonEmpty(input.provider) ||
    !nonEmpty(input.model) ||
    !nonEmpty(input.actor) ||
    !(['PRIMARY', 'RETRY', 'FALLBACK', 'INDIRECT'] as readonly string[]).includes(
      input.call_kind
    ) ||
    !Number.isInteger(input.requested_microusd) ||
    input.requested_microusd < 1
  ) {
    throw new Error('overseer_control_plane_reserve_invalid_input');
  }
  return runControlTx(db, FUSION_BUDGET_LOCK, async (query, dialect) => {
    const now = await txNow(query, dialect);
    const utcDay = now.slice(0, 10);
    const utcMonth = now.slice(0, 7);

    const existing = await selectReservation(query, input.reservation_id);
    if (existing) {
      const reservation = reservationFromRow(existing);
      if (
        reservation.call_id === input.call_id &&
        reservation.provider === input.provider &&
        reservation.model === input.model &&
        reservation.call_kind === input.call_kind &&
        reservation.requested_microusd === input.requested_microusd
      ) {
        return ok(reservation); // idempotent replay
      }
      return fail('budget_transition_invalid');
    }
    const callConflict = (
      await query<Record<string, unknown>>(
        'SELECT reservation_id FROM overseer_fusion_budget_reservations WHERE call_id=$1',
        [input.call_id]
      )
    ).rows[0];
    if (callConflict) return fail('budget_transition_invalid');

    if (input.requested_microusd > FUSION_PER_CALL_CAP_MICROUSD) return fail('budget_cap_exceeded');
    const dayCharge = await bucketCharge(query, 'utc_day', utcDay);
    if (dayCharge + input.requested_microusd > FUSION_PER_DAY_CAP_MICROUSD) {
      return fail('budget_cap_exceeded');
    }
    const monthCharge = await bucketCharge(query, 'utc_month', utcMonth);
    if (monthCharge + input.requested_microusd > FUSION_PER_MONTH_CAP_MICROUSD) {
      return fail('budget_cap_exceeded');
    }

    await query(
      `INSERT INTO overseer_fusion_budget_reservations
         (reservation_id, call_id, proposal_id, execution_id, provider, model, call_kind,
          utc_day, utc_month, requested_microusd, actual_microusd, status,
          reserved_at, call_started_at, reconciled_at, released_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,'RESERVED',$11,NULL,NULL,NULL)`,
      [
        input.reservation_id,
        input.call_id,
        input.proposal_id,
        input.execution_id,
        input.provider,
        input.model,
        input.call_kind,
        utcDay,
        utcMonth,
        input.requested_microusd,
        now,
      ]
    );
    await appendControlEvent(query, {
      resource_kind: 'FUSION_BUDGET',
      resource_key: input.reservation_id,
      event_kind: 'BUDGET_RESERVED',
      actor: input.actor,
      evidence: {
        call_id: input.call_id,
        call_kind: input.call_kind,
        requested_microusd: input.requested_microusd,
        utc_day: utcDay,
        utc_month: utcMonth,
      },
      now,
    });
    return ok(
      reservationFromRow(
        must(
          await selectReservation(query, input.reservation_id),
          'overseer_control_plane_reservation_missing_after_write'
        )
      ),
      true
    );
  });
}

export async function markFusionBudgetCallStarted(
  input: MarkFusionBudgetCallStartedInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerFusionReservation>> {
  if (!nonEmpty(input.reservation_id) || !nonEmpty(input.call_id) || !nonEmpty(input.actor)) {
    throw new Error('overseer_control_plane_mark_started_invalid_input');
  }
  return runControlTx(db, FUSION_BUDGET_LOCK, async (query, dialect) => {
    const now = await txNow(query, dialect);
    const raw = await selectReservation(query, input.reservation_id);
    if (!raw) return fail('budget_reservation_not_found');
    const reservation = reservationFromRow(raw);
    if (reservation.call_id !== input.call_id) return fail('budget_reservation_stale');
    if (reservation.status === 'IN_FLIGHT') return ok(reservation); // idempotent replay
    if (reservation.status !== 'RESERVED') return fail('budget_transition_invalid');
    await query(
      "UPDATE overseer_fusion_budget_reservations SET status='IN_FLIGHT', call_started_at=$2 WHERE reservation_id=$1",
      [input.reservation_id, now]
    );
    await appendControlEvent(query, {
      resource_kind: 'FUSION_BUDGET',
      resource_key: input.reservation_id,
      event_kind: 'BUDGET_CALL_STARTED',
      actor: input.actor,
      evidence: { call_id: input.call_id, call_started_at: now },
      now,
    });
    return ok(
      reservationFromRow(
        must(
          await selectReservation(query, input.reservation_id),
          'overseer_control_plane_reservation_missing_after_write'
        )
      )
    );
  });
}

export async function reconcileFusionBudget(
  input: ReconcileFusionBudgetInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerFusionReservation>> {
  if (
    !nonEmpty(input.reservation_id) ||
    !nonEmpty(input.call_id) ||
    !nonEmpty(input.actor) ||
    !Number.isInteger(input.actual_microusd) ||
    input.actual_microusd < 0
  ) {
    throw new Error('overseer_control_plane_reconcile_invalid_input');
  }
  return runControlTx(db, FUSION_BUDGET_LOCK, async (query, dialect) => {
    const now = await txNow(query, dialect);
    const raw = await selectReservation(query, input.reservation_id);
    if (!raw) return fail('budget_reservation_not_found');
    const reservation = reservationFromRow(raw);
    if (reservation.call_id !== input.call_id) return fail('budget_reservation_stale');
    if (reservation.status === 'RECONCILED') {
      if (reservation.actual_microusd === input.actual_microusd) {
        return input.actual_microusd > reservation.requested_microusd
          ? fail('budget_overage_recorded')
          : ok(reservation);
      }
      return fail('budget_transition_invalid');
    }
    if (reservation.status !== 'IN_FLIGHT') return fail('budget_transition_invalid');

    await query(
      "UPDATE overseer_fusion_budget_reservations SET status='RECONCILED', actual_microusd=$2, reconciled_at=$3 WHERE reservation_id=$1",
      [input.reservation_id, input.actual_microusd, now]
    );
    const overage = input.actual_microusd > reservation.requested_microusd;
    await appendControlEvent(query, {
      resource_kind: 'FUSION_BUDGET',
      resource_key: input.reservation_id,
      event_kind: overage ? 'BUDGET_OVERAGE_RECORDED' : 'BUDGET_RECONCILED',
      actor: input.actor,
      evidence: {
        call_id: input.call_id,
        requested_microusd: reservation.requested_microusd,
        actual_microusd: input.actual_microusd,
        overage,
      },
      now,
    });
    const updated = reservationFromRow(
      must(
        await selectReservation(query, input.reservation_id),
        'overseer_control_plane_reservation_missing_after_write'
      )
    );
    return overage ? fail('budget_overage_recorded') : ok(updated);
  });
}

export async function releaseFusionBudgetReservation(
  input: ReleaseFusionBudgetReservationInput,
  db: IDatabase = getDatabase()
): Promise<ControlResult<OverseerFusionReservation>> {
  if (!nonEmpty(input.reservation_id) || !nonEmpty(input.call_id) || !nonEmpty(input.actor)) {
    throw new Error('overseer_control_plane_release_reservation_invalid_input');
  }
  const validReasons: readonly FusionReleaseReason[] = [
    'call_cancelled_before_start',
    'authorization_revoked_before_start',
    'provider_unavailable_before_start',
  ];
  if (!validReasons.includes(input.release_reason)) return fail('budget_transition_invalid');
  return runControlTx(db, FUSION_BUDGET_LOCK, async (query, dialect) => {
    const now = await txNow(query, dialect);
    const raw = await selectReservation(query, input.reservation_id);
    if (!raw) return fail('budget_reservation_not_found');
    const reservation = reservationFromRow(raw);
    if (reservation.call_id !== input.call_id) return fail('budget_reservation_stale');
    if (reservation.status === 'RELEASED') return ok(reservation); // idempotent replay
    if (reservation.status !== 'RESERVED') return fail('budget_transition_invalid');
    await query(
      "UPDATE overseer_fusion_budget_reservations SET status='RELEASED', released_at=$2 WHERE reservation_id=$1",
      [input.reservation_id, now]
    );
    await appendControlEvent(query, {
      resource_kind: 'FUSION_BUDGET',
      resource_key: input.reservation_id,
      event_kind: 'BUDGET_RELEASED',
      actor: input.actor,
      evidence: { call_id: input.call_id, release_reason: input.release_reason },
      now,
    });
    return ok(
      reservationFromRow(
        must(
          await selectReservation(query, input.reservation_id),
          'overseer_control_plane_reservation_missing_after_write'
        )
      )
    );
  });
}

// ---------------------------------------------------------------------------
// Events (read-only)
// ---------------------------------------------------------------------------

export async function listOverseerControlEvents(
  filter: ListOverseerControlEventsFilter = {},
  db: IDatabase = getDatabase()
): Promise<readonly OverseerControlEvent[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.resource_kind !== undefined) {
    params.push(filter.resource_kind);
    clauses.push(`resource_kind=$${params.length}`);
  }
  if (filter.resource_key !== undefined) {
    params.push(filter.resource_key);
    clauses.push(`resource_key=$${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = (
    await db.query<Record<string, unknown>>(
      `SELECT * FROM overseer_control_events ${where} ORDER BY resource_kind, resource_key, event_sequence`,
      params
    )
  ).rows;
  return rows.map(eventFromRow);
}
