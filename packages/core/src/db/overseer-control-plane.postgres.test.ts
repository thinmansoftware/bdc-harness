import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { PostgresAdapter } from './adapters/postgres';

let primary: PostgresAdapter;
let secondary: PostgresAdapter;
let activeDatabase: PostgresAdapter;
mock.module('./connection', () => ({ getDatabase: () => activeDatabase }));

import {
  acquireRepositoryMutationLease,
  admitOverseerParent,
  heartbeatOverseerParent,
  heartbeatRepositoryMutationLease,
  linkOverseerChild,
  listOverseerControlEvents,
  markFusionBudgetCallStarted,
  reconcileFusionBudget,
  reserveFusionBudget,
  transitionOverseerChildState,
} from './overseer-control-plane';

beforeAll(async () => {
  const url = process.env.OVERSEER_CONTROL_PLANE_TEST_DATABASE_URL;
  if (!url) throw new Error('OVERSEER_CONTROL_PLANE_TEST_DATABASE_URL is required');
  primary = new PostgresAdapter(url);
  secondary = new PostgresAdapter(url);
  activeDatabase = primary;
  if (primary.dialect !== 'postgres' || secondary.dialect !== 'postgres') {
    throw new Error('Overseer control-plane test silently selected non-PostgreSQL');
  }
  await primary.query(`TRUNCATE TABLE
    overseer_control_events,
    overseer_fusion_budget_reservations,
    overseer_verifier_entries,
    overseer_verifier_registries,
    overseer_repository_mutation_leases,
    overseer_parent_children,
    overseer_parent_commitments`);
});

afterAll(async () => {
  await Promise.all([primary.close(), secondary.close()]);
});

