import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';
import {
  installOverseerControlPlaneSqlite,
  withOverseerControlPlaneImmediateTransaction,
  OVERSEER_CONTROL_PLANE_TABLES,
} from './overseer-control-plane-sqlite';
import {
  admitOverseerParent,
  heartbeatOverseerParent,
  transitionOverseerParentState,
  linkOverseerChild,
  transitionOverseerChildState,
  releaseOverseerParent,
  reconcileExpiredParentCommitments,
  acquireRepositoryMutationLease,
  heartbeatRepositoryMutationLease,
  releaseRepositoryMutationLease,
  reserveFusionBudget,
  markFusionBudgetCallStarted,
  reconcileFusionBudget,
  releaseFusionBudgetReservation,
  listOverseerControlEvents,
  computeVerifierRegistryDigest,
  registerVerifierRegistry,
  canonicalJson,
  FUSION_PER_CALL_CAP_MICROUSD,
  FUSION_PER_DAY_CAP_MICROUSD,
} from './overseer-control-plane';

let db: SqliteAdapter;
let dbPath = '';

beforeEach(async () => {
  dbPath = join(process.cwd(), `.ocp-test-${crypto.randomUUID()}.db`);
  db = new SqliteAdapter(dbPath);
  await installOverseerControlPlaneSqlite(db);
});

afterEach(async () => {
  await db.close();
  for (const suffix of ['', '-wal', '-shm'])
    try {
      unlinkSync(dbPath + suffix);
    } catch {
      /* absent */
    }
});

// Force an already-admitted parent's lease into the past so reconciliation sees it
// as crashed. Uses a direct UPDATE (permitted for active rows by the guard trigger).
async function expireParentLease(parentId: string): Promise<void> {
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const beat = new Date(Date.now() - 3_700_000).toISOString();
  await db.query(
    'UPDATE overseer_parent_commitments SET heartbeat_at=$2, lease_expires_at=$3 WHERE parent_id=$1',
    [parentId, beat, past]
  );
}

async function admit(id: string) {
  return admitOverseerParent(
    {
      parent_id: id,
      owner_id: `owner-${id}`,
      correlation_id: `corr-${id}`,
      state: 'BUILDING',
      actor: 'xo',
    },
    db
  );
}

