import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { PostgresAdapter } from './adapters/postgres';
import {
  admitOverseerParent,
  heartbeatOverseerParent,
  linkOverseerChild,
  transitionOverseerChildState,
  releaseOverseerParent,
  reconcileExpiredParentCommitments,
  acquireRepositoryMutationLease,
  heartbeatRepositoryMutationLease,
  reserveFusionBudget,
  markFusionBudgetCallStarted,
  reconcileFusionBudget,
  listOverseerControlEvents,
  computeVerifierRegistryDigest,
  registerVerifierRegistry,
  assertIndependentVerifier,
} from './overseer-control-plane';
import { OVERSEER_CONTROL_PLANE_TABLES } from './overseer-control-plane-sqlite';

let db: PostgresAdapter;

beforeAll(() => {
  const url = process.env.OVERSEER_CONTROL_PLANE_TEST_DATABASE_URL;
  if (!url) throw new Error('OVERSEER_CONTROL_PLANE_TEST_DATABASE_URL is required');
  db = new PostgresAdapter(url);
  if (db.dialect !== 'postgres') {
    throw new Error('overseer control-plane postgres test silently selected non-PostgreSQL');
  }
});

afterAll(async () => {
  await db.close();
});

async function rejects(write: Promise<unknown>): Promise<boolean> {
  try {
    await write;
    return false;
  } catch {
    return true;
  }
}

