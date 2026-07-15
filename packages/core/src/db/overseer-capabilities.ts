import { randomUUID } from 'crypto';
import { getDatabase } from './connection';
import type { IDatabase } from './adapters/types';

type TxQuery = Parameters<Parameters<IDatabase['withTransaction']>[0]>[0];

export const OVERSEER_CAPABILITIES = [
  'escalation',
  'repair',
  'branch',
  'lifecycle',
  'merge',
] as const;

export type OverseerCapability = (typeof OVERSEER_CAPABILITIES)[number];

export const OVERSEER_CAPABILITY_EVENT_TYPES = [
  'gate_allowed',
  'gate_denied',
  'circuit_opened',
  'circuit_reset',
  'adapter_attempt',
] as const;

export type OverseerCapabilityEventType = (typeof OVERSEER_CAPABILITY_EVENT_TYPES)[number];
export type OverseerCircuitState = 'closed' | 'open';

export interface OverseerCapabilityState {
  readonly capability: OverseerCapability;
  readonly action_enabled: boolean;
  readonly circuit_state: OverseerCircuitState;
  readonly circuit_reason: string | null;
  readonly circuit_opened_at: string | null;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly updated_at: string;
  readonly updated_by: string;
}

export interface OverseerCapabilityEvent {
  readonly event_id: string;
  readonly capability: OverseerCapability;
  readonly event_type: OverseerCapabilityEventType;
  readonly reason: string;
  readonly actor: string;
  readonly correlation_id: string;
  readonly proposal_id: string | null;
  readonly execution_id: string | null;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly details: Record<string, unknown>;
  readonly created_at: string;
}

export interface AppendOverseerCapabilityEventInput {
  readonly event_id?: string;
  readonly capability: string;
  readonly event_type: string;
  readonly reason: string;
  readonly actor: string;
  readonly correlation_id: string;
  readonly proposal_id?: string | null;
  readonly execution_id?: string | null;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly details?: Record<string, unknown>;
}

export interface OpenOverseerCapabilityCircuitInput {
  readonly event_id?: string;
  readonly capability: string;
  readonly reason: string;
  readonly actor: string;
  readonly correlation_id: string;
  readonly proposal_id?: string | null;
  readonly execution_id?: string | null;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly details?: Record<string, unknown>;
}

export interface OpenOverseerCapabilityCircuitResult {
  readonly state: OverseerCapabilityState;
  readonly event: OverseerCapabilityEvent;
}

interface CapabilityStateRow {
  readonly capability: string;
  readonly action_enabled: boolean | number | string;
  readonly circuit_state: string;
  readonly circuit_reason: string | null;
  readonly circuit_opened_at: Date | string | null;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly updated_at: Date | string;
  readonly updated_by: string;
}

interface CapabilityEventRow {
  readonly event_id: string;
  readonly capability: string;
  readonly event_type: string;
  readonly reason: string;
  readonly actor: string;
  readonly correlation_id: string;
  readonly proposal_id: string | null;
  readonly execution_id: string | null;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly details_json: unknown;
  readonly created_at: Date | string;
}

function isOverseerCapability(value: string): value is OverseerCapability {
  return (OVERSEER_CAPABILITIES as readonly string[]).includes(value);
}

function requireCapability(value: string): OverseerCapability {
  if (!isOverseerCapability(value)) {
    throw new Error(`unknown_overseer_capability:${value}`);
  }
  return value;
}

function isEventType(value: string): value is OverseerCapabilityEventType {
  return (OVERSEER_CAPABILITY_EVENT_TYPES as readonly string[]).includes(value);
}

function requireEventType(value: string): OverseerCapabilityEventType {
  if (!isEventType(value)) {
    throw new Error(`invalid_overseer_capability_event_type:${value}`);
  }
  return value;
}

