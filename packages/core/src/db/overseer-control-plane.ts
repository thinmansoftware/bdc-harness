import { createHash, randomUUID } from 'crypto';
import { getDatabase } from './connection';
import type { IDatabase, QueryResult } from './adapters/types';
import {
  withOverseerControlPlaneImmediateTransaction,
  type OverseerControlPlaneQuery,
} from './overseer-control-plane-sqlite';

export const OVERSEER_CONTROL_PLANE_SCHEMA_VERSION = 'overseer-control-plane-v1' as const;
export const OVERSEER_VERIFIER_REGISTRY_SCHEMA_VERSION = 'overseer-verifier-registry-v1' as const;
export const OVERSEER_CONTROL_PLANE_LEASE_SECONDS = 300;
export const OVERSEER_PARENT_CAPACITY = 10;
export const FUSION_PER_CALL_CAP_MICROUSD = 3_000_000;
export const FUSION_UTC_DAY_CAP_MICROUSD = 20_000_000;
export const FUSION_UTC_MONTH_CAP_MICROUSD = 100_000_000;

export const OVERSEER_PARENT_ACTIVE_STATES = [
  'BUILDING',
  'REVIEW',
  'STAGING',
  'RECOVERY',
  'ACTION_PENDING',
] as const;
export const OVERSEER_PARENT_TERMINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type OverseerParentActiveState = (typeof OVERSEER_PARENT_ACTIVE_STATES)[number];
export type OverseerParentTerminalState = (typeof OVERSEER_PARENT_TERMINAL_STATES)[number];
export type OverseerParentState = OverseerParentActiveState | OverseerParentTerminalState;

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

export type OverseerControlPlaneFailureCode =
  | 'unknown_field'
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

export type OverseerControlPlaneResult<T> =
  | { readonly ok: true; readonly value: T; readonly created?: boolean }
  | { readonly ok: false; readonly code: OverseerControlPlaneFailureCode };

export interface AdmitOverseerParentInput {
  readonly parent_id: string;
  readonly owner_id: string;
  readonly correlation_id: string;
  readonly state: OverseerParentActiveState;
}

