import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';

let db: SqliteAdapter;
let currentDbPath = '';

mock.module('./connection', () => ({
  getDatabase: () => db,
}));

import {
  OVERSEER_CAPABILITIES,
  appendOverseerCapabilityEvent,
  getOverseerCapabilityState,
  listOverseerCapabilityEvents,
  listOverseerCapabilityStates,
  openOverseerCapabilityCircuit,
} from './overseer-capabilities';

const POLICY_DIGEST = 'a'.repeat(64);
const VERIFIER_DIGEST = 'b'.repeat(64);
const ZERO_DIGEST = '0'.repeat(64);

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // File may not exist.
    }
  }
}

function eventInput(overrides: Record<string, unknown> = {}): {
  event_id?: string;
  capability: string;
  event_type: string;
  reason: string;
  actor: string;
  correlation_id: string;
  proposal_id?: string | null;
  execution_id?: string | null;
  policy_digest: string;
  verifier_registry_digest: string;
  details?: Record<string, unknown>;
} {
  return {
    capability: 'merge',
    event_type: 'gate_denied',
    reason: 'default-disabled',
    actor: 'test-operator',
    correlation_id: 'corr-1',
    policy_digest: POLICY_DIGEST,
    verifier_registry_digest: VERIFIER_DIGEST,
    details: { source: 'unit-test' },
    ...overrides,
  };
}

