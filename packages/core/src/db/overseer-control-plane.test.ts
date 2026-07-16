import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';
import {
  installOverseerControlPlaneSqlite,
  withOverseerControlPlaneImmediateTransaction,
} from './overseer-control-plane-sqlite';

let database: SqliteAdapter;
let databasePath = '';
mock.module('./connection', () => ({ getDatabase: () => database }));

import {
  admitOverseerParent,
  acquireRepositoryMutationLease,
  assertIndependentVerifier,
  computeVerifierRegistryDigest,
  heartbeatRepositoryMutationLease,
  heartbeatOverseerParent,
  markFusionBudgetCallStarted,
  linkOverseerChild,
  reconcileExpiredParentCommitments,
  reconcileFusionBudget,
  registerVerifierRegistry,
  releaseFusionBudgetReservation,
  releaseOverseerParent,
  releaseRepositoryMutationLease,
  reserveFusionBudget,
  transitionOverseerChildState,
} from './overseer-control-plane';

beforeEach(async () => {
  databasePath = join(process.cwd(), `.overseer-control-plane-${crypto.randomUUID()}.db`);
  database = new SqliteAdapter(databasePath);
  await installOverseerControlPlaneSqlite(database);
});

afterEach(async () => {
  await database.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${databasePath}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
});