export type OverseerChildState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export interface OverseerParentChild {
  readonly parent_id: string;
  readonly child_id: string;
  readonly state: OverseerChildState;
  readonly created_at: string;
  readonly terminal_at: string | null;
}
export interface HeartbeatOverseerParentInput {
  readonly parent_id: string;
  readonly owner_id: string;
  readonly fencing_token: number;
}
export interface TransitionOverseerParentStateInput extends HeartbeatOverseerParentInput {
  readonly state: OverseerParentActiveState;
}
export interface LinkOverseerChildInput extends HeartbeatOverseerParentInput {
  readonly child_id: string;
}
export interface TransitionOverseerChildStateInput extends LinkOverseerChildInput {
  readonly state: OverseerChildState;
}
export interface ReleaseOverseerParentInput extends HeartbeatOverseerParentInput {
  readonly state: OverseerParentTerminalState;
  readonly terminal_reason: string;
}
export interface ReconcileExpiredParentCommitmentsResult {
  readonly reconciled_parent_ids: readonly string[];
}
export interface RepositoryMutationLease {
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
export interface AcquireRepositoryMutationLeaseInput {
  readonly repository: string;
  readonly lease_id: string;
  readonly owner_id: string;
  readonly execution_id: string;
  readonly action_kind: string;
  readonly capability: string;
}
export interface RepositoryMutationLeaseFenceInput {
  readonly repository: string;
  readonly lease_id: string;
  readonly owner_id: string;
  readonly execution_id: string;
  readonly fencing_token: number;
}
export const OVERSEER_VERIFIER_ROLES = ['REVIEWER', 'RED_TEAM', 'FUSION', 'MERGE_STEWARD'] as const;
export type OverseerVerifierRole = (typeof OVERSEER_VERIFIER_ROLES)[number];
export interface OverseerVerifierEntryInput {
  readonly verifier_id: string;
  readonly provider: string;
  readonly model_family: string;
  readonly roles: readonly OverseerVerifierRole[];
  readonly enabled: boolean;
}
export interface OverseerVerifierEntry extends OverseerVerifierEntryInput {
  readonly registry_digest: string;
}
export interface RegisterVerifierRegistryInput {
  readonly schema_version: typeof OVERSEER_VERIFIER_REGISTRY_SCHEMA_VERSION;
  readonly registry_digest: string;
  readonly entries: readonly OverseerVerifierEntryInput[];
  readonly source_artifact_path: string;
  readonly source_git_blob: string;
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
export interface AssertIndependentVerifierInput {
  readonly operator_provider: string;
  readonly operator_model_family: string;
  readonly registry_digest: string;
  readonly verifier_id: string;
  readonly required_role: OverseerVerifierRole;
}
export interface IndependentVerifierAuthorization {
  readonly allowed: true;
  readonly verifier: OverseerVerifierEntry;
}
export type FusionCallKind = 'PRIMARY' | 'RETRY' | 'FALLBACK' | 'INDIRECT';
export type FusionBudgetStatus = 'RESERVED' | 'IN_FLIGHT' | 'RECONCILED' | 'RELEASED';
export type FusionBudgetReleaseReason =
  | 'call_cancelled_before_start'
  | 'authorization_revoked_before_start'
  | 'provider_unavailable_before_start';
export interface FusionBudgetReservation {
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
  readonly status: FusionBudgetStatus;
  readonly reserved_at: string;
  readonly call_started_at: string | null;
  readonly reconciled_at: string | null;
  readonly released_at: string | null;
  readonly release_reason: FusionBudgetReleaseReason | null;
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
}
export interface FusionBudgetIdentityInput {
  readonly reservation_id: string;
  readonly call_id: string;
}
export interface ReconcileFusionBudgetInput extends FusionBudgetIdentityInput {
  readonly actual_microusd: number;
}
export interface ReleaseFusionBudgetReservationInput extends FusionBudgetIdentityInput {
  readonly release_reason: FusionBudgetReleaseReason;
}

type TxQuery = OverseerControlPlaneQuery;
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
export interface OverseerControlEvent {
  readonly event_id: string;
  readonly resource_kind: OverseerControlResourceKind;
  readonly resource_key: string;
  readonly event_kind: OverseerControlEventKind;
  readonly actor: string;
  readonly event_sequence: number;
  readonly evidence_json: unknown;
  readonly previous_event_digest: string | null;
  readonly event_digest: string;
  readonly created_at: string;
}
export interface ListOverseerControlEventsFilter {
  readonly resource_kind?: OverseerControlResourceKind;
  readonly resource_key?: string;
}

interface DatabaseClock {
  readonly db_now: string;
  readonly lease_expires_at: string;
}

interface EventTip {
  readonly event_sequence: number | string;
  readonly event_digest: string;
}

const postgresTransactionTails = new Map<string, Promise<void>>();

async function withPostgresProcessSerialization<T>(
  lockKey: string,
  fn: () => Promise<T>
): Promise<T> {
  const prior = postgresTransactionTails.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = prior.then(() => current);
  postgresTransactionTails.set(lockKey, tail);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (postgresTransactionTails.get(lockKey) === tail) postgresTransactionTails.delete(lockKey);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function canonicalOverseerControlPlaneJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256Domain(domain: string, payload: string): string {
  return createHash('sha256').update(domain).update(payload).digest('hex');
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  throw new Error('overseer_control_plane_invalid_database_timestamp');
}

function databaseInteger(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error('overseer_control_plane_invalid_database_integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('overseer_control_plane_invalid_database_integer');
  }
  return parsed;
}

function parseDatabaseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function exactKeys(value: object, allowed: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === allowed.length && keys.every((key, index) => key === [...allowed].sort()[index])
  );
}

function activeParentState(value: unknown): value is OverseerParentActiveState {
  return OVERSEER_PARENT_ACTIVE_STATES.includes(value as OverseerParentActiveState);
}

function terminalParentState(value: unknown): value is OverseerParentTerminalState {
  return OVERSEER_PARENT_TERMINAL_STATES.includes(value as OverseerParentTerminalState);
}

function terminalChildState(value: OverseerChildState): boolean {
  return value === 'COMPLETED' || value === 'FAILED' || value === 'CANCELLED';
}

const CANONICAL_IDENTITY_RE = /^[a-z0-9][a-z0-9._/-]*$/;

function canonicalVerifierEntries(
  entries: readonly OverseerVerifierEntryInput[]
): readonly OverseerVerifierEntryInput[] {
  if (!Array.isArray(entries)) throw new Error('registry_invalid');
  const seen = new Set<string>();
  const canonical: OverseerVerifierEntryInput[] = entries.map(entry => {
    if (
      !exactKeys(entry, ['verifier_id', 'provider', 'model_family', 'roles', 'enabled']) ||
      !CANONICAL_IDENTITY_RE.test(entry.verifier_id) ||
      !CANONICAL_IDENTITY_RE.test(entry.provider) ||
      !CANONICAL_IDENTITY_RE.test(entry.model_family) ||
      typeof entry.enabled !== 'boolean' ||
      !Array.isArray(entry.roles) ||
      entry.roles.length === 0
    ) {
      throw new Error('registry_invalid');
    }
    if (seen.has(entry.verifier_id)) throw new Error('registry_invalid');
    seen.add(entry.verifier_id);
    const roles = [...entry.roles].sort();
    if (
      new Set(roles).size !== roles.length ||
      roles.some(role => !OVERSEER_VERIFIER_ROLES.includes(role))
    ) {
      throw new Error('registry_invalid');
    }
    return {
      verifier_id: entry.verifier_id,
      provider: entry.provider,
      model_family: entry.model_family,
      roles,
      enabled: entry.enabled,
    };
  });
  return canonical.sort((left, right) => left.verifier_id.localeCompare(right.verifier_id));
}

export function computeVerifierRegistryDigest(
  entries: readonly OverseerVerifierEntryInput[]
): string {
  const content = canonicalOverseerControlPlaneJson({
    schema_version: OVERSEER_VERIFIER_REGISTRY_SCHEMA_VERSION,
    entries: canonicalVerifierEntries(entries),
  });
  return sha256Domain('overseer-verifier-registry-v1\n', content);
}

async function databaseClock(
  query: TxQuery,
  dialect: IDatabase['dialect']
): Promise<DatabaseClock> {
  const sql =
    dialect === 'postgres'
      ? `WITH database_clock AS (SELECT clock_timestamp() AS value)
         SELECT to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS db_now,
          to_char((value + interval '300 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_expires_at
         FROM database_clock`
      : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS db_now,
          strftime('%Y-%m-%dT%H:%M:%fZ','now','+300 seconds') AS lease_expires_at`;
  const result = await query<DatabaseClock>(sql);
  const row = result.rows[0];
  if (!row) throw new Error('overseer_control_plane_database_clock_unavailable');
  return row;
}

async function withSerializedTransaction<T>(
  database: IDatabase,
  lockKey: string,
  fn: (query: TxQuery) => Promise<T>
): Promise<T> {
  if (database.dialect === 'sqlite') {
    return withOverseerControlPlaneImmediateTransaction(database, fn);
  }
  return withPostgresProcessSerialization(lockKey, async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        return await database.withTransaction(async query => {
          await query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
          await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
          return fn(query);
        });
      } catch (error) {
        const code = (error as { readonly code?: unknown }).code;
        if (code !== '40001') throw error;
        if (attempt === 5) {
          throw new Error('overseer_control_plane_serialization_retry_exhausted', { cause: error });
        }
        await new Promise(resolve => setTimeout(resolve, attempt * attempt * 10));
      }
    }
    throw new Error('overseer_control_plane_serialization_retry_unreachable');
  });
}

async function appendControlEvent(
  query: TxQuery,
  input: {
    readonly resource_kind: OverseerControlResourceKind;
    readonly resource_key: string;
    readonly event_kind: OverseerControlEventKind;
    readonly actor: string;
    readonly evidence: unknown;
    readonly created_at: string;
  }
): Promise<void> {
  const tip = (
    await query<EventTip>(
      `SELECT event_sequence,event_digest FROM overseer_control_events
       WHERE resource_kind=$1 AND resource_key=$2 ORDER BY event_sequence DESC LIMIT 1`,
      [input.resource_kind, input.resource_key]
    )
  ).rows[0];
  const eventId = `ocp-event-${randomUUID()}`;
  const sequence = tip ? Number(tip.event_sequence) + 1 : 1;
  const previous = tip?.event_digest ?? null;
  const evidenceJson = canonicalOverseerControlPlaneJson(input.evidence);
  const payload = canonicalOverseerControlPlaneJson({
    actor: input.actor,
    created_at: input.created_at,
    event_id: eventId,
    event_kind: input.event_kind,
    event_sequence: sequence,
    evidence_json: JSON.parse(evidenceJson),
    previous_event_digest: previous,
    resource_key: input.resource_key,
    resource_kind: input.resource_kind,
  });
  const eventDigest = sha256Domain('overseer-control-event-v1\n', payload);
  await query(
    `INSERT INTO overseer_control_events
      (event_id,resource_kind,resource_key,event_kind,actor,event_sequence,evidence_json,previous_event_digest,event_digest,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      eventId,
      input.resource_kind,
      input.resource_key,
      input.event_kind,
      input.actor,
      sequence,
      evidenceJson,
      previous,
      eventDigest,
      input.created_at,
    ]
  );
}

async function rowByParent(
  query: TxQuery,
  parentId: string
): Promise<OverseerParentCommitment | null> {
  const row = (
    await query<OverseerParentCommitment>(
      'SELECT * FROM overseer_parent_commitments WHERE parent_id=$1',
      [parentId]
    )
  ).rows[0];
  return row
    ? {
        ...row,
        fencing_token: databaseInteger(row.fencing_token),
        admitted_at: timestamp(row.admitted_at),
        heartbeat_at: timestamp(row.heartbeat_at),
        lease_expires_at: timestamp(row.lease_expires_at),
        released_at: row.released_at === null ? null : timestamp(row.released_at),
      }
    : null;
}

async function rowByChild(query: TxQuery, childId: string): Promise<OverseerParentChild | null> {
  const row = (
    await query<OverseerParentChild>('SELECT * FROM overseer_parent_children WHERE child_id=$1', [
      childId,
    ])
  ).rows[0];
  return row
    ? {
        ...row,
        created_at: timestamp(row.created_at),
        terminal_at: row.terminal_at === null ? null : timestamp(row.terminal_at),
      }
    : null;
}

function currentParentFence(
  parent: OverseerParentCommitment,
  input: HeartbeatOverseerParentInput,
  now: string
): boolean {
  return (
    activeParentState(parent.state) &&
    parent.owner_id === input.owner_id &&
    databaseInteger(parent.fencing_token) === input.fencing_token &&
    Date.parse(now) < Date.parse(parent.lease_expires_at)
  );
}

async function reconcileExpiredParentsInTransaction(
  query: TxQuery,
  dialect: IDatabase['dialect']
): Promise<ReconcileExpiredParentCommitmentsResult> {
  const clock = await databaseClock(query, dialect);
  const expired = await query<OverseerParentCommitment>(
    `SELECT * FROM overseer_parent_commitments
     WHERE state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING')
       AND released_at IS NULL AND lease_expires_at <= $1 ORDER BY parent_id`,
    [clock.db_now]
  );
  const reconciled: string[] = [];
  for (const parent of expired.rows) {
    const children = await query<OverseerParentChild>(
      `SELECT * FROM overseer_parent_children WHERE parent_id=$1
       AND state IN ('PENDING','RUNNING') ORDER BY child_id`,
      [parent.parent_id]
    );
    for (const child of children.rows) {
      const changedChild = await query(
        "UPDATE overseer_parent_children SET state='FAILED',terminal_at=$1 WHERE child_id=$2 AND parent_id=$3 AND state=$4",
        [clock.db_now, child.child_id, parent.parent_id, child.state]
      );
      if (changedChild.rowCount !== 1) continue;
      await appendControlEvent(query, {
        resource_kind: 'CHILD',
        resource_key: child.child_id,
        event_kind: 'STATE_CHANGED',
        actor: 'overseer-control:restart-reconciler',
        evidence: { from_state: child.state, reason: 'owner_lease_expired', to_state: 'FAILED' },
        created_at: clock.db_now,
      });
    }
    const changed = await query(
      `UPDATE overseer_parent_commitments
       SET state='FAILED',released_at=$1,terminal_reason='owner_lease_expired',fencing_token=fencing_token+1
       WHERE parent_id=$2 AND state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING')
         AND released_at IS NULL AND lease_expires_at <= $1`,
      [clock.db_now, parent.parent_id]
    );
    if (changed.rowCount === 1) {
      await appendControlEvent(query, {
        resource_kind: 'PARENT',
        resource_key: parent.parent_id,
        event_kind: 'CRASH_RECONCILED',
        actor: 'overseer-control:restart-reconciler',
        evidence: { from_state: parent.state, terminal_reason: 'owner_lease_expired' },
        created_at: clock.db_now,
      });
      reconciled.push(parent.parent_id);
    }
  }
  return { reconciled_parent_ids: reconciled };
}

export async function admitOverseerParent(
  input: AdmitOverseerParentInput
): Promise<OverseerControlPlaneResult<OverseerParentCommitment>> {
  if (!exactKeys(input, ['parent_id', 'owner_id', 'correlation_id', 'state'])) {
    return { ok: false, code: 'unknown_field' };
  }
  if (
    !nonempty(input.parent_id) ||
    !nonempty(input.owner_id) ||
    !nonempty(input.correlation_id) ||
    !activeParentState(input.state)
  ) {
    return { ok: false, code: 'parent_transition_invalid' };
  }

  const database = getDatabase();
  return withSerializedTransaction(database, 'overseer-control:parent-admission', async query => {
    const existing = await rowByParent(query, input.parent_id);
    if (existing) {
      if (
        existing.owner_id === input.owner_id &&
        existing.correlation_id === input.correlation_id &&
        existing.state === input.state
      ) {
        return { ok: true, created: false, value: existing };
      }
      return { ok: false, code: 'parent_identity_conflict' };
    }

    await reconcileExpiredParentsInTransaction(query, database.dialect);
    const clock = await databaseClock(query, database.dialect);
    const active = await query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM overseer_parent_commitments
       WHERE state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING')
         AND released_at IS NULL AND lease_expires_at > $1`,
      [clock.db_now]
    );
    if (Number(active.rows[0]?.count ?? 0) >= OVERSEER_PARENT_CAPACITY) {
      return { ok: false, code: 'parent_capacity_reached' };
    }

    await query(
      `INSERT INTO overseer_parent_commitments
        (parent_id,state,owner_id,correlation_id,fencing_token,admitted_at,heartbeat_at,lease_expires_at,released_at,terminal_reason)
       VALUES ($1,$2,$3,$4,1,$5,$5,$6,NULL,NULL)`,
      [
        input.parent_id.trim(),
        input.state,
        input.owner_id.trim(),
        input.correlation_id.trim(),
        clock.db_now,
        clock.lease_expires_at,
      ]
    );
    await appendControlEvent(query, {
      resource_kind: 'PARENT',
      resource_key: input.parent_id.trim(),
      event_kind: 'ADMITTED',
      actor: input.owner_id.trim(),
      evidence: { correlation_id: input.correlation_id.trim(), state: input.state },
      created_at: clock.db_now,
    });
    const value = await rowByParent(query, input.parent_id.trim());
    if (!value) throw new Error('overseer_control_plane_parent_insert_missing');
    return { ok: true, created: true, value };
  });
}

export async function heartbeatOverseerParent(
  input: HeartbeatOverseerParentInput
): Promise<OverseerControlPlaneResult<OverseerParentCommitment>> {
  if (!exactKeys(input, ['parent_id', 'owner_id', 'fencing_token'])) {
    return { ok: false, code: 'unknown_field' };
  }
  const database = getDatabase();
  return withSerializedTransaction(
    database,
    `overseer-control:parent:${input.parent_id}`,
    async query => {
      const parent = await rowByParent(query, input.parent_id);
      if (!parent) return { ok: false, code: 'parent_not_found' };
      const clock = await databaseClock(query, database.dialect);
      if (!currentParentFence(parent, input, clock.db_now)) {
        return { ok: false, code: 'parent_lease_stale' };
      }
      const changed = await query(
        `UPDATE overseer_parent_commitments SET heartbeat_at=$1,lease_expires_at=$2
         WHERE parent_id=$3 AND owner_id=$4 AND fencing_token=$5 AND state=$6
           AND released_at IS NULL AND lease_expires_at > $1`,
        [
          clock.db_now,
          clock.lease_expires_at,
          input.parent_id,
          input.owner_id,
          input.fencing_token,
          parent.state,
        ]
      );
      if (changed.rowCount !== 1) return { ok: false, code: 'parent_lease_stale' };
      await appendControlEvent(query, {
        resource_kind: 'PARENT',
        resource_key: input.parent_id,
        event_kind: 'HEARTBEAT',
        actor: input.owner_id,
        evidence: { fencing_token: input.fencing_token, lease_expires_at: clock.lease_expires_at },
        created_at: clock.db_now,
      });
      const value = await rowByParent(query, input.parent_id);
      if (!value) throw new Error('overseer_control_plane_parent_heartbeat_missing');
      return { ok: true, value };
    }
  );
}

export async function transitionOverseerParentState(
  input: TransitionOverseerParentStateInput
): Promise<OverseerControlPlaneResult<OverseerParentCommitment>> {
  if (!exactKeys(input, ['parent_id', 'owner_id', 'fencing_token', 'state'])) {
    return { ok: false, code: 'unknown_field' };
  }
  if (!activeParentState(input.state)) return { ok: false, code: 'parent_transition_invalid' };
  const database = getDatabase();
  return withSerializedTransaction(
    database,
    `overseer-control:parent:${input.parent_id}`,
    async query => {
      const parent = await rowByParent(query, input.parent_id);
      if (!parent) return { ok: false, code: 'parent_not_found' };
      const clock = await databaseClock(query, database.dialect);
      if (!currentParentFence(parent, input, clock.db_now)) {
        return { ok: false, code: 'parent_lease_stale' };
      }
      if (parent.state === input.state) return { ok: true, value: parent };
      const changed = await query(
        `UPDATE overseer_parent_commitments SET state=$1
         WHERE parent_id=$2 AND owner_id=$3 AND fencing_token=$4 AND state=$5
           AND released_at IS NULL AND lease_expires_at > $6`,
        [
          input.state,
          input.parent_id,
          input.owner_id,
          input.fencing_token,
          parent.state,
          clock.db_now,
        ]
      );
      if (changed.rowCount !== 1) return { ok: false, code: 'parent_lease_stale' };
      await appendControlEvent(query, {
        resource_kind: 'PARENT',
        resource_key: input.parent_id,
        event_kind: 'STATE_CHANGED',
        actor: input.owner_id,
        evidence: { from_state: parent.state, to_state: input.state },
        created_at: clock.db_now,
      });
      const value = await rowByParent(query, input.parent_id);
      if (!value) throw new Error('overseer_control_plane_parent_transition_missing');
      return { ok: true, value };
    }
  );
}

export async function linkOverseerChild(
  input: LinkOverseerChildInput
): Promise<OverseerControlPlaneResult<OverseerParentChild>> {
  if (!exactKeys(input, ['parent_id', 'child_id', 'owner_id', 'fencing_token'])) {
    return { ok: false, code: 'unknown_field' };
  }
  const database = getDatabase();
  return withSerializedTransaction(
    database,
    `overseer-control:parent:${input.parent_id}`,
    async query => {
      const parent = await rowByParent(query, input.parent_id);
      if (!parent) return { ok: false, code: 'child_orphaned' };
      const clock = await databaseClock(query, database.dialect);
      if (!currentParentFence(parent, input, clock.db_now)) {
        return { ok: false, code: 'parent_lease_stale' };
      }
      const existing = await rowByChild(query, input.child_id);
      if (existing) {
        return existing.parent_id === input.parent_id
          ? { ok: true, created: false, value: existing }
          : { ok: false, code: 'child_identity_conflict' };
      }
      await query(
        "INSERT INTO overseer_parent_children(parent_id,child_id,state,created_at,terminal_at) VALUES ($1,$2,'PENDING',$3,NULL)",
        [input.parent_id, input.child_id, clock.db_now]
      );
      await appendControlEvent(query, {
        resource_kind: 'CHILD',
        resource_key: input.child_id,
        event_kind: 'CHILD_LINKED',
        actor: input.owner_id,
        evidence: { parent_id: input.parent_id, state: 'PENDING' },
        created_at: clock.db_now,
      });
      const value = await rowByChild(query, input.child_id);
      if (!value) throw new Error('overseer_control_plane_child_insert_missing');
      return { ok: true, created: true, value };
    }
  );
}

export async function transitionOverseerChildState(
  input: TransitionOverseerChildStateInput
): Promise<OverseerControlPlaneResult<OverseerParentChild>> {
  if (!exactKeys(input, ['parent_id', 'child_id', 'owner_id', 'fencing_token', 'state'])) {
    return { ok: false, code: 'unknown_field' };
  }
  const database = getDatabase();
  return withSerializedTransaction(
    database,
    `overseer-control:parent:${input.parent_id}`,
    async query => {
      const parent = await rowByParent(query, input.parent_id);
      if (!parent) return { ok: false, code: 'child_orphaned' };
      const clock = await databaseClock(query, database.dialect);
      if (!currentParentFence(parent, input, clock.db_now)) {
        return { ok: false, code: 'parent_lease_stale' };
      }
      const child = await rowByChild(query, input.child_id);
      if (!child) return { ok: false, code: 'child_not_found' };
      if (child.parent_id !== input.parent_id)
        return { ok: false, code: 'child_identity_conflict' };
      const valid =
        (child.state === 'PENDING' &&
          (input.state === 'RUNNING' || terminalChildState(input.state))) ||
        (child.state === 'RUNNING' && terminalChildState(input.state));
      if (!valid) return { ok: false, code: 'child_transition_invalid' };
      const changed = await query(
        `UPDATE overseer_parent_children SET state=$1,terminal_at=$2
         WHERE child_id=$3 AND parent_id=$4 AND state=$5`,
        [
          input.state,
          terminalChildState(input.state) ? clock.db_now : null,
          input.child_id,
          input.parent_id,
          child.state,
        ]
      );
      if (changed.rowCount !== 1) return { ok: false, code: 'child_transition_invalid' };
      await appendControlEvent(query, {
        resource_kind: 'CHILD',
        resource_key: input.child_id,
        event_kind: 'STATE_CHANGED',
        actor: input.owner_id,
        evidence: { from_state: child.state, parent_id: input.parent_id, to_state: input.state },
        created_at: clock.db_now,
      });
      const value = await rowByChild(query, input.child_id);
      if (!value) throw new Error('overseer_control_plane_child_transition_missing');
      return { ok: true, value };
    }
  );
}

export async function releaseOverseerParent(
  input: ReleaseOverseerParentInput
): Promise<OverseerControlPlaneResult<OverseerParentCommitment>> {
  if (!exactKeys(input, ['parent_id', 'owner_id', 'fencing_token', 'state', 'terminal_reason'])) {
    return { ok: false, code: 'unknown_field' };
  }
  if (!terminalParentState(input.state) || !nonempty(input.terminal_reason)) {
    return { ok: false, code: 'parent_transition_invalid' };
  }
  const database = getDatabase();
  return withSerializedTransaction(
    database,
    `overseer-control:parent:${input.parent_id}`,
    async query => {
      const parent = await rowByParent(query, input.parent_id);
      if (!parent) return { ok: false, code: 'parent_not_found' };
      if (terminalParentState(parent.state)) {
        return parent.owner_id === input.owner_id &&
          databaseInteger(parent.fencing_token) === input.fencing_token + 1 &&
          parent.state === input.state &&
          parent.terminal_reason === input.terminal_reason.trim()
          ? { ok: true, value: parent }
          : { ok: false, code: 'parent_transition_invalid' };
      }
      const clock = await databaseClock(query, database.dialect);
      if (!currentParentFence(parent, input, clock.db_now)) {
        return { ok: false, code: 'parent_lease_stale' };
      }
      const activeChildren = await query<OverseerParentChild>(
        "SELECT * FROM overseer_parent_children WHERE parent_id=$1 AND state IN ('PENDING','RUNNING') ORDER BY child_id",
        [input.parent_id]
      );
      if (input.state === 'COMPLETED' && activeChildren.rowCount > 0) {
        return { ok: false, code: 'parent_children_active' };
      }
      if (input.state !== 'COMPLETED') {
        for (const child of activeChildren.rows) {
          const childState: OverseerChildState = input.state;
          const changedChild = await query(
            `UPDATE overseer_parent_children SET state=$1,terminal_at=$2
             WHERE child_id=$3 AND parent_id=$4 AND state=$5`,
            [childState, clock.db_now, child.child_id, input.parent_id, child.state]
          );
          if (changedChild.rowCount !== 1) {
            return { ok: false, code: 'parent_children_active' };
          }
          await appendControlEvent(query, {
            resource_kind: 'CHILD',
            resource_key: child.child_id,
            event_kind: 'STATE_CHANGED',
            actor: input.owner_id,
            evidence: { from_state: child.state, parent_id: input.parent_id, to_state: childState },
            created_at: clock.db_now,
          });
        }
      }
      const changedParent = await query(
        `UPDATE overseer_parent_commitments
         SET state=$1,released_at=$2,terminal_reason=$3,fencing_token=fencing_token+1
         WHERE parent_id=$4 AND owner_id=$5 AND fencing_token=$6 AND state=$7
           AND released_at IS NULL AND lease_expires_at > $2`,
        [
          input.state,
          clock.db_now,
          input.terminal_reason.trim(),
          input.parent_id,
          input.owner_id,
          input.fencing_token,
          parent.state,
        ]
      );
      if (changedParent.rowCount !== 1) return { ok: false, code: 'parent_lease_stale' };
      await appendControlEvent(query, {
        resource_kind: 'PARENT',
        resource_key: input.parent_id,
        event_kind: 'STATE_CHANGED',
        actor: input.owner_id,
        evidence: {
          from_state: parent.state,
          terminal_reason: input.terminal_reason.trim(),
          to_state: input.state,
        },
        created_at: clock.db_now,
      });
      const value = await rowByParent(query, input.parent_id);
      if (!value) throw new Error('overseer_control_plane_parent_release_missing');
      return { ok: true, value };
    }
  );
}

export async function reconcileExpiredParentCommitments(): Promise<
  OverseerControlPlaneResult<ReconcileExpiredParentCommitmentsResult>
> {
  const database = getDatabase();
  return withSerializedTransaction(database, 'overseer-control:parent-admission', async query => ({
    ok: true,
    value: await reconcileExpiredParentsInTransaction(query, database.dialect),
  }));
}

async function rowByRepositoryLease(
  query: TxQuery,
  repository: string
): Promise<RepositoryMutationLease | null> {
  const row = (
    await query<RepositoryMutationLease>(
      'SELECT * FROM overseer_repository_mutation_leases WHERE repository=$1',
      [repository]
    )
  ).rows[0];
  return row
    ? {
        ...row,
        fencing_token: databaseInteger(row.fencing_token),
        acquired_at: timestamp(row.acquired_at),
        heartbeat_at: timestamp(row.heartbeat_at),
        expires_at: timestamp(row.expires_at),
        released_at: row.released_at === null ? null : timestamp(row.released_at),
      }
    : null;
}

function exactLeaseIdentity(
  lease: RepositoryMutationLease,
  input: RepositoryMutationLeaseFenceInput
): boolean {
  return (
    lease.repository === input.repository &&
    lease.lease_id === input.lease_id &&
    lease.owner_id === input.owner_id &&
    lease.execution_id === input.execution_id &&
    databaseInteger(lease.fencing_token) === input.fencing_token
  );
}

export async function acquireRepositoryMutationLease(
  input: AcquireRepositoryMutationLeaseInput
): Promise<OverseerControlPlaneResult<RepositoryMutationLease>> {
  if (
    !exactKeys(input, [
      'repository',
      'lease_id',
      'owner_id',
      'execution_id',
      'action_kind',
      'capability',
    ])
  ) {
    return { ok: false, code: 'unknown_field' };
  }
  if (Object.values(input).some(value => !nonempty(value))) {
    return { ok: false, code: 'lease_stale' };
  }
  const database = getDatabase();
  return withSerializedTransaction(
    database,
    `overseer-control:repository:${input.repository}`,
    async query => {
      const clock = await databaseClock(query, database.dialect);
      const existing = await rowByRepositoryLease(query, input.repository);
      if (!existing) {
        await query(
          `INSERT INTO overseer_repository_mutation_leases
          (repository,lease_id,owner_id,execution_id,action_kind,capability,fencing_token,state,acquired_at,heartbeat_at,expires_at,released_at)
         VALUES ($1,$2,$3,$4,$5,$6,1,'ACTIVE',$7,$7,$8,NULL)`,
          [
            input.repository.trim(),
            input.lease_id.trim(),
            input.owner_id.trim(),
            input.execution_id.trim(),
            input.action_kind.trim(),
            input.capability.trim(),
            clock.db_now,
            clock.lease_expires_at,
          ]
        );
        await appendControlEvent(query, {
          resource_kind: 'REPOSITORY_LEASE',
          resource_key: input.repository.trim(),
          event_kind: 'LEASE_ACQUIRED',
          actor: input.owner_id.trim(),
          evidence: {
            action_kind: input.action_kind.trim(),
            capability: input.capability.trim(),
            execution_id: input.execution_id.trim(),
            fencing_token: 1,
            lease_id: input.lease_id.trim(),
          },
          created_at: clock.db_now,
        });
      } else if (
        existing.state === 'ACTIVE' &&
        Date.parse(clock.db_now) < Date.parse(existing.expires_at)
      ) {
        const replay =
          existing.lease_id === input.lease_id &&
          existing.owner_id === input.owner_id &&
          existing.execution_id === input.execution_id &&
          existing.action_kind === input.action_kind &&
          existing.capability === input.capability;
        return replay ? { ok: true, value: existing } : { ok: false, code: 'lease_conflict' };
      } else {
        const nextFence = databaseInteger(existing.fencing_token) + 1;
        const changed = await query(
          `UPDATE overseer_repository_mutation_leases SET
          lease_id=$1,owner_id=$2,execution_id=$3,action_kind=$4,capability=$5,
          fencing_token=$6,state='ACTIVE',acquired_at=$7,heartbeat_at=$7,expires_at=$8,released_at=NULL
         WHERE repository=$9 AND fencing_token=$10 AND state=$11 AND expires_at=$12`,
          [
            input.lease_id.trim(),
            input.owner_id.trim(),
            input.execution_id.trim(),
            input.action_kind.trim(),
            input.capability.trim(),
            nextFence,
            clock.db_now,
            clock.lease_expires_at,
            input.repository.trim(),
            existing.fencing_token,
            existing.state,
            existing.expires_at,
          ]
        );
        if (changed.rowCount !== 1) return { ok: false, code: 'lease_conflict' };
        await appendControlEvent(query, {
          resource_kind: 'REPOSITORY_LEASE',
          resource_key: input.repository.trim(),
          event_kind: 'LEASE_TAKEN_OVER',
          actor: input.owner_id.trim(),
          evidence: {
            execution_id: input.execution_id.trim(),
            fencing_token: nextFence,
            lease_id: input.lease_id.trim(),
            previous_fencing_token: databaseInteger(existing.fencing_token),
          },
          created_at: clock.db_now,
        });
      }
      const value = await rowByRepositoryLease(query, input.repository.trim());
      if (!value) throw new Error('overseer_control_plane_repository_lease_insert_missing');
      return { ok: true, value };
    }
  );
}

export async function heartbeatRepositoryMutationLease(
  input: RepositoryMutationLeaseFenceInput
): Promise<OverseerControlPlaneResult<RepositoryMutationLease>> {
  if (!exactKeys(input, ['repository', 'lease_id', 'owner_id', 'execution_id', 'fencing_token'])) {
    return { ok: false, code: 'unknown_field' };
  }
  const database = getDatabase();
  return withSerializedTransaction(
    database,
    `overseer-control:repository:${input.repository}`,
    async query => {
      const lease = await rowByRepositoryLease(query, input.repository);
      if (!lease) return { ok: false, code: 'lease_not_found' };
      const clock = await databaseClock(query, database.dialect);
      if (
        lease.state !== 'ACTIVE' ||
        !exactLeaseIdentity(lease, input) ||
        Date.parse(clock.db_now) >= Date.parse(lease.expires_at)
      ) {
        return { ok: false, code: 'lease_stale' };
      }
      const changed = await query(
        `UPDATE overseer_repository_mutation_leases SET heartbeat_at=$1,expires_at=$2
         WHERE repository=$3 AND lease_id=$4 AND owner_id=$5 AND execution_id=$6
           AND fencing_token=$7 AND state='ACTIVE' AND expires_at > $1`,
        [
          clock.db_now,
          clock.lease_expires_at,
          input.repository,
          input.lease_id,
          input.owner_id,
          input.execution_id,
          input.fencing_token,
        ]
      );
      if (changed.rowCount !== 1) return { ok: false, code: 'lease_stale' };
      await appendControlEvent(query, {
        resource_kind: 'REPOSITORY_LEASE',
        resource_key: input.repository,
        event_kind: 'HEARTBEAT',
        actor: input.owner_id,
        evidence: { fencing_token: input.fencing_token, lease_expires_at: clock.lease_expires_at },
        created_at: clock.db_now,
      });
      const value = await rowByRepositoryLease(query, input.repository);
      if (!value) throw new Error('overseer_control_plane_repository_lease_heartbeat_missing');
      return { ok: true, value };
    }
  );
}

export async function releaseRepositoryMutationLease(
  input: RepositoryMutationLeaseFenceInput
): Promise<OverseerControlPlaneResult<RepositoryMutationLease>> {
  if (!exactKeys(input, ['repository', 'lease_id', 'owner_id', 'execution_id', 'fencing_token'])) {
    return { ok: false, code: 'unknown_field' };
  }
  const database = getDatabase();
  return withSerializedTransaction(
    database,
    `overseer-control:repository:${input.repository}`,
    async query => {
      const lease = await rowByRepositoryLease(query, input.repository);
      if (!lease) return { ok: false, code: 'lease_not_found' };
      if (!exactLeaseIdentity(lease, input)) return { ok: false, code: 'lease_stale' };
      if (lease.state === 'RELEASED') return { ok: true, value: lease };
      const clock = await databaseClock(query, database.dialect);
      if (lease.state !== 'ACTIVE' || Date.parse(clock.db_now) >= Date.parse(lease.expires_at)) {
        return { ok: false, code: 'lease_stale' };
      }
      const changed = await query(
        `UPDATE overseer_repository_mutation_leases SET state='RELEASED',released_at=$1
         WHERE repository=$2 AND lease_id=$3 AND owner_id=$4 AND execution_id=$5
           AND fencing_token=$6 AND state='ACTIVE' AND expires_at > $1`,
        [
          clock.db_now,
          input.repository,
          input.lease_id,
          input.owner_id,
          input.execution_id,
          input.fencing_token,
        ]
      );
      if (changed.rowCount !== 1) return { ok: false, code: 'lease_stale' };
      await appendControlEvent(query, {
        resource_kind: 'REPOSITORY_LEASE',
        resource_key: input.repository,
        event_kind: 'LEASE_RELEASED',
        actor: input.owner_id,
        evidence: { execution_id: input.execution_id, fencing_token: input.fencing_token },
        created_at: clock.db_now,
      });
      const value = await rowByRepositoryLease(query, input.repository);
      if (!value) throw new Error('overseer_control_plane_repository_lease_release_missing');
      return { ok: true, value };
    }
  );
}

async function loadVerifierRegistry(
  query: TxQuery,
  registryDigest: string
): Promise<OverseerVerifierRegistry | null> {
  type Header = Omit<OverseerVerifierRegistry, 'entries'>;
  type EntryRow = Omit<OverseerVerifierEntry, 'roles' | 'enabled'> & {
    readonly roles_json: string | readonly OverseerVerifierRole[];
    readonly enabled: boolean | number;
  };
  const header = (
    await query<Header>('SELECT * FROM overseer_verifier_registries WHERE registry_digest=$1', [
      registryDigest,
    ])
  ).rows[0];
  if (!header) return null;
  const rows = await query<EntryRow>(
    'SELECT * FROM overseer_verifier_entries WHERE registry_digest=$1 ORDER BY verifier_id',
    [registryDigest]
  );
  return {
    ...header,
    frozen_at: timestamp(header.frozen_at),
    created_at: timestamp(header.created_at),
    entries: rows.rows.map(row => ({
      registry_digest: row.registry_digest,
      verifier_id: row.verifier_id,
      provider: row.provider,
      model_family: row.model_family,
      roles:
        typeof row.roles_json === 'string'
          ? (JSON.parse(row.roles_json) as OverseerVerifierRole[])
          : row.roles_json,
      enabled: row.enabled === true || row.enabled === 1,
    })),
  };
}

export async function registerVerifierRegistry(
  input: RegisterVerifierRegistryInput
): Promise<OverseerControlPlaneResult<OverseerVerifierRegistry>> {
  if (
    !exactKeys(input, [
      'schema_version',
      'registry_digest',
      'entries',
      'source_artifact_path',
      'source_git_blob',
    ])
  ) {
    return { ok: false, code: 'unknown_field' };
  }
  let entries: readonly OverseerVerifierEntryInput[];
  try {
    entries = canonicalVerifierEntries(input.entries);
  } catch {
    return { ok: false, code: 'registry_invalid' };
  }
  if (
    input.schema_version !== OVERSEER_VERIFIER_REGISTRY_SCHEMA_VERSION ||
    !nonempty(input.source_artifact_path) ||
    !nonempty(input.source_git_blob)
  ) {
    return { ok: false, code: 'registry_invalid' };
  }
  const computed = computeVerifierRegistryDigest(entries);
  if (input.registry_digest !== computed) {
    return { ok: false, code: 'registry_digest_mismatch' };
  }
  const database = getDatabase();
  return withSerializedTransaction(
    database,
    `overseer-control:registry:${computed}`,
    async query => {
      const existing = await loadVerifierRegistry(query, computed);
      if (existing) {
        const same =
          existing.source_artifact_path === input.source_artifact_path &&
          existing.source_git_blob === input.source_git_blob &&
          canonicalOverseerControlPlaneJson(
            existing.entries.map(({ registry_digest: _registryDigest, ...entry }) => entry)
          ) === canonicalOverseerControlPlaneJson(entries);
        return same
          ? { ok: true, created: false, value: existing }
          : { ok: false, code: 'registry_digest_conflict' };
      }
      const clock = await databaseClock(query, database.dialect);
      await query(
        `INSERT INTO overseer_verifier_registries
        (registry_digest,schema_version,frozen_at,created_at,source_artifact_path,source_git_blob)
       VALUES ($1,$2,$3,$3,$4,$5)`,
        [
          computed,
          OVERSEER_VERIFIER_REGISTRY_SCHEMA_VERSION,
          clock.db_now,
          input.source_artifact_path.trim(),
          input.source_git_blob.trim(),
        ]
      );
      for (const entry of entries) {
        await query(
          `INSERT INTO overseer_verifier_entries
          (registry_digest,verifier_id,provider,model_family,roles_json,enabled)
         VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            computed,
            entry.verifier_id,
            entry.provider,
            entry.model_family,
            canonicalOverseerControlPlaneJson(entry.roles),
            entry.enabled,
          ]
        );
      }
      await appendControlEvent(query, {
        resource_kind: 'VERIFIER_REGISTRY',
        resource_key: computed,
        event_kind: 'REGISTRY_FROZEN',
        actor: 'overseer-control:registry',
        evidence: {
          entry_count: entries.length,
          source_artifact_path: input.source_artifact_path.trim(),
          source_git_blob: input.source_git_blob.trim(),
        },
        created_at: clock.db_now,
      });
      const value = await loadVerifierRegistry(query, computed);
      if (!value) throw new Error('overseer_control_plane_verifier_registry_insert_missing');
      return { ok: true, created: true, value };
    }
  );
}