describe('overseer capability persistence (sqlite)', () => {
  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-overseer-capabilities-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('seeds exactly five disabled and closed capability states in deterministic order', async () => {
    const states = await listOverseerCapabilityStates();

    expect(states.map(state => state.capability)).toEqual([...OVERSEER_CAPABILITIES]);
    expect(states).toHaveLength(5);
    for (const state of states) {
      expect(state.action_enabled).toBe(false);
      expect(state.circuit_state).toBe('closed');
      expect(state.circuit_reason).toBeNull();
      expect(state.circuit_opened_at).toBeNull();
      expect(state.policy_digest).toBe(ZERO_DIGEST);
      expect(state.verifier_registry_digest).toBe(ZERO_DIGEST);
      expect(state.updated_by).toBe('migration-034');
      expect(state.updated_at).toBeString();
    }

    expect((await getOverseerCapabilityState('merge'))?.capability).toBe('merge');
  });

  test('keeps PostgreSQL migration and SQLite schema logically equivalent', async () => {
    const migration = readFileSync(
      join(import.meta.dir, '../../../../migrations/034_overseer_capability_state.sql'),
      'utf8'
    );
    const sqlite = readFileSync(join(import.meta.dir, 'adapters/sqlite.ts'), 'utf8');
    const requiredStateColumns = [
      'capability',
      'action_enabled',
      'circuit_state',
      'circuit_reason',
      'circuit_opened_at',
      'policy_digest',
      'verifier_registry_digest',
      'updated_at',
      'updated_by',
    ];
    const requiredEventColumns = [
      'event_id',
      'capability',
      'event_type',
      'reason',
      'actor',
      'correlation_id',
      'proposal_id',
      'execution_id',
      'policy_digest',
      'verifier_registry_digest',
      'details_json',
      'created_at',
    ];

    for (const schema of [migration, sqlite]) {
      expect(schema).toContain('CREATE TABLE IF NOT EXISTS overseer_capability_state');
      expect(schema).toContain('CREATE TABLE IF NOT EXISTS overseer_capability_events');
      expect(schema).toContain('trg_overseer_capability_events_no_update');
      expect(schema).toContain('trg_overseer_capability_events_no_delete');
      for (const capability of OVERSEER_CAPABILITIES) expect(schema).toContain(`'${capability}'`);
      for (const eventType of [
        'gate_allowed',
        'gate_denied',
        'circuit_opened',
        'circuit_reset',
        'adapter_attempt',
      ]) {
        expect(schema).toContain(`'${eventType}'`);
      }
      for (const column of [...requiredStateColumns, ...requiredEventColumns]) {
        expect(schema).toContain(column);
      }
      expect(schema).toContain("circuit_state IN ('closed', 'open')");
      expect(schema).toContain(
        'proposal_id TEXT REFERENCES overseer_m31_action_proposals(proposal_id)'
      );
      expect(schema).toContain(
        'execution_id TEXT REFERENCES overseer_m31_action_proposals(execution_id)'
      );
    }

    expect(migration).toContain('action_enabled BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migration).toContain("policy_digest ~ '^[0-9a-f]{64}$'");
    expect(sqlite).toContain("length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'");

    const stateColumns = await db.query<{ name: string }>(
      "SELECT name FROM pragma_table_info('overseer_capability_state') ORDER BY cid"
    );
    expect(stateColumns.rows.map(row => row.name)).toEqual(requiredStateColumns);
    const eventColumns = await db.query<{ name: string }>(
      "SELECT name FROM pragma_table_info('overseer_capability_events') ORDER BY cid"
    );
    expect(eventColumns.rows.map(row => row.name)).toEqual(requiredEventColumns);
  });

  test('appends and reads an immutable capability event', async () => {
    const appended = await appendOverseerCapabilityEvent(eventInput());
    const events = await listOverseerCapabilityEvents('merge');

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(appended);
    expect(appended.event_type).toBe('gate_denied');
    expect(appended.details).toEqual({ source: 'unit-test' });
    expect(appended.proposal_id).toBeNull();
    expect(appended.execution_id).toBeNull();
    expect(appended.created_at).toBeString();

    await expect(
      db.query('UPDATE overseer_capability_events SET reason = $1', ['tamper'])
    ).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM overseer_capability_events')).rejects.toThrow(/append-only/);
  });

  test('opens only the requested circuit and appends its circuit_opened event', async () => {
    const opened = await openOverseerCapabilityCircuit({
      event_id: 'open-repair-1',
      capability: 'repair',
      reason: 'verifier-failure',
      actor: 'test-operator',
      correlation_id: 'corr-open-1',
      policy_digest: POLICY_DIGEST,
      verifier_registry_digest: VERIFIER_DIGEST,
      details: { verifier: 'test' },
    });

    expect(opened.state.circuit_state).toBe('open');
    expect(opened.state.action_enabled).toBe(false);
    expect(opened.state.circuit_reason).toBe('verifier-failure');
    expect(opened.state.updated_by).toBe('test-operator');
    expect(opened.event.event_type).toBe('circuit_opened');
    expect(opened.event.capability).toBe('repair');

    const states = await listOverseerCapabilityStates();
    expect(
      states.filter(state => state.circuit_state === 'open').map(state => state.capability)
    ).toEqual(['repair']);
    expect(await listOverseerCapabilityEvents('repair')).toHaveLength(1);
    expect(await listOverseerCapabilityEvents('merge')).toHaveLength(0);
  });

  test('rolls back circuit state when its event append fails', async () => {
    await appendOverseerCapabilityEvent(eventInput({ event_id: 'duplicate-event' }));

    await expect(
      openOverseerCapabilityCircuit({
        event_id: 'duplicate-event',
        capability: 'merge',
        reason: 'must-roll-back',
        actor: 'test-operator',
        correlation_id: 'corr-open-fail',
        policy_digest: POLICY_DIGEST,
        verifier_registry_digest: VERIFIER_DIGEST,
      })
    ).rejects.toThrow();

    const state = await getOverseerCapabilityState('merge');
    expect(state?.circuit_state).toBe('closed');
    expect(state?.circuit_reason).toBeNull();
    expect(state?.updated_by).toBe('migration-034');
    expect(await listOverseerCapabilityEvents('merge')).toHaveLength(1);
  });

  test('fails closed before writes for unknown vocabulary and malformed digests', async () => {
    await expect(getOverseerCapabilityState('unknown')).rejects.toThrow(/unknown.*capability/i);
    await expect(
      appendOverseerCapabilityEvent(eventInput({ capability: 'unknown' }))
    ).rejects.toThrow(/unknown.*capability/i);
    await expect(
      appendOverseerCapabilityEvent(eventInput({ event_type: 'made_up' }))
    ).rejects.toThrow(/invalid.*event/i);
    await expect(
      appendOverseerCapabilityEvent(eventInput({ policy_digest: 'ABC' }))
    ).rejects.toThrow(/policy_digest.*64-hex/i);
    await expect(
      openOverseerCapabilityCircuit({
        capability: 'merge',
        reason: 'bad-digest',
        actor: 'test-operator',
        correlation_id: 'corr-bad-digest',
        policy_digest: POLICY_DIGEST,
        verifier_registry_digest: 'short',
      })
    ).rejects.toThrow(/verifier_registry_digest.*64-hex/i);

    expect(await listOverseerCapabilityEvents('merge')).toHaveLength(0);
    expect((await getOverseerCapabilityState('merge'))?.circuit_state).toBe('closed');
  });
});