describe('Overseer control-plane persistence', () => {
  test('parent admission cap, child state, and crash recovery', async () => {
    const tables = await database.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (
        'overseer_control_events','overseer_fusion_budget_reservations',
        'overseer_parent_children','overseer_parent_commitments',
        'overseer_repository_mutation_leases','overseer_verifier_entries',
        'overseer_verifier_registries'
      ) ORDER BY name`
    );
    expect(tables.rows.map(row => row.name)).toEqual([
      'overseer_control_events',
      'overseer_fusion_budget_reservations',
      'overseer_parent_children',
      'overseer_parent_commitments',
      'overseer_repository_mutation_leases',
      'overseer_verifier_entries',
      'overseer_verifier_registries',
    ]);

    const admissions = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        admitOverseerParent({
          parent_id: `parent-${index}`,
          owner_id: `owner-${index}`,
          correlation_id: `correlation-${index}`,
          state: 'BUILDING',
        })
      )
    );
    expect(admissions.filter(result => result.ok)).toHaveLength(10);
    expect(
      admissions.filter(result => !result.ok && result.code === 'parent_capacity_reached')
    ).toHaveLength(10);
    const admitted = admissions.find(result => result.ok);
    if (!admitted?.ok) throw new Error('expected admitted parent');
    expect(admitted.created).toBe(true);
    expect(
      await admitOverseerParent({
        parent_id: admitted.value.parent_id,
        owner_id: admitted.value.owner_id,
        correlation_id: admitted.value.correlation_id,
        state: admitted.value.state as 'BUILDING',
      })
    ).toMatchObject({ ok: true, created: false, value: { parent_id: admitted.value.parent_id } });

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

    expect(
      await linkOverseerChild({
        parent_id: 'missing',
        child_id: 'orphan',
        owner_id: 'owner',
        fencing_token: 1,
      })
    ).toEqual({ ok: false, code: 'child_orphaned' });
    const linked = await linkOverseerChild({
      parent_id: admitted.value.parent_id,
      child_id: 'child-1',
      owner_id: admitted.value.owner_id,
      fencing_token: admitted.value.fencing_token,
    });
    expect(linked).toMatchObject({ ok: true, created: true });
    expect(
      await linkOverseerChild({
        parent_id: admitted.value.parent_id,
        child_id: 'child-1',
        owner_id: admitted.value.owner_id,
        fencing_token: admitted.value.fencing_token,
      })
    ).toMatchObject({ ok: true, created: false, value: { child_id: 'child-1' } });
    expect(
      await transitionOverseerChildState({
        parent_id: admitted.value.parent_id,
        child_id: 'child-1',
        owner_id: admitted.value.owner_id,
        fencing_token: admitted.value.fencing_token,
        state: 'PENDING',
      })
    ).toEqual({ ok: false, code: 'child_transition_invalid' });
    expect(
      await releaseOverseerParent({
        parent_id: admitted.value.parent_id,
        owner_id: admitted.value.owner_id,
        fencing_token: admitted.value.fencing_token,
        state: 'COMPLETED',
        terminal_reason: 'complete',
      })
    ).toEqual({ ok: false, code: 'parent_children_active' });
    expect(
      await transitionOverseerChildState({
        parent_id: admitted.value.parent_id,
        child_id: 'child-1',
        owner_id: admitted.value.owner_id,
        fencing_token: admitted.value.fencing_token,
        state: 'COMPLETED',
      })
    ).toMatchObject({ ok: true });
    expect(
      await releaseOverseerParent({
        parent_id: admitted.value.parent_id,
        owner_id: admitted.value.owner_id,
        fencing_token: admitted.value.fencing_token,
        state: 'COMPLETED',
        terminal_reason: 'complete',
      })
    ).toMatchObject({ ok: true, value: { fencing_token: admitted.value.fencing_token + 1 } });
    expect(
      await heartbeatOverseerParent({
        parent_id: admitted.value.parent_id,
        owner_id: admitted.value.owner_id,
        fencing_token: admitted.value.fencing_token,
      })
    ).toEqual({ ok: false, code: 'parent_lease_stale' });

    await database.query(
      `INSERT INTO overseer_parent_commitments
       (parent_id,state,owner_id,correlation_id,fencing_token,admitted_at,heartbeat_at,lease_expires_at,released_at,terminal_reason)
       VALUES ('parent-crashed','RECOVERY','owner-crashed','correlation-crashed',1,
       '2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z','2000-01-01T00:05:00.000Z',NULL,NULL)`
    );
    await database.query(
      `INSERT INTO overseer_parent_children(parent_id,child_id,state,created_at,terminal_at)
       VALUES ('parent-crashed','child-crashed','PENDING','2000-01-01T00:00:00.000Z',NULL)`
    );
    const reconciled = await reconcileExpiredParentCommitments();
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw new Error(reconciled.code);
    expect(reconciled.value.reconciled_parent_ids).toEqual(['parent-crashed']);
    const crashParent = await database.query<{
      state: string;
      fencing_token: number;
      terminal_reason: string;
    }>(
      'SELECT state,fencing_token,terminal_reason FROM overseer_parent_commitments WHERE parent_id=$1',
      ['parent-crashed']
    );
    expect(crashParent.rows[0]).toEqual({
      state: 'FAILED',
      fencing_token: 2,
      terminal_reason: 'owner_lease_expired',
    });
    expect(
      await admitOverseerParent({
        parent_id: 'parent-waiting',
        owner_id: 'owner-waiting',
        correlation_id: 'correlation-waiting',
        state: 'BUILDING',
      })
    ).toMatchObject({ ok: true });
  });

  test('repository lease fencing and fixed TTL survive crash', async () => {
    const racers = await Promise.all([
      acquireRepositoryMutationLease({
        repository: 'org/repo',
        lease_id: 'lease-a',
        owner_id: 'owner-a',
        execution_id: 'execution-a',
        action_kind: 'REBASE',
        capability: 'overseer.branch',
      }),
      acquireRepositoryMutationLease({
        repository: 'org/repo',
        lease_id: 'lease-b',
        owner_id: 'owner-b',
        execution_id: 'execution-b',
        action_kind: 'REBASE',
        capability: 'overseer.branch',
      }),
    ]);
    expect(racers.filter(result => result.ok)).toHaveLength(1);
    expect(racers.filter(result => !result.ok && result.code === 'lease_conflict')).toHaveLength(1);
    const winner = racers.find(result => result.ok);
    const loser = racers.find(result => !result.ok);
    if (!winner?.ok || !loser || loser.ok) throw new Error('expected one lease winner and loser');
    expect(
      await acquireRepositoryMutationLease({
        repository: 'org/other',
        lease_id: 'lease-other',
        owner_id: 'owner-other',
        execution_id: 'execution-other',
        action_kind: 'MERGE',
        capability: 'overseer.merge',
      })
    ).toMatchObject({ ok: true, value: { fencing_token: 1 } });

    const heartbeat = await heartbeatRepositoryMutationLease({
      repository: winner.value.repository,
      lease_id: winner.value.lease_id,
      owner_id: winner.value.owner_id,
      execution_id: winner.value.execution_id,
      fencing_token: winner.value.fencing_token,
    });
    expect(heartbeat.ok).toBe(true);
    if (!heartbeat.ok) throw new Error(heartbeat.code);
    expect(Date.parse(heartbeat.value.expires_at) - Date.parse(heartbeat.value.heartbeat_at)).toBe(
      300_000
    );
    const beforeStale = await database.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM overseer_control_events WHERE resource_kind='REPOSITORY_LEASE' AND resource_key='org/repo'"
    );
    expect(
      await heartbeatRepositoryMutationLease({
        repository: winner.value.repository,
        lease_id: winner.value.lease_id,
        owner_id: winner.value.owner_id,
        execution_id: winner.value.execution_id,
        fencing_token: winner.value.fencing_token + 1,
      })
    ).toEqual({ ok: false, code: 'lease_stale' });
    const afterStale = await database.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM overseer_control_events WHERE resource_kind='REPOSITORY_LEASE' AND resource_key='org/repo'"
    );
    expect(Number(afterStale.rows[0]?.n)).toBe(Number(beforeStale.rows[0]?.n));

    await database.query(
      `INSERT INTO overseer_repository_mutation_leases
       (repository,lease_id,owner_id,execution_id,action_kind,capability,fencing_token,state,acquired_at,heartbeat_at,expires_at,released_at)
       VALUES ('org/expired','lease-expired','owner-expired','execution-expired','REBASE','overseer.branch',7,'ACTIVE',
       '2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z','2000-01-01T00:05:00.000Z',NULL)`
    );
    const takeover = await acquireRepositoryMutationLease({
      repository: 'org/expired',
      lease_id: loser.code === 'lease_conflict' ? 'lease-takeover' : 'impossible',
      owner_id: 'owner-takeover',
      execution_id: 'execution-takeover',
      action_kind: 'REBASE',
      capability: 'overseer.branch',
    });
    expect(takeover).toMatchObject({
      ok: true,
      value: { fencing_token: 8 },
    });
    if (!takeover.ok) throw new Error(takeover.code);
    expect(
      await releaseRepositoryMutationLease({
        repository: 'org/expired',
        lease_id: 'lease-expired',
        owner_id: 'owner-expired',
        execution_id: 'execution-expired',
        fencing_token: 7,
      })
    ).toEqual({ ok: false, code: 'lease_stale' });
    const released = await releaseRepositoryMutationLease({
      repository: takeover.value.repository,
      lease_id: takeover.value.lease_id,
      owner_id: takeover.value.owner_id,
      execution_id: takeover.value.execution_id,
      fencing_token: takeover.value.fencing_token,
    });
    expect(released).toMatchObject({ ok: true, value: { state: 'RELEASED' } });
    expect(
      await releaseRepositoryMutationLease({
        repository: takeover.value.repository,
        lease_id: takeover.value.lease_id,
        owner_id: takeover.value.owner_id,
        execution_id: takeover.value.execution_id,
        fencing_token: takeover.value.fencing_token,
      })
    ).toEqual(released);
  });

  test('verifier registry persists canonical content and rejects self-review', async () => {
    expect(computeVerifierRegistryDigest([])).toBe(
      '92db4bf943bc3b2e32d79c216b8638750864216a1d943aa3d4c763372ae9d56c'
    );
    const entries = [
      {
        verifier_id: 'fable.review',
        provider: 'anthropic',
        model_family: 'claude',
        roles: ['RED_TEAM', 'REVIEWER'] as const,
        enabled: true,
      },
      {
        verifier_id: 'grok.review',
        provider: 'xai',
        model_family: 'grok',
        roles: ['REVIEWER'] as const,
        enabled: true,
      },
    ];
    const digest = computeVerifierRegistryDigest(entries);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const registered = await registerVerifierRegistry({
      schema_version: 'overseer-verifier-registry-v1',
      registry_digest: digest,
      entries,
      source_artifact_path: 'artifacts/verifiers.json',
      source_git_blob: 'a'.repeat(40),
    });
    expect(registered).toMatchObject({
      ok: true,
      created: true,
      value: { registry_digest: digest },
    });
    expect(
      await registerVerifierRegistry({
        schema_version: 'overseer-verifier-registry-v1',
        registry_digest: digest,
        entries: [...entries].reverse(),
        source_artifact_path: 'artifacts/verifiers.json',
        source_git_blob: 'a'.repeat(40),
      })
    ).toMatchObject({ ok: true, created: false, value: { registry_digest: digest } });
    const eventCount = await database.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM overseer_control_events WHERE event_kind='REGISTRY_FROZEN'"
    );
    expect(Number(eventCount.rows[0]?.n)).toBe(1);
    expect(
      await registerVerifierRegistry({
        schema_version: 'overseer-verifier-registry-v1',
        registry_digest: digest,
        entries,
        source_artifact_path: 'artifacts/drift.json',
        source_git_blob: 'a'.repeat(40),
      })
    ).toEqual({ ok: false, code: 'registry_digest_conflict' });
    expect(
      await registerVerifierRegistry({
        schema_version: 'overseer-verifier-registry-v1',
        registry_digest: '0'.repeat(64),
        entries,
        source_artifact_path: 'artifacts/verifiers.json',
        source_git_blob: 'a'.repeat(40),
      })
    ).toEqual({ ok: false, code: 'registry_digest_mismatch' });

    expect(
      await assertIndependentVerifier({
        operator_provider: 'openai',
        operator_model_family: 'gpt',
        registry_digest: digest,
        verifier_id: 'fable.review',
        required_role: 'REVIEWER',
      })
    ).toMatchObject({ ok: true, value: { allowed: true } });
    expect(
      await assertIndependentVerifier({
        operator_provider: 'anthropic',
        operator_model_family: 'gpt',
        registry_digest: digest,
        verifier_id: 'fable.review',
        required_role: 'REVIEWER',
      })
    ).toEqual({ ok: false, code: 'verifier_not_independent' });
    expect(
      await assertIndependentVerifier({
        operator_provider: 'xai',
        operator_model_family: 'grok',
        registry_digest: digest,
        verifier_id: 'grok.review',
        required_role: 'REVIEWER',
      })
    ).toEqual({ ok: false, code: 'verifier_not_independent' });
    expect(
      await assertIndependentVerifier({
        operator_provider: 'openai',
        operator_model_family: 'gpt',
        registry_digest: digest,
        verifier_id: 'missing.review',
        required_role: 'REVIEWER',
      })
    ).toEqual({ ok: false, code: 'verifier_unknown' });
  });

  test('Fusion reservation lifecycle enforces all caps and overage stop', async () => {
    expect(
      await reserveFusionBudget({
        reservation_id: 'forged',
        call_id: 'forged',
        proposal_id: 'proposal-forged',
        execution_id: 'execution-forged',
        provider: 'fake',
        model: 'fake-model',
        call_kind: 'PRIMARY',
        requested_microusd: 1,
        utc_day: '2099-01-01',
      } as never)
    ).toEqual({ ok: false, code: 'unknown_field' });

    const cancellable = await reserveFusionBudget({
      reservation_id: 'reservation-cancel',
      call_id: 'call-cancel',
      proposal_id: 'proposal-cancel',
      execution_id: 'execution-cancel',
      provider: 'fake',
      model: 'fake-model',
      call_kind: 'INDIRECT',
      requested_microusd: 500_000,
    });
    expect(cancellable).toMatchObject({ ok: true, created: true, value: { status: 'RESERVED' } });
    expect(
      await reserveFusionBudget({
        reservation_id: 'reservation-cancel',
        call_id: 'call-cancel',
        proposal_id: 'proposal-cancel',
        execution_id: 'execution-cancel',
        provider: 'fake',
        model: 'fake-model',
        call_kind: 'INDIRECT',
        requested_microusd: 500_000,
      })
    ).toMatchObject({ ok: true, created: false, value: { status: 'RESERVED' } });
    expect(
      await releaseFusionBudgetReservation({
        reservation_id: 'reservation-cancel',
        call_id: 'call-cancel',
        release_reason: 'call_cancelled_before_start',
      })
    ).toMatchObject({ ok: true, value: { status: 'RELEASED' } });

    const callKinds = ['PRIMARY', 'RETRY', 'FALLBACK', 'INDIRECT', 'PRIMARY', 'RETRY'] as const;
    const reservations = await Promise.all(
      callKinds.map((callKind, index) =>
        reserveFusionBudget({
          reservation_id: `reservation-${index}`,
          call_id: `call-${index}`,
          proposal_id: `proposal-${index}`,
          execution_id: `execution-${index}`,
          provider: 'fake',
          model: 'fake-model',
          call_kind: callKind,
          requested_microusd: 3_000_000,
        })
      )
    );
    expect(reservations.every(result => result.ok)).toBe(true);
    const inFlight = await markFusionBudgetCallStarted({
      reservation_id: 'reservation-0',
      call_id: 'call-0',
    });
    expect(inFlight).toMatchObject({ ok: true, value: { status: 'IN_FLIGHT' } });
    expect(
      await releaseFusionBudgetReservation({
        reservation_id: 'reservation-0',
        call_id: 'call-0',
        release_reason: 'call_cancelled_before_start',
      })
    ).toEqual({ ok: false, code: 'budget_transition_invalid' });

    const overage = await reserveFusionBudget({
      reservation_id: 'reservation-overage',
      call_id: 'call-overage',
      proposal_id: 'proposal-overage',
      execution_id: 'execution-overage',
      provider: 'fake',
      model: 'fake-model',
      call_kind: 'FALLBACK',
      requested_microusd: 2_000_000,
    });
    expect(overage).toMatchObject({ ok: true, value: { status: 'RESERVED' } });
    expect(
      await markFusionBudgetCallStarted({
        reservation_id: 'reservation-overage',
        call_id: 'call-overage',
      })
    ).toMatchObject({ ok: true, value: { status: 'IN_FLIGHT' } });
    expect(
      await reconcileFusionBudget({
        reservation_id: 'reservation-overage',
        call_id: 'call-overage',
        actual_microusd: 4_000_000,
      })
    ).toEqual({ ok: false, code: 'budget_overage_recorded' });
    expect(
      await reserveFusionBudget({
        reservation_id: 'reservation-later',
        call_id: 'call-later',
        proposal_id: 'proposal-later',
        execution_id: 'execution-later',
        provider: 'fake',
        model: 'fake-model',
        call_kind: 'PRIMARY',
        requested_microusd: 1,
      })
    ).toEqual({ ok: false, code: 'budget_cap_exceeded' });

    const persisted = await database.query<{
      utc_day: string;
      utc_month: string;
      reserved_at: string;
      status: string;
      actual_microusd: number;
    }>(
      'SELECT utc_day,utc_month,reserved_at,status,actual_microusd FROM overseer_fusion_budget_reservations WHERE reservation_id=$1',
      ['reservation-overage']
    );
    expect(persisted.rows[0]).toMatchObject({
      utc_day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      utc_month: expect.stringMatching(/^\d{4}-\d{2}$/),
      reserved_at: expect.stringMatching(/Z$/),
      status: 'RECONCILED',
      actual_microusd: 4_000_000,
    });
    const overageEvents = await database.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM overseer_control_events WHERE event_kind='BUDGET_OVERAGE_RECORDED' AND resource_key='reservation-overage'"
    );
    expect(Number(overageEvents.rows[0]?.n)).toBe(1);
  });

  test('SQLite rejects direct mutable-row updates while named CAS transitions remain usable', async () => {
    const parent = await admitOverseerParent({
      parent_id: 'guard-parent',
      owner_id: 'guard-owner',
      correlation_id: 'guard-correlation',
      state: 'BUILDING',
    });
    if (!parent.ok) throw new Error(parent.code);
    await linkOverseerChild({
      parent_id: 'guard-parent',
      child_id: 'guard-child',
      owner_id: 'guard-owner',
      fencing_token: parent.value.fencing_token,
    });
    const lease = await acquireRepositoryMutationLease({
      repository: 'guard/repo',
      lease_id: 'guard-lease',
      owner_id: 'guard-owner',
      execution_id: 'guard-execution',
      action_kind: 'REBASE',
      capability: 'overseer.branch',
    });
    if (!lease.ok) throw new Error(lease.code);
    const reservation = await reserveFusionBudget({
      reservation_id: 'guard-reservation',
      call_id: 'guard-call',
      proposal_id: 'guard-proposal',
      execution_id: 'guard-execution',
      provider: 'fake',
      model: 'fake-model',
      call_kind: 'PRIMARY',
      requested_microusd: 1,
    });
    if (!reservation.ok) throw new Error(reservation.code);

    const directUpdates = [
      "UPDATE overseer_parent_commitments SET owner_id='attacker' WHERE parent_id='guard-parent'",
      "UPDATE overseer_parent_children SET created_at='2001-01-01T00:00:00.000Z' WHERE child_id='guard-child'",
      "UPDATE overseer_repository_mutation_leases SET capability='attacker' WHERE repository='guard/repo'",
      "UPDATE overseer_fusion_budget_reservations SET provider='attacker' WHERE reservation_id='guard-reservation'",
    ];
    for (const sql of directUpdates) {
      await expect(database.query(sql)).rejects.toThrow('rejects non-CAS update');
    }

    expect(
      await heartbeatOverseerParent({
        parent_id: 'guard-parent',
        owner_id: 'guard-owner',
        fencing_token: parent.value.fencing_token,
      })
    ).toMatchObject({ ok: true });
    expect(
      await transitionOverseerChildState({
        parent_id: 'guard-parent',
        child_id: 'guard-child',
        owner_id: 'guard-owner',
        fencing_token: parent.value.fencing_token,
        state: 'RUNNING',
      })
    ).toMatchObject({ ok: true });
    expect(
      await heartbeatRepositoryMutationLease({
        repository: 'guard/repo',
        lease_id: 'guard-lease',
        owner_id: 'guard-owner',
        execution_id: 'guard-execution',
        fencing_token: lease.value.fencing_token,
      })
    ).toMatchObject({ ok: true });
    expect(
      await markFusionBudgetCallStarted({
        reservation_id: 'guard-reservation',
        call_id: 'guard-call',
      })
    ).toMatchObject({ ok: true });
  });

  test('PostgreSQL and SQLite parity uses two file-backed connections and atomic events', async () => {
    const first = database;
    const second = new SqliteAdapter(databasePath);
    await installOverseerControlPlaneSqlite(first);
    await installOverseerControlPlaneSqlite(second);

    database = first;
    const firstAdmission = admitOverseerParent({
      parent_id: 'parallel-first',
      owner_id: 'owner-first',
      correlation_id: 'correlation-first',
      state: 'BUILDING',
    });
    database = second;
    const secondAdmission = admitOverseerParent({
      parent_id: 'parallel-second',
      owner_id: 'owner-second',
      correlation_id: 'correlation-second',
      state: 'BUILDING',
    });
    expect((await Promise.all([firstAdmission, secondAdmission])).every(result => result.ok)).toBe(
      true
    );

    await expect(
      second.query("UPDATE overseer_control_events SET actor='attacker'")
    ).rejects.toThrow('append-only');
    await expect(second.query('DELETE FROM overseer_parent_commitments')).rejects.toThrow(
      'rejects delete'
    );
    await expect(
      withOverseerControlPlaneImmediateTransaction(second, async query => {
        await query(
          "INSERT INTO overseer_parent_children(parent_id,child_id,state,created_at,terminal_at) VALUES ('parallel-first','rolled-back','PENDING',strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL)"
        );
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');
    const rolledBack = await first.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM overseer_parent_children WHERE child_id='rolled-back'"
    );
    expect(Number(rolledBack.rows[0]?.n)).toBe(0);

    const events = await first.query<{
      resource_kind: string;
      resource_key: string;
      event_sequence: number;
      previous_event_digest: string | null;
      event_digest: string;
    }>(
      `SELECT resource_kind,resource_key,event_sequence,previous_event_digest,event_digest
       FROM overseer_control_events ORDER BY resource_kind,resource_key,event_sequence`
    );
    for (const stream of new Set(
      events.rows.map(row => `${row.resource_kind}:${row.resource_key}`)
    )) {
      const rows = events.rows.filter(row => `${row.resource_kind}:${row.resource_key}` === stream);
      expect(Number(rows[0]?.event_sequence)).toBe(1);
      expect(rows[0]?.previous_event_digest).toBeNull();
      for (let index = 1; index < rows.length; index += 1) {
        expect(Number(rows[index]?.event_sequence)).toBe(index + 1);
        expect(rows[index]?.previous_event_digest).toBe(rows[index - 1]?.event_digest);
      }
    }

    await second.close();
    database = first;
  });

  test('PostgreSQL serialization retry is bounded before any state mutation', async () => {
    const original = database;
    let attempts = 0;
    const serializationFailure = Object.assign(new Error('serialization failure'), {
      code: '40001',
    });
    database = {
      dialect: 'postgres',
      sql: original.sql,
      query: async () => {
        throw new Error('query must remain transaction-scoped');
      },
      withTransaction: async () => {
        attempts += 1;
        throw serializationFailure;
      },
      close: async () => undefined,
    } as unknown as SqliteAdapter;
    try {
      await expect(
        admitOverseerParent({
          parent_id: 'retry-parent',
          owner_id: 'retry-owner',
          correlation_id: 'retry-correlation',
          state: 'BUILDING',
        })
      ).rejects.toThrow('overseer_control_plane_serialization_retry_exhausted');
      expect(attempts).toBe(5);
    } finally {
      database = original;
    }
    const rows = await original.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM overseer_parent_commitments WHERE parent_id='retry-parent'"
    );
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });
});