export async function assertIndependentVerifier(
  input: AssertIndependentVerifierInput
): Promise<OverseerControlPlaneResult<IndependentVerifierAuthorization>> {
  if (
    !exactKeys(input, [
      'operator_provider',
      'operator_model_family',
      'registry_digest',
      'verifier_id',
      'required_role',
    ])
  ) {
    return { ok: false, code: 'unknown_field' };
  }
  if (
    !CANONICAL_IDENTITY_RE.test(input.operator_provider) ||
    !CANONICAL_IDENTITY_RE.test(input.operator_model_family) ||
    !CANONICAL_IDENTITY_RE.test(input.verifier_id) ||
    !OVERSEER_VERIFIER_ROLES.includes(input.required_role)
  ) {
    return { ok: false, code: 'verifier_not_independent' };
  }
  const database = getDatabase();
  const registry = await loadVerifierRegistry(database.query.bind(database), input.registry_digest);
  if (!registry) return { ok: false, code: 'verifier_registry_missing' };
  const verifier = registry.entries.find(entry => entry.verifier_id === input.verifier_id);
  if (!verifier) return { ok: false, code: 'verifier_unknown' };
  if (!verifier.enabled) return { ok: false, code: 'verifier_disabled' };
  if (!verifier.roles.includes(input.required_role)) {
    return { ok: false, code: 'verifier_role_mismatch' };
  }
  if (
    verifier.provider === input.operator_provider ||
    verifier.model_family === input.operator_model_family
  ) {
    return { ok: false, code: 'verifier_not_independent' };
  }
  return { ok: true, value: { allowed: true, verifier } };
}