describe('overseer control plane PostgreSQL 17 behavior', () => {
  test('real schema exposes the seven control-plane tables and a database clock', async () => {
    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'overseer_%' ORDER BY table_name"
    );
    const names = tables.rows.map(r => r.table_name);
    for (const table of OVERSEER_CONTROL_PLANE_TABLES) expect(names).toContain(table);

    const now = await db.query<{ now: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`
    );
    expect(Number.isFinite(Date.parse(now.rows[0]?.now ?? ''))).toBe(true);

    // Append-only tables reject UPDATE and DELETE; state tables reject DELETE.
    expect(await rejects(db.query('UPDATE overseer_control_events SET actor=actor'))).toBe(true);
    expect(await rejects(db.query('DELETE FROM overseer_control_events'))).toBe(true);
    expect(
      await rejects(
        db.query('UPDATE overseer_verifier_registries SET schema_version=schema_version')
      )
    ).toBe(true);
    expect(await rejects(db.query('DELETE FROM overseer_verifier_entries'))).toBe(true);
    expect(await rejects(db.query('DELETE FROM overseer_parent_commitments'))).toBe(true);
    expect(await rejects(db.query('DELETE FROM overseer_repository_mutation_leases'))).toBe(true);
    expect(await rejects(db.query('DELETE FROM overseer_fusion_budget_reservations'))).toBe(true);
  });

  test('concurrent admission across independent connections admits exactly 10; crash frees a slot', async () => {
    const run = randomUUID().slice(0, 8);
    const second = new PostgresAdapter(process.env.OVERSEER_CONTROL_PLANE_TEST_DATABASE_URL!);
    try {
      const admits = Array.from({ length: 20 }, (_v, i) => i).map(i =>
        admitOverseerParent(
          {
            parent_id: `${run}-p${i}`,
            owner_id: `${run}-owner${i}`,
            correlation_id: `${run}-corr${i}`,
            state: 'BUILDING',
            actor: 'xo',
          },
          i % 2 === 0 ? db : second
        )
      );
      const results = await Promise.all(admits);
      const admitted = results.filter(r => r.ok).length;
      const rejected = results.filter(r => !r.ok && r.code === 'parent_capacity_reached').length;
      expect(admitted).toBe(10);
      expect(rejected).toBe(10);

      const active = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM overseer_parent_commitments
          WHERE parent_id LIKE $1 AND state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING')`,
        [`${run}-%`]
      );
      expect(active.rows[0]?.n).toBe('10');

      // A child does not change the active count.
      const winner = results.findIndex(r => r.ok);
      const winnerId = `${run}-p${winner}`;
      const link = await linkOverseerChild(
        {
          parent_id: winnerId,
          child_id: `${run}-c0`,
          owner_id: `${run}-owner${winner}`,
          fencing_token: 1,
          actor: 'xo',
        },
        db
      );
      expect(link.ok).toBe(true);
      expect(
        (
          await transitionOverseerChildState(
            {
              parent_id: winnerId,
              child_id: `${run}-c0`,
              owner_id: `${run}-owner${winner}`,
              fencing_token: 1,
              state: 'RUNNING',
              actor: 'xo',
            },
            db
          )
        ).ok
      ).toBe(true);

      // Crash the winner: expire its lease, reconcile deterministically.
      await db.query(
        "UPDATE overseer_parent_commitments SET heartbeat_at=clock_timestamp()-interval '2 hours', lease_expires_at=clock_timestamp()-interval '1 hour' WHERE parent_id=$1",
        [winnerId]
      );
      const recon = await reconcileExpiredParentCommitments(db);
      expect(recon.reconciled).toBeGreaterThanOrEqual(1);
      const crashed = await db.query<{
        state: string;
        terminal_reason: string;
        fencing_token: string;
      }>(
        'SELECT state, terminal_reason, fencing_token FROM overseer_parent_commitments WHERE parent_id=$1',
        [winnerId]
      );
      expect(crashed.rows[0]?.state).toBe('FAILED');
      expect(crashed.rows[0]?.terminal_reason).toBe('owner_lease_expired');
      expect(Number(crashed.rows[0]?.fencing_token)).toBe(2);
      // Its child is FAILED.
      const child = await db.query<{ state: string }>(
        'SELECT state FROM overseer_parent_children WHERE parent_id=$1 AND child_id=$2',
        [winnerId, `${run}-c0`]
      );
      expect(child.rows[0]?.state).toBe('FAILED');
      // Stale owner token cannot heartbeat.
      expect(
        await heartbeatOverseerParent(
          { parent_id: winnerId, owner_id: `${run}-owner${winner}`, fencing_token: 1, actor: 'xo' },
          db
        )
      ).toEqual({ ok: false, code: 'parent_lease_stale' });
      // Exactly one CRASH_RECONCILED event on that stream.
      const crashEvents = (
        await listOverseerControlEvents({ resource_kind: 'PARENT', resource_key: winnerId }, db)
      ).filter(e => e.event_kind === 'CRASH_RECONCILED');
      expect(crashEvents).toHaveLength(1);

      // A waiting parent now takes the freed slot.
      const waiting = await admitOverseerParent(
        {
          parent_id: `${run}-waiting`,
          owner_id: `${run}-w`,
          correlation_id: `${run}-wc`,
          state: 'BUILDING',
          actor: 'xo',
        },
        db
      );
      expect(waiting.ok).toBe(true);

      // Release all active parents in this namespace so later tests start clean.
      const remaining = await db.query<{
        parent_id: string;
        owner_id: string;
        fencing_token: string;
      }>(
        `SELECT parent_id, owner_id, fencing_token FROM overseer_parent_commitments
          WHERE parent_id LIKE $1 AND state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING')`,
        [`${run}-%`]
      );
      for (const row of remaining.rows) {
        await releaseOverseerParent(
          {
            parent_id: row.parent_id,
            owner_id: row.owner_id,
            fencing_token: Number(row.fencing_token),
            state: 'CANCELLED',
            terminal_reason: 'test_cleanup',
            actor: 'xo',
          },
          db
        );
      }
    } finally {
      await second.close();
    }
  }, 30_000);

  test('repository lease fencing and takeover survive crash across connections', async () => {
    const run = randomUUID().slice(0, 8);
    const repo = `${run}/repo`;
    const second = new PostgresAdapter(process.env.OVERSEER_CONTROL_PLANE_TEST_DATABASE_URL!);
    try {
      const acquire = (adapter: PostgresAdapter, worker: string) =>
        acquireRepositoryMutationLease(
          {
            repository: repo,
            lease_id: `${run}-${worker}`,
            owner_id: worker,
            execution_id: `${run}-e-${worker}`,
            action_kind: 'MERGE',
            capability: 'cap',
            actor: 'xo',
          },
          adapter
        );
      const race = await Promise.all([acquire(db, 'w1'), acquire(second, 'w2')]);
      expect(race.filter(r => r.ok)).toHaveLength(1);
      expect(race.filter(r => !r.ok && r.code === 'lease_conflict')).toHaveLength(1);
      const winner = race.find(r => r.ok);
      const winnerWorker = winner && winner.ok ? winner.value.owner_id : '';
      if (winner && winner.ok) expect(winner.value.fencing_token).toBe(1);

      // Heartbeat extends expiry exactly 300 seconds.
      const beat = await heartbeatRepositoryMutationLease(
        {
          repository: repo,
          lease_id: `${run}-${winnerWorker}`,
          owner_id: winnerWorker,
          execution_id: `${run}-e-${winnerWorker}`,
          fencing_token: 1,
          actor: 'xo',
        },
        db
      );
      expect(beat.ok).toBe(true);
      if (beat.ok)
        expect(Date.parse(beat.value.expires_at) - Date.parse(beat.value.heartbeat_at)).toBe(
          300_000
        );

      // Force expiry, then the loser takes over with a greater fencing token.
      await db.query(
        "UPDATE overseer_repository_mutation_leases SET heartbeat_at=clock_timestamp()-interval '2 hours', expires_at=clock_timestamp()-interval '1 hour' WHERE repository=$1",
        [repo]
      );
      const loserWorker = winnerWorker === 'w1' ? 'w2' : 'w1';
      const takeover = await acquire(db, loserWorker);
      expect(takeover.ok).toBe(true);
      if (takeover.ok) expect(takeover.value.fencing_token).toBe(2);
    } finally {
      await second.close();
    }
  }, 20_000);

  test('Fusion caps and event chain hold under the real dialect', async () => {
    const run = randomUUID().slice(0, 8);
    const reserve = (id: string, micro: number) =>
      reserveFusionBudget(
        {
          reservation_id: `${run}-${id}`,
          call_id: `${run}-call-${id}`,
          proposal_id: 'p',
          execution_id: 'e',
          provider: 'xai',
          model: 'grok-4',
          call_kind: 'PRIMARY',
          requested_microusd: micro,
          actor: 'xo',
        },
        db
      );
    // Per-call cap.
    expect(await reserve('over', 3_000_001)).toEqual({ ok: false, code: 'budget_cap_exceeded' });
    // Reserve, start, reconcile with overage.
    expect((await reserve('a', 1_000_000)).ok).toBe(true);
    expect(
      (
        await markFusionBudgetCallStarted(
          { reservation_id: `${run}-a`, call_id: `${run}-call-a`, actor: 'xo' },
          db
        )
      ).ok
    ).toBe(true);
    expect(
      await reconcileFusionBudget(
        {
          reservation_id: `${run}-a`,
          call_id: `${run}-call-a`,
          actual_microusd: 2_000_000,
          actor: 'xo',
        },
        db
      )
    ).toEqual({ ok: false, code: 'budget_overage_recorded' });

    // Event chain: genesis is sequence 1 with NULL predecessor; later binds prior digest.
    const events = await listOverseerControlEvents(
      { resource_kind: 'FUSION_BUDGET', resource_key: `${run}-a` },
      db
    );
    expect(events[0]?.event_sequence).toBe(1);
    expect(events[0]?.previous_event_digest).toBeNull();
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.event_sequence).toBe(events[i - 1]!.event_sequence + 1);
      expect(events[i]!.previous_event_digest).toBe(events[i - 1]!.event_digest);
    }
  }, 20_000);

  test('verifier registry digest and independence hold under the real dialect', async () => {
    const run = randomUUID().slice(0, 8);
    const entries = [
      {
        verifier_id: `${run}-grok`,
        provider: 'xai',
        model_family: 'grok',
        roles: ['REVIEWER' as const],
        enabled: true,
      },
    ];
    const digest = computeVerifierRegistryDigest(entries);
    const reg = await registerVerifierRegistry(
      {
        schema_version: 'overseer-verifier-registry-v1',
        registry_digest: digest,
        entries,
        source_artifact_path: 'p',
        source_git_blob: `${run}-blob`,
        actor: 'xo',
      },
      db
    );
    expect(reg.ok).toBe(true);
    // Grok on Grok fails closed.
    expect(
      await assertIndependentVerifier(
        {
          operator_provider: 'xai',
          operator_model_family: 'grok',
          registry_digest: digest,
          verifier_id: `${run}-grok`,
          required_role: 'REVIEWER',
        },
        db
      )
    ).toEqual({ ok: false, code: 'verifier_not_independent' });
    // Independent operator is allowed.
    const allowed = await assertIndependentVerifier(
      {
        operator_provider: 'openai',
        operator_model_family: 'gpt',
        registry_digest: digest,
        verifier_id: `${run}-grok`,
        required_role: 'REVIEWER',
      },
      db
    );
    expect(allowed.ok).toBe(true);
  }, 20_000);
});