describe('overseer control plane (SQLite)', () => {
  test('PostgreSQL and SQLite parity: seven tables, constraints, and immutability', async () => {
    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'overseer_%' ORDER BY name"
    );
    const names = tables.rows.map(r => r.name);
    for (const table of OVERSEER_CONTROL_PLANE_TABLES) expect(names).toContain(table);
    expect(OVERSEER_CONTROL_PLANE_TABLES.length).toBe(7);

    // A genesis event exists after an admit; sequence 1 with NULL predecessor.
    const admitted = await admit('p-parity');
    expect(admitted.ok).toBe(true);
    const events = await listOverseerControlEvents(
      { resource_kind: 'PARENT', resource_key: 'p-parity' },
      db
    );
    expect(events[0]?.event_sequence).toBe(1);
    expect(events[0]?.previous_event_digest).toBeNull();
    expect(events[0]?.event_kind).toBe('ADMITTED');

    // Append-only + no-delete enforcement.
    await expect(
      db.query('UPDATE overseer_control_events SET actor=$1 WHERE resource_key=$2', [
        'attacker',
        'p-parity',
      ])
    ).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM overseer_control_events')).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM overseer_parent_commitments')).rejects.toThrow(
      'cannot be deleted'
    );

    // A second connection sees the same committed genesis (two file-backed connections).
    const second = new SqliteAdapter(dbPath);
    try {
      const seen = await second.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM overseer_control_events WHERE resource_key='p-parity'"
      );
      expect(Number(seen.rows[0]?.n)).toBe(1);
    } finally {
      await second.close();
    }

    // Digest is a deterministic function of canonical bytes (known-answer vector).
    const entries = [
      {
        verifier_id: 'grok-4',
        provider: 'xai',
        model_family: 'grok',
        roles: ['REVIEWER'] as const,
        enabled: true,
      },
    ];
    const expected = createHash('sha256')
      .update(
        `overseer-verifier-registry-v1\n${canonicalJson({
          schema_version: 'overseer-verifier-registry-v1',
          entries: [
            {
              enabled: true,
              model_family: 'grok',
              provider: 'xai',
              roles: ['REVIEWER'],
              verifier_id: 'grok-4',
            },
          ],
        })}`,
        'utf8'
      )
      .digest('hex');
    expect(computeVerifierRegistryDigest(entries)).toBe(expected);
  });

  test('isolated immediate transaction helper rejects wrong dialect and nested use', async () => {
    const result = await withOverseerControlPlaneImmediateTransaction(db, async query => {
      const row = await query<{ one: number }>('SELECT 1 AS one');
      return row.rows[0]?.one;
    });
    expect(result).toBe(1);
    await expect(
      withOverseerControlPlaneImmediateTransaction(db, async () => {
        await withOverseerControlPlaneImmediateTransaction(db, async () => 'inner');
      })
    ).rejects.toThrow('nested');
  });

  test('parent admission cap, child state, and crash recovery', async () => {
    // Admit 10 parents; the 11th is rejected.
    for (let i = 0; i < 10; i++) expect((await admit(`p${i}`)).ok).toBe(true);
    const eleventh = await admit('p10');
    expect(eleventh).toEqual({ ok: false, code: 'parent_capacity_reached' });

    // Children do not change the active count.
    const link = await linkOverseerChild(
      { parent_id: 'p0', child_id: 'c0', owner_id: 'owner-p0', fencing_token: 1, actor: 'xo' },
      db
    );
    expect(link.ok).toBe(true);
    const activeAfterChild = await db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM overseer_parent_commitments WHERE state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING')"
    );
    expect(Number(activeAfterChild.rows[0]?.n)).toBe(10);

    // Child transition edges.
    expect(
      (
        await transitionOverseerChildState(
          {
            parent_id: 'p0',
            child_id: 'c0',
            owner_id: 'owner-p0',
            fencing_token: 1,
            state: 'RUNNING',
            actor: 'xo',
          },
          db
        )
      ).ok
    ).toBe(true);

    // Orphan / cross-parent / invalid transition failures write nothing.
    expect(
      await linkOverseerChild(
        { parent_id: 'missing', child_id: 'cX', owner_id: 'o', fencing_token: 1, actor: 'xo' },
        db
      )
    ).toEqual({ ok: false, code: 'child_orphaned' });
    expect(
      await linkOverseerChild(
        { parent_id: 'p1', child_id: 'c0', owner_id: 'owner-p1', fencing_token: 1, actor: 'xo' },
        db
      )
    ).toEqual({ ok: false, code: 'child_identity_conflict' });
    expect(
      await transitionOverseerChildState(
        {
          parent_id: 'p0',
          child_id: 'missing',
          owner_id: 'owner-p0',
          fencing_token: 1,
          state: 'RUNNING',
          actor: 'xo',
        },
        db
      )
    ).toEqual({ ok: false, code: 'child_not_found' });
    // COMPLETED with an active child on parent -> parent_children_active.
    expect(
      await releaseOverseerParent(
        {
          parent_id: 'p0',
          owner_id: 'owner-p0',
          fencing_token: 1,
          state: 'COMPLETED',
          terminal_reason: 'done',
          actor: 'xo',
        },
        db
      )
    ).toEqual({ ok: false, code: 'parent_children_active' });

    // Heartbeat extends the lease exactly 300 seconds and appends one HEARTBEAT.
    const beforeBeat = await db.query<{ lease_expires_at: string; heartbeat_at: string }>(
      'SELECT lease_expires_at, heartbeat_at FROM overseer_parent_commitments WHERE parent_id=$1',
      ['p2']
    );
    const beat = await heartbeatOverseerParent(
      { parent_id: 'p2', owner_id: 'owner-p2', fencing_token: 1, actor: 'xo' },
      db
    );
    expect(beat.ok).toBe(true);
    if (beat.ok) {
      const delta = Date.parse(beat.value.lease_expires_at) - Date.parse(beat.value.heartbeat_at);
      expect(delta).toBe(300_000);
    }
    const heartbeatEvents = (
      await listOverseerControlEvents({ resource_kind: 'PARENT', resource_key: 'p2' }, db)
    ).filter(e => e.event_kind === 'HEARTBEAT');
    expect(heartbeatEvents).toHaveLength(1);

    // Wrong/stale token heartbeat returns parent_lease_stale and writes nothing.
    expect(
      await heartbeatOverseerParent(
        { parent_id: 'p2', owner_id: 'owner-p2', fencing_token: 99, actor: 'xo' },
        db
      )
    ).toEqual({ ok: false, code: 'parent_lease_stale' });
    const stillOne = (
      await listOverseerControlEvents({ resource_kind: 'PARENT', resource_key: 'p2' }, db)
    ).filter(e => e.event_kind === 'HEARTBEAT');
    expect(stillOne).toHaveLength(1);

    // Crash recovery: expire p3, reconcile, its slot frees for a waiting parent.
    await expireParentLease('p3');
    const recon = await reconcileExpiredParentCommitments(db);
    expect(recon.reconciled).toBe(1);
    const crashed = await db.query<Record<string, unknown>>(
      'SELECT * FROM overseer_parent_commitments WHERE parent_id=$1',
      ['p3']
    );
    expect(crashed.rows[0]?.state).toBe('FAILED');
    expect(crashed.rows[0]?.terminal_reason).toBe('owner_lease_expired');
    expect(Number(crashed.rows[0]?.fencing_token)).toBe(2);
    // The stale owner token can no longer heartbeat.
    expect(
      await heartbeatOverseerParent(
        { parent_id: 'p3', owner_id: 'owner-p3', fencing_token: 1, actor: 'xo' },
        db
      )
    ).toEqual({ ok: false, code: 'parent_lease_stale' });
    // Exactly one CRASH_RECONCILED event.
    const crashEvents = (
      await listOverseerControlEvents({ resource_kind: 'PARENT', resource_key: 'p3' }, db)
    ).filter(e => e.event_kind === 'CRASH_RECONCILED');
    expect(crashEvents).toHaveLength(1);
    // A waiting parent takes the freed slot (reconcile runs inside admit).
    const waiting = await admit('p-waiting');
    expect(waiting.ok).toBe(true);
    // A second reconcile is a no-op (idempotent crash recovery).
    expect((await reconcileExpiredParentCommitments(db)).reconciled).toBe(0);
  });

  test('repository lease fencing and fixed TTL survive crash', async () => {
    const acquire = (repo: string, worker: string) =>
      acquireRepositoryMutationLease(
        {
          repository: repo,
          lease_id: `lease-${worker}`,
          owner_id: worker,
          execution_id: `exec-${worker}`,
          action_kind: 'MERGE',
          capability: 'overseer.merge',
          actor: 'xo',
        },
        db
      );

    const first = await acquire('org/repo', 'w1');
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.fencing_token).toBe(1);

    // A second worker on the same repository loses (lease_conflict).
    expect(await acquire('org/repo', 'w2')).toEqual({ ok: false, code: 'lease_conflict' });

    // A different repository proceeds.
    expect((await acquire('org/other', 'w3')).ok).toBe(true);

    // Current heartbeat extends expiry exactly 300 seconds.
    const beat = await heartbeatRepositoryMutationLease(
      {
        repository: 'org/repo',
        lease_id: 'lease-w1',
        owner_id: 'w1',
        execution_id: 'exec-w1',
        fencing_token: 1,
        actor: 'xo',
      },
      db
    );
    expect(beat.ok).toBe(true);
    if (beat.ok) {
      expect(Date.parse(beat.value.expires_at) - Date.parse(beat.value.heartbeat_at)).toBe(300_000);
    }

    // Crash the winner: force expiry, then w2 takes over with a greater token.
    await db.query(
      'UPDATE overseer_repository_mutation_leases SET heartbeat_at=$2, expires_at=$3 WHERE repository=$1',
      [
        'org/repo',
        new Date(Date.now() - 3_700_000).toISOString(),
        new Date(Date.now() - 3_600_000).toISOString(),
      ]
    );
    // Stale heartbeat / release / (mutation) all return lease_stale with no event write.
    const beforeEvents = (
      await listOverseerControlEvents(
        { resource_kind: 'REPOSITORY_LEASE', resource_key: 'org/repo' },
        db
      )
    ).length;
    expect(
      await heartbeatRepositoryMutationLease(
        {
          repository: 'org/repo',
          lease_id: 'lease-w1',
          owner_id: 'w1',
          execution_id: 'exec-w1',
          fencing_token: 1,
          actor: 'xo',
        },
        db
      )
    ).toEqual({ ok: false, code: 'lease_stale' });
    expect(
      await releaseRepositoryMutationLease(
        {
          repository: 'org/repo',
          lease_id: 'lease-w1',
          owner_id: 'w1',
          execution_id: 'exec-w1',
          fencing_token: 1,
          actor: 'xo',
        },
        db
      )
    ).toEqual({ ok: false, code: 'lease_stale' });
    const afterEvents = (
      await listOverseerControlEvents(
        { resource_kind: 'REPOSITORY_LEASE', resource_key: 'org/repo' },
        db
      )
    ).length;
    expect(afterEvents).toBe(beforeEvents);

    const takeover = await acquire('org/repo', 'w2');
    expect(takeover.ok).toBe(true);
    if (takeover.ok) expect(takeover.value.fencing_token).toBe(2);

    // Absent lease -> lease_not_found.
    expect(
      await releaseRepositoryMutationLease(
        {
          repository: 'org/none',
          lease_id: 'l',
          owner_id: 'w',
          execution_id: 'e',
          fencing_token: 1,
          actor: 'xo',
        },
        db
      )
    ).toEqual({ ok: false, code: 'lease_not_found' });
  });

  test('Fusion reservation lifecycle enforces all caps and overage stop', async () => {
    const reserve = (
      id: string,
      micro: number,
      kind: 'PRIMARY' | 'RETRY' | 'FALLBACK' | 'INDIRECT' = 'PRIMARY'
    ) =>
      reserveFusionBudget(
        {
          reservation_id: id,
          call_id: `call-${id}`,
          proposal_id: 'prop-1',
          execution_id: 'exec-1',
          provider: 'xai',
          model: 'grok-4',
          call_kind: kind,
          requested_microusd: micro,
          actor: 'xo',
        },
        db
      );

    // Per-call cap.
    expect(await reserve('over-call', FUSION_PER_CALL_CAP_MICROUSD + 1)).toEqual({
      ok: false,
      code: 'budget_cap_exceeded',
    });

    // Retry/fallback/indirect each require their own reservation and count toward totals.
    expect((await reserve('r1', 3_000_000, 'PRIMARY')).ok).toBe(true);
    expect((await reserve('r2', 3_000_000, 'RETRY')).ok).toBe(true);
    expect((await reserve('r3', 3_000_000, 'FALLBACK')).ok).toBe(true);
    expect((await reserve('r4', 3_000_000, 'INDIRECT')).ok).toBe(true);
    expect((await reserve('r5', 3_000_000)).ok).toBe(true);
    expect((await reserve('r6', 3_000_000)).ok).toBe(true);
    // Day charge now 18,000,000; a 3,000,000 reservation would exceed 20,000,000.
    expect(await reserve('r7', 3_000_000)).toEqual({ ok: false, code: 'budget_cap_exceeded' });
    expect(Number(FUSION_PER_DAY_CAP_MICROUSD)).toBe(20_000_000);

    // Persisted bucket keys use the database UTC clock, not caller-supplied values.
    const stored = await db.query<{ utc_day: string; utc_month: string }>(
      'SELECT utc_day, utc_month FROM overseer_fusion_budget_reservations WHERE reservation_id=$1',
      ['r1']
    );
    const today = new Date().toISOString();
    expect(stored.rows[0]?.utc_day).toBe(today.slice(0, 10));
    expect(stored.rows[0]?.utc_month).toBe(today.slice(0, 7));

    // Mark started -> reconcile; only RESERVED may release.
    expect(
      (
        await markFusionBudgetCallStarted(
          { reservation_id: 'r1', call_id: 'call-r1', actor: 'xo' },
          db
        )
      ).ok
    ).toBe(true);
    // An IN_FLIGHT reservation cannot be released (crash remains charged).
    expect(
      await releaseFusionBudgetReservation(
        {
          reservation_id: 'r1',
          call_id: 'call-r1',
          release_reason: 'call_cancelled_before_start',
          actor: 'xo',
        },
        db
      )
    ).toEqual({ ok: false, code: 'budget_transition_invalid' });
    // Reconcile within reservation succeeds.
    expect(
      (
        await reconcileFusionBudget(
          { reservation_id: 'r1', call_id: 'call-r1', actual_microusd: 2_500_000, actor: 'xo' },
          db
        )
      ).ok
    ).toBe(true);

    // Overage: actual exceeds requested -> recorded honestly, returns budget_overage_recorded.
    expect(
      (
        await markFusionBudgetCallStarted(
          { reservation_id: 'r2', call_id: 'call-r2', actor: 'xo' },
          db
        )
      ).ok
    ).toBe(true);
    const overage = await reconcileFusionBudget(
      {
        reservation_id: 'r2',
        call_id: 'call-r2',
        actual_microusd: 3_000_000 + 500_000,
        actor: 'xo',
      },
      db
    );
    // actual (3,500,000) exceeds requested (3,000,000).
    expect(overage).toEqual({ ok: false, code: 'budget_overage_recorded' });
    const overageRow = await db.query<{ actual_microusd: number; status: string }>(
      'SELECT actual_microusd, status FROM overseer_fusion_budget_reservations WHERE reservation_id=$1',
      ['r2']
    );
    expect(Number(overageRow.rows[0]?.actual_microusd)).toBe(3_500_000);
    expect(overageRow.rows[0]?.status).toBe('RECONCILED');
    const overageEvent = (
      await listOverseerControlEvents({ resource_kind: 'FUSION_BUDGET', resource_key: 'r2' }, db)
    ).filter(e => e.event_kind === 'BUDGET_OVERAGE_RECORDED');
    expect(overageEvent).toHaveLength(1);

    // A pre-call RESERVED row may be released.
    expect((await reserve('rel', 1_000)).ok).toBe(true);
    expect(
      (
        await releaseFusionBudgetReservation(
          {
            reservation_id: 'rel',
            call_id: 'call-rel',
            release_reason: 'provider_unavailable_before_start',
            actor: 'xo',
          },
          db
        )
      ).ok
    ).toBe(true);

    // Absent reservation.
    expect(
      await markFusionBudgetCallStarted({ reservation_id: 'nope', call_id: 'x', actor: 'xo' }, db)
    ).toEqual({ ok: false, code: 'budget_reservation_not_found' });
  });

  test('verifier registry digest mismatch and independence are enforced at the store', async () => {
    const entries = [
      {
        verifier_id: 'grok-4',
        provider: 'xai',
        model_family: 'grok',
        roles: ['REVIEWER'] as const,
        enabled: true,
      },
    ];
    const digest = computeVerifierRegistryDigest(entries);
    // Wrong claimed digest is rejected.
    expect(
      await registerVerifierRegistry(
        {
          schema_version: 'overseer-verifier-registry-v1',
          registry_digest: 'f'.repeat(64),
          entries,
          source_artifact_path: 'docs/verifiers.json',
          source_git_blob: 'blob1',
          actor: 'xo',
        },
        db
      )
    ).toEqual({ ok: false, code: 'registry_digest_mismatch' });
    // Correct digest registers and replays idempotently (no second event).
    const reg = await registerVerifierRegistry(
      {
        schema_version: 'overseer-verifier-registry-v1',
        registry_digest: digest,
        entries,
        source_artifact_path: 'docs/verifiers.json',
        source_git_blob: 'blob1',
        actor: 'xo',
      },
      db
    );
    expect(reg.ok).toBe(true);
    const replay = await registerVerifierRegistry(
      {
        schema_version: 'overseer-verifier-registry-v1',
        registry_digest: digest,
        entries,
        source_artifact_path: 'docs/verifiers.json',
        source_git_blob: 'blob1',
        actor: 'xo',
      },
      db
    );
    expect(replay.ok).toBe(true);
    const frozenEvents = (
      await listOverseerControlEvents(
        { resource_kind: 'VERIFIER_REGISTRY', resource_key: digest },
        db
      )
    ).filter(e => e.event_kind === 'REGISTRY_FROZEN');
    expect(frozenEvents).toHaveLength(1);
  });
});