function normalizeFusionReservation(row: FusionBudgetReservation): FusionBudgetReservation {
  return {
    ...row,
    requested_microusd: databaseInteger(row.requested_microusd),
    actual_microusd: row.actual_microusd === null ? null : databaseInteger(row.actual_microusd),
    reserved_at: timestamp(row.reserved_at),
    call_started_at: row.call_started_at === null ? null : timestamp(row.call_started_at),
    reconciled_at: row.reconciled_at === null ? null : timestamp(row.reconciled_at),
    released_at: row.released_at === null ? null : timestamp(row.released_at),
  };
}

async function loadFusionReservation(
  query: TxQuery,
  reservationId: string,
  callId?: string
): Promise<FusionBudgetReservation | null> {
  const where = callId ? 'WHERE reservation_id=$1 OR call_id=$2' : 'WHERE reservation_id=$1';
  const params = callId ? [reservationId, callId] : [reservationId];
  const row = (
    await query<FusionBudgetReservation>(
      `SELECT * FROM overseer_fusion_budget_reservations ${where} LIMIT 1`,
      params
    )
  ).rows[0];
  return row ? normalizeFusionReservation(row) : null;
}

async function fusionBudgetTotals(
  query: TxQuery,
  utcDay: string,
  utcMonth: string
): Promise<{ readonly day: number; readonly month: number }> {
  const charge = `CASE
    WHEN status IN ('RESERVED','IN_FLIGHT') THEN requested_microusd
    WHEN status='RECONCILED' THEN actual_microusd
    ELSE 0 END`;
  const result = await query<{ day_total: number | string; month_total: number | string }>(
    `SELECT
      COALESCE(SUM(CASE WHEN utc_day=$1 THEN ${charge} ELSE 0 END),0) AS day_total,
      COALESCE(SUM(CASE WHEN utc_month=$2 THEN ${charge} ELSE 0 END),0) AS month_total
     FROM overseer_fusion_budget_reservations`,
    [utcDay, utcMonth]
  );
  return {
    day: Number(result.rows[0]?.day_total ?? 0),
    month: Number(result.rows[0]?.month_total ?? 0),
  };
}