function requireDigest(name: string, value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name}_must_be_lower_case_64-hex`);
  }
}

function validateEventInput(input: AppendOverseerCapabilityEventInput): void {
  requireCapability(input.capability);
  const eventType = requireEventType(input.event_type);
  if (eventType === 'circuit_opened' || eventType === 'circuit_reset') {
    throw new Error(`transition_event_requires_atomic_operation:${eventType}`);
  }
  requireDigest('policy_digest', input.policy_digest);
  requireDigest('verifier_registry_digest', input.verifier_registry_digest);
}

function toBoolean(value: boolean | number | string): boolean {
  if (typeof value === 'boolean') return value;
  return Number(value) === 1;
}

function parseDetails(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function normalizeTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error('invalid_overseer_capability_timestamp');
  }
  return timestamp.toISOString();
}

function normalizeState(row: CapabilityStateRow): OverseerCapabilityState {
  return {
    capability: requireCapability(row.capability),
    action_enabled: toBoolean(row.action_enabled),
    circuit_state: row.circuit_state === 'open' ? 'open' : 'closed',
    circuit_reason: row.circuit_reason,
    circuit_opened_at:
      row.circuit_opened_at === null ? null : normalizeTimestamp(row.circuit_opened_at),
    policy_digest: row.policy_digest,
    verifier_registry_digest: row.verifier_registry_digest,
    updated_at: normalizeTimestamp(row.updated_at),
    updated_by: row.updated_by,
  };
}

function normalizeEvent(row: CapabilityEventRow): OverseerCapabilityEvent {
  return {
    event_id: row.event_id,
    capability: requireCapability(row.capability),
    event_type: requireEventType(row.event_type),
    reason: row.reason,
    actor: row.actor,
    correlation_id: row.correlation_id,
    proposal_id: row.proposal_id,
    execution_id: row.execution_id,
    policy_digest: row.policy_digest,
    verifier_registry_digest: row.verifier_registry_digest,
    details: parseDetails(row.details_json),
    created_at: normalizeTimestamp(row.created_at),
  };
}

async function txNow(query: TxQuery): Promise<string> {
  const sql =
    getDatabase().dialect === 'sqlite'
      ? "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now"
      : 'SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS now';
  const result = await query<{ now: string }>(sql);
  const now = result.rows[0]?.now;
  if (!now) throw new Error('overseer_capability_database_clock_unavailable');
  return now;
}

async function selectState(
  query: TxQuery,
  capability: OverseerCapability
): Promise<OverseerCapabilityState | null> {
  const result = await query<CapabilityStateRow>(
    'SELECT * FROM overseer_capability_state WHERE capability = $1',
    [capability]
  );
  return result.rows[0] ? normalizeState(result.rows[0]) : null;
}

async function appendEventWithQuery(
  query: TxQuery,
  input: AppendOverseerCapabilityEventInput,
  createdAt: string
): Promise<OverseerCapabilityEvent> {
  const eventId = input.event_id ?? randomUUID();
  await query(
    `INSERT INTO overseer_capability_events (
       event_id, capability, event_type, reason, actor, correlation_id,
       proposal_id, execution_id, policy_digest, verifier_registry_digest,
       details_json, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      eventId,
      input.capability,
      input.event_type,
      input.reason,
      input.actor,
      input.correlation_id,
      input.proposal_id ?? null,
      input.execution_id ?? null,
      input.policy_digest,
      input.verifier_registry_digest,
      JSON.stringify(input.details ?? {}),
      createdAt,
    ]
  );
  const result = await query<CapabilityEventRow>(
    'SELECT * FROM overseer_capability_events WHERE event_id = $1',
    [eventId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('overseer_capability_event_insert_failed');
  return normalizeEvent(row);
}

export async function getOverseerCapabilityState(
  capability: string
): Promise<OverseerCapabilityState | null> {
  const knownCapability = requireCapability(capability);
  const db = getDatabase();
  return selectState(db.query.bind(db), knownCapability);
}

export async function listOverseerCapabilityStates(): Promise<OverseerCapabilityState[]> {
  const result = await getDatabase().query<CapabilityStateRow>(
    `SELECT * FROM overseer_capability_state
     ORDER BY CASE capability
       WHEN 'escalation' THEN 0
       WHEN 'repair' THEN 1
       WHEN 'branch' THEN 2
       WHEN 'lifecycle' THEN 3
       WHEN 'merge' THEN 4
       ELSE 5
     END`
  );
  return result.rows.map(normalizeState);
}

export async function appendOverseerCapabilityEvent(
  input: AppendOverseerCapabilityEventInput
): Promise<OverseerCapabilityEvent> {
  validateEventInput(input);
  const db = getDatabase();
  return db.withTransaction(async query => appendEventWithQuery(query, input, await txNow(query)));
}

export async function listOverseerCapabilityEvents(
  capability?: string
): Promise<OverseerCapabilityEvent[]> {
  const db = getDatabase();
  const result = capability
    ? await db.query<CapabilityEventRow>(
        'SELECT * FROM overseer_capability_events WHERE capability = $1 ORDER BY created_at, event_id',
        [requireCapability(capability)]
      )
    : await db.query<CapabilityEventRow>(
        'SELECT * FROM overseer_capability_events ORDER BY created_at, event_id'
      );
  return result.rows.map(normalizeEvent);
}

export async function openOverseerCapabilityCircuit(
  input: OpenOverseerCapabilityCircuitInput
): Promise<OpenOverseerCapabilityCircuitResult> {
  const capability = requireCapability(input.capability);
  requireDigest('policy_digest', input.policy_digest);
  requireDigest('verifier_registry_digest', input.verifier_registry_digest);

  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = await txNow(query);
    const updated = await query(
      `UPDATE overseer_capability_state
       SET action_enabled = FALSE, circuit_state = 'open', circuit_reason = $1,
           circuit_opened_at = $2, policy_digest = $3, verifier_registry_digest = $4,
           updated_at = $2, updated_by = $5
       WHERE capability = $6`,
      [
        input.reason,
        now,
        input.policy_digest,
        input.verifier_registry_digest,
        input.actor,
        capability,
      ]
    );
    if (updated.rowCount !== 1) {
      throw new Error(`overseer_capability_state_missing:${capability}`);
    }

    const event = await appendEventWithQuery(
      query,
      {
        ...input,
        capability,
        event_type: 'circuit_opened',
      },
      now
    );
    const state = await selectState(query, capability);
    if (!state) throw new Error(`overseer_capability_state_missing:${capability}`);
    return { state, event };
  });
}