describe('Overseer control-plane PostgreSQL 17 behavior', () => {
  test('real PostgreSQL has seven exact tables and rejects forbidden mutation', async () => {
    const version = await primary.query<{ server_version: string }>('SHOW server_version');
    expect(version.rows[0]?.server_version.startsWith('17.')).toBe(true);
    const tables = await primary.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN (
        'overseer_parent_commitments','overseer_parent_children',
        'overseer_repository_mutation_leases','overseer_verifier_registries',
        'overseer_verifier_entries','overseer_fusion_budget_reservations',
        'overseer_control_events'
       ) ORDER BY table_name`
    );
    expect(tables.rows).toHaveLength(7);
    await expect(
      primary.query(
        "INSERT INTO overseer_control_events(event_id,resource_kind,resource_key,event_kind,actor,event_sequence,evidence_json,previous_event_digest,event_digest,created_at) VALUES ('ocp-event-invalid','PARENT','p','ADMITTED','a',2,'{}',NULL,$1,clock_timestamp())",
        ['0'.repeat(64)]
      )
    ).rejects.toThrow();
  });

  test('independent PostgreSQL connections enforce parent admission and fixed database TTL', async () => {
    const pending = Array.from({ length: 20 }, (_, index) => {
      activeDatabase = index % 2 === 0 ? primary : secondary;
      return admitOverseerParent({
        parent_id: `pg-parent-${index}`,
        owner_id: `pg-owner-${index}`,
        correlation_id: `pg-correlation-${index}`,
        state: 'BUILDING',
      });
    });
    const results = await Promise.all(pending);
    expect(results.filter(result => result.ok)).toHaveLength(10);
    expect(
      results.filter(result => !result.ok && result.code === 'parent_capacity_reached')
    ).toHaveLength(10);
    const admitted = results.find(result => result.ok);
    if (!admitted?.ok) throw new Error('expected PostgreSQL parent admission');
    activeDatabase = secondary;
    const heartbeat = await heartbeatOverseerParent({
      parent_id: admitted.value.parent_id,
      owner_id: admitted.value.owner_id,
      fencing_token: admitted.value.fencing_token,
    });
    expect(heartbeat.ok).toBe(true);
    if (!heartbeat.ok) throw new Error(heartbeat.code);
    expect(
      Date.parse(heartbeat.value.lease_expires_at) - Date.parse(heartbeat.value.heartbeat_at)
    ).toBe(300_000);
  });

  test('repository and Fusion global locks produce one safe outcome', async () => {
    activeDatabase = primary;
    const firstLease = acquireRepositoryMutationLease({
      repository: 'pg/org/repo',
      lease_id: 'pg-lease-a',
      owner_id: 'pg-owner-a',
      execution_id: 'pg-execution-a',
      action_kind: 'REBASE',
      capability: 'overseer.branch',
    });
    activeDatabase = secondary;
    const secondLease = acquireRepositoryMutationLease({
      repository: 'pg/org/repo',
      lease_id: 'pg-lease-b',
      owner_id: 'pg-owner-b',
      execution_id: 'pg-execution-b',
      action_kind: 'REBASE',
      capability: 'overseer.branch',
    });
    const leases = await Promise.all([firstLease, secondLease]);
    expect(leases.filter(result => result.ok)).toHaveLength(1);
    expect(leases.filter(result => !result.ok && result.code === 'lease_conflict')).toHaveLength(1);

    const reservations = Array.from({ length: 7 }, (_, index) => {
      activeDatabase = index % 2 === 0 ? primary : secondary;
      return reserveFusionBudget({
        reservation_id: `pg-reservation-${index}`,
        call_id: `pg-call-${index}`,
        proposal_id: `pg-proposal-${index}`,
        execution_id: `pg-budget-execution-${index}`,
        provider: 'fake',
        model: 'fake-model',
        call_kind: index % 2 === 0 ? 'PRIMARY' : 'RETRY',
        requested_microusd: 3_000_000,
      });
    });
    const budget = await Promise.all(reservations);
    expect(budget.filter(result => result.ok)).toHaveLength(6);
    expect(
      budget.filter(result => !result.ok && result.code === 'budget_cap_exceeded')
    ).toHaveLength(1);

    activeDatabase = primary;
    expect(
      await markFusionBudgetCallStarted({
        reservation_id: 'pg-reservation-0',
        call_id: 'pg-call-0',
      })
    ).toMatchObject({ ok: true });
    expect(
      await reconcileFusionBudget({
        reservation_id: 'pg-reservation-0',
        call_id: 'pg-call-0',
        actual_microusd: 3_500_000,
      })
    ).toEqual({ ok: false, code: 'budget_overage_recorded' });
    const events = await listOverseerControlEvents({
      resource_kind: 'FUSION_BUDGET',
      resource_key: 'pg-reservation-0',
    });
    expect(events.map(event => event.event_sequence)).toEqual([1, 2, 3]);
    expect(events[0]?.previous_event_digest).toBeNull();
    expect(events[1]?.previous_event_digest).toBe(events[0]?.event_digest);
    expect(events[2]?.previous_event_digest).toBe(events[1]?.event_digest);
  });

  test('PostgreSQL rejects direct mutable-row updates while named CAS transitions remain usable', async () => {
    await primary.query(`TRUNCATE TABLE
      overseer_control_events,
      overseer_fusion_budget_reservations,
      overseer_verifier_entries,
      overseer_verifier_registries,
      overseer_repository_mutation_leases,
      overseer_parent_children,
      overseer_parent_commitments`);
    activeDatabase = primary;
    const parent = await admitOverseerParent({
      parent_id: 'pg-guard-parent',
      owner_id: 'pg-guard-owner',
      correlation_id: 'pg-guard-correlation',
      state: 'BUILDING',
    });
    if (!parent.ok) throw new Error(parent.code);
    await linkOverseerChild({
      parent_id: 'pg-guard-parent',
      child_id: 'pg-guard-child',
      owner_id: 'pg-guard-owner',
      fencing_token: parent.value.fencing_token,
    });
    const lease = await acquireRepositoryMutationLease({
      repository: 'pg-guard/repo',
      lease_id: 'pg-guard-lease',
      owner_id: 'pg-guard-owner',
      execution_id: 'pg-guard-execution',
      action_kind: 'REBASE',
      capability: 'overseer.branch',
    });
    if (!lease.ok) throw new Error(lease.code);
    const reservation = await reserveFusionBudget({
      reservation_id: 'pg-guard-reservation',
      call_id: 'pg-guard-call',
      proposal_id: 'pg-guard-proposal',
      execution_id: 'pg-guard-execution',
      provider: 'fake',
      model: 'fake-model',
      call_kind: 'PRIMARY',
      requested_microusd: 1,
    });
    if (!reservation.ok) throw new Error(reservation.code);

    const directUpdates = [
      "UPDATE overseer_parent_commitments SET owner_id='attacker' WHERE parent_id='pg-guard-parent'",
      "UPDATE overseer_parent_children SET created_at='2001-01-01T00:00:00Z' WHERE child_id='pg-guard-child'",
      "UPDATE overseer_repository_mutation_leases SET capability='attacker' WHERE repository='pg-guard/repo'",
      "UPDATE overseer_fusion_budget_reservations SET provider='attacker' WHERE reservation_id='pg-guard-reservation'",
    ];
    for (const sql of directUpdates) {
      await expect(primary.query(sql)).rejects.toThrow('rejects non-CAS update');
    }

    expect(
      await heartbeatOverseerParent({
        parent_id: 'pg-guard-parent',
        owner_id: 'pg-guard-owner',
        fencing_token: parent.value.fencing_token,
      })
    ).toMatchObject({ ok: true });
    expect(
      await transitionOverseerChildState({
        parent_id: 'pg-guard-parent',
        child_id: 'pg-guard-child',
        owner_id: 'pg-guard-owner',
        fencing_token: parent.value.fencing_token,
        state: 'RUNNING',
      })
    ).toMatchObject({ ok: true });
    expect(
      await heartbeatRepositoryMutationLease({
        repository: 'pg-guard/repo',
        lease_id: 'pg-guard-lease',
        owner_id: 'pg-guard-owner',
        execution_id: 'pg-guard-execution',
        fencing_token: lease.value.fencing_token,
      })
    ).toMatchObject({ ok: true });
    expect(
      await markFusionBudgetCallStarted({
        reservation_id: 'pg-guard-reservation',
        call_id: 'pg-guard-call',
      })
    ).toMatchObject({ ok: true });
  });
});