export async function reserveFusionBudget(
  input: ReserveFusionBudgetInput
): Promise<OverseerControlPlaneResult<FusionBudgetReservation>> {
  if (
    !exactKeys(input, [
      'reservation_id',
      'call_id',
      'proposal_id',
      'execution_id',
      'provider',
      'model',
      'call_kind',
      'requested_microusd',
    ])
  ) {
    return { ok: false, code: 'unknown_field' };
  }
  if (
    !nonempty(input.reservation_id) ||
    !nonempty(input.call_id) ||
    !nonempty(input.proposal_id) ||
    !nonempty(input.execution_id) ||
    !CANONICAL_IDENTITY_RE.test(input.provider) ||
    !CANONICAL_IDENTITY_RE.test(input.model) ||
    !['PRIMARY', 'RETRY', 'FALLBACK', 'INDIRECT'].includes(input.call_kind) ||
    !Number.isInteger(input.requested_microusd) ||
    input.requested_microusd < 1 ||
    input.requested_microusd > FUSION_PER_CALL_CAP_MICROUSD
  ) {
    return { ok: false, code: 'budget_cap_exceeded' };
  }
  const database = getDatabase();
  return withSerializedTransaction(database, 'overseer-control:fusion-budget', async query => {
    const existing = await loadFusionReservation(query, input.reservation_id, input.call_id);
    if (existing) {
      const replay =
        existing.reservation_id === input.reservation_id &&
        existing.call_id === input.call_id &&
        existing.proposal_id === input.proposal_id &&
        existing.execution_id === input.execution_id &&
        existing.provider === input.provider &&
        existing.model === input.model &&
        existing.call_kind === input.call_kind &&
        existing.requested_microusd === input.requested_microusd;
      return replay
        ? { ok: true, created: false, value: existing }
        : { ok: false, code: 'budget_reservation_stale' };
    }
    const clock = await databaseClock(query, database.dialect);
    const utcDay = clock.db_now.slice(0, 10);
    const utcMonth = clock.db_now.slice(0, 7);
    const totals = await fusionBudgetTotals(query, utcDay, utcMonth);
    if (
      totals.day + input.requested_microusd > FUSION_UTC_DAY_CAP_MICROUSD ||
      totals.month + input.requested_microusd > FUSION_UTC_MONTH_CAP_MICROUSD
    ) {
      return { ok: false, code: 'budget_cap_exceeded' };
    }
    await query(
      `INSERT INTO overseer_fusion_budget_reservations
        (reservation_id,call_id,proposal_id,execution_id,provider,model,call_kind,utc_day,utc_month,
         requested_microusd,actual_microusd,status,reserved_at,call_started_at,reconciled_at,released_at,release_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,'RESERVED',$11,NULL,NULL,NULL,NULL)`,
      [
        input.reservation_id.trim(),
        input.call_id.trim(),
        input.proposal_id.trim(),
        input.execution_id.trim(),
        input.provider,
        input.model,
        input.call_kind,
        utcDay,
        utcMonth,
        input.requested_microusd,
        clock.db_now,
      ]
    );
    await appendControlEvent(query, {
      resource_kind: 'FUSION_BUDGET',
      resource_key: input.reservation_id.trim(),
      event_kind: 'BUDGET_RESERVED',
      actor: input.execution_id.trim(),
      evidence: {
        call_id: input.call_id.trim(),
        call_kind: input.call_kind,
        requested_microusd: input.requested_microusd,
        utc_day: utcDay,
        utc_month: utcMonth,
      },
      created_at: clock.db_now,
    });
    const value = await loadFusionReservation(query, input.reservation_id.trim());
    if (!value) throw new Error('overseer_control_plane_fusion_reservation_insert_missing');
    return { ok: true, created: true, value };
  });
}

export async function markFusionBudgetCallStarted(
  input: FusionBudgetIdentityInput
): Promise<OverseerControlPlaneResult<FusionBudgetReservation>> {
  if (!exactKeys(input, ['reservation_id', 'call_id'])) {
    return { ok: false, code: 'unknown_field' };
  }
  const database = getDatabase();
  return withSerializedTransaction(database, 'overseer-control:fusion-budget', async query => {
    const reservation = await loadFusionReservation(query, input.reservation_id);
    if (!reservation) return { ok: false, code: 'budget_reservation_not_found' };
    if (reservation.call_id !== input.call_id) {
      return { ok: false, code: 'budget_reservation_stale' };
    }
    if (reservation.status === 'IN_FLIGHT') return { ok: true, value: reservation };
    if (reservation.status !== 'RESERVED') {
      return { ok: false, code: 'budget_transition_invalid' };
    }
    const clock = await databaseClock(query, database.dialect);
    const changed = await query(
      `UPDATE overseer_fusion_budget_reservations SET status='IN_FLIGHT',call_started_at=$1
       WHERE reservation_id=$2 AND call_id=$3 AND status='RESERVED'`,
      [clock.db_now, input.reservation_id, input.call_id]
    );
    if (changed.rowCount !== 1) return { ok: false, code: 'budget_transition_invalid' };
    await appendControlEvent(query, {
      resource_kind: 'FUSION_BUDGET',
      resource_key: input.reservation_id,
      event_kind: 'BUDGET_CALL_STARTED',
      actor: reservation.execution_id,
      evidence: { call_id: input.call_id },
      created_at: clock.db_now,
    });
    const value = await loadFusionReservation(query, input.reservation_id);
    if (!value) throw new Error('overseer_control_plane_fusion_start_missing');
    return { ok: true, value };
  });
}

export async function reconcileFusionBudget(
  input: ReconcileFusionBudgetInput
): Promise<OverseerControlPlaneResult<FusionBudgetReservation>> {
  if (!exactKeys(input, ['reservation_id', 'call_id', 'actual_microusd'])) {
    return { ok: false, code: 'unknown_field' };
  }
  if (!Number.isInteger(input.actual_microusd) || input.actual_microusd < 0) {
    return { ok: false, code: 'budget_transition_invalid' };
  }
  const database = getDatabase();
  return withSerializedTransaction(database, 'overseer-control:fusion-budget', async query => {
    const reservation = await loadFusionReservation(query, input.reservation_id);
    if (!reservation) return { ok: false, code: 'budget_reservation_not_found' };
    if (reservation.call_id !== input.call_id) {
      return { ok: false, code: 'budget_reservation_stale' };
    }
    if (reservation.status === 'RECONCILED') {
      return reservation.actual_microusd === input.actual_microusd
        ? { ok: true, value: reservation }
        : { ok: false, code: 'budget_transition_invalid' };
    }
    if (reservation.status !== 'IN_FLIGHT') {
      return { ok: false, code: 'budget_transition_invalid' };
    }
    const clock = await databaseClock(query, database.dialect);
    const changed = await query(
      `UPDATE overseer_fusion_budget_reservations
       SET status='RECONCILED',actual_microusd=$1,reconciled_at=$2
       WHERE reservation_id=$3 AND call_id=$4 AND status='IN_FLIGHT'`,
      [input.actual_microusd, clock.db_now, input.reservation_id, input.call_id]
    );
    if (changed.rowCount !== 1) return { ok: false, code: 'budget_transition_invalid' };
    const overage = input.actual_microusd > reservation.requested_microusd;
    await appendControlEvent(query, {
      resource_kind: 'FUSION_BUDGET',
      resource_key: input.reservation_id,
      event_kind: overage ? 'BUDGET_OVERAGE_RECORDED' : 'BUDGET_RECONCILED',
      actor: reservation.execution_id,
      evidence: {
        actual_microusd: input.actual_microusd,
        call_id: input.call_id,
        requested_microusd: reservation.requested_microusd,
      },
      created_at: clock.db_now,
    });
    if (overage) return { ok: false, code: 'budget_overage_recorded' };
    const value = await loadFusionReservation(query, input.reservation_id);
    if (!value) throw new Error('overseer_control_plane_fusion_reconciliation_missing');
    return { ok: true, value };
  });
}

export async function releaseFusionBudgetReservation(
  input: ReleaseFusionBudgetReservationInput
): Promise<OverseerControlPlaneResult<FusionBudgetReservation>> {
  if (!exactKeys(input, ['reservation_id', 'call_id', 'release_reason'])) {
    return { ok: false, code: 'unknown_field' };
  }
  const allowedReasons: readonly FusionBudgetReleaseReason[] = [
    'call_cancelled_before_start',
    'authorization_revoked_before_start',
    'provider_unavailable_before_start',
  ];
  if (!allowedReasons.includes(input.release_reason)) {
    return { ok: false, code: 'budget_transition_invalid' };
  }
  const database = getDatabase();
  return withSerializedTransaction(database, 'overseer-control:fusion-budget', async query => {
    const reservation = await loadFusionReservation(query, input.reservation_id);
    if (!reservation) return { ok: false, code: 'budget_reservation_not_found' };
    if (reservation.call_id !== input.call_id) {
      return { ok: false, code: 'budget_reservation_stale' };
    }
    if (reservation.status === 'RELEASED') {
      return reservation.release_reason === input.release_reason
        ? { ok: true, value: reservation }
        : { ok: false, code: 'budget_transition_invalid' };
    }
    if (reservation.status !== 'RESERVED') {
      return { ok: false, code: 'budget_transition_invalid' };
    }
    const clock = await databaseClock(query, database.dialect);
    const changed = await query(
      `UPDATE overseer_fusion_budget_reservations
       SET status='RELEASED',released_at=$1,release_reason=$2
       WHERE reservation_id=$3 AND call_id=$4 AND status='RESERVED'`,
      [clock.db_now, input.release_reason, input.reservation_id, input.call_id]
    );
    if (changed.rowCount !== 1) return { ok: false, code: 'budget_transition_invalid' };
    await appendControlEvent(query, {
      resource_kind: 'FUSION_BUDGET',
      resource_key: input.reservation_id,
      event_kind: 'BUDGET_RELEASED',
      actor: reservation.execution_id,
      evidence: { call_id: input.call_id, release_reason: input.release_reason },
      created_at: clock.db_now,
    });
    const value = await loadFusionReservation(query, input.reservation_id);
    if (!value) throw new Error('overseer_control_plane_fusion_release_missing');
    return { ok: true, value };
  });
}

export async function listOverseerControlEvents(
  filter: ListOverseerControlEventsFilter = {}
): Promise<readonly OverseerControlEvent[]> {
  if (!Object.keys(filter).every(key => key === 'resource_kind' || key === 'resource_key')) {
    return [];
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.resource_kind) {
    params.push(filter.resource_kind);
    clauses.push(`resource_kind=$${params.length}`);
  }
  if (filter.resource_key) {
    params.push(filter.resource_key);
    clauses.push(`resource_key=$${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  type Row = Omit<OverseerControlEvent, 'evidence_json' | 'event_sequence'> & {
    readonly evidence_json: unknown;
    readonly event_sequence: number | string;
  };
  const rows = await getDatabase().query<Row>(
    `SELECT * FROM overseer_control_events ${where}
     ORDER BY resource_kind,resource_key,event_sequence`,
    params
  );
  return rows.rows.map(row => ({
    ...row,
    event_sequence: Number(row.event_sequence),
    created_at: timestamp(row.created_at),
    evidence_json:
      typeof row.evidence_json === 'string'
        ? parseDatabaseJson(row.evidence_json)
        : row.evidence_json,
  }));
}

export type { QueryResult };
