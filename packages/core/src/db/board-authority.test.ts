import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';

let db: SqliteAdapter;
let currentDbPath = '';

mock.module('./connection', () => ({
  getDatabase: () => db,
}));

import {
  acquireXoLease,
  authenticateBoardPrincipal,
  directXoLeaseHandoff,
  getCurrentXoLease,
  getDirectedXoLeaseReservation,
  releaseXoLease,
  renewXoLease,
  resolveBoardRecipient,
  type BoardPrincipal,
} from './board-authority';
import { isEligibleXoSuccessor, type BoardPrincipalRecord } from './board-principal-registry';

const XO: BoardPrincipal = {
  principal_id: 'xo-model',
  seat_id: 'xo',
  roles: ['acting_xo'],
};

const GENERAL: BoardPrincipal = {
  principal_id: 'general-model',
  seat_id: 'general',
  roles: ['board'],
};

const JOHN: BoardPrincipal = {
  principal_id: 'john-operator',
  seat_id: 'john',
  roles: ['board'],
};

const SUCCESSOR: BoardPrincipal = {
  principal_id: 'xo-successor',
  seat_id: 'xo',
  roles: ['acting_xo'],
};

const OTHER_XO: BoardPrincipal = {
  principal_id: 'xo-other',
  seat_id: 'xo',
  roles: ['acting_xo'],
};

const DIGEST = 'ab'.repeat(32);

function principalRecord(
  principalId: string,
  seatId: BoardPrincipal['seat_id'],
  status: BoardPrincipalRecord['status']
): BoardPrincipalRecord {
  return {
    principal_id: principalId,
    seat_id: seatId,
    roles: ['board'],
    token_sha256: DIGEST,
    status,
  };
}

const SUCCESSOR_RECORDS: readonly BoardPrincipalRecord[] = [
  principalRecord('xo-successor', 'xo', 'active'),
  principalRecord('xo-model', 'xo', 'active'),
  principalRecord('xo-other', 'xo', 'active'),
  principalRecord('xo-disabled', 'xo', 'disabled'),
  principalRecord('john-seat-successor', 'john', 'active'),
];

function eligibleSuccessor(principalId: string): boolean {
  return isEligibleXoSuccessor(principalId, SUCCESSOR_RECORDS);
}

async function leaseSnapshot(): Promise<Record<string, unknown>> {
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM board_xo_leases WHERE id = 1'
  );
  return rows.rows[0] ?? {};
}

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

describe('board authority db', () => {
  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-board-authority-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('fails closed when board principal resolver is not configured', async () => {
    await expect(
      authenticateBoardPrincipal({ principal_token: 'token', holder_id: 'h1', holder_token: 's1' })
    ).rejects.toThrow('board_principal_auth_unconfigured');
  });

  test('single XO owner receives fencing token 1 and competing holder conflicts', async () => {
    const winner = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
    });
    const loser = await acquireXoLease({
      principal: GENERAL,
      holder_id: 'holder-b',
      holder_token: 'token-b',
    });

    expect(winner.ok).toBe(true);
    expect(winner.lease?.fencing_token).toBe(1);
    expect(loser.ok).toBe(false);
    expect(loser.reason).toBe('active_xo_lease_exists');
    const rows = await db.query<{ event_type: string }>(
      'SELECT event_type FROM board_audit_events ORDER BY created_at'
    );
    expect(rows.rows.map(row => row.event_type)).toEqual([
      'xo_lease_acquired',
      'xo_lease_acquire_rejected',
    ]);
  });

  test('concurrent first-time acquisitions return one owner and one conflict', async () => {
    const realDb = db;
    let selected = 0;
    let releaseSelects: (() => void) | undefined;
    const bothSelected = new Promise<void>(resolve => {
      releaseSelects = resolve;
    });
    let row:
      | {
          id: number;
          lease_id: string;
          principal_id: string;
          seat_id: 'john' | 'general' | 'xo';
          holder_id: string;
          holder_token_hash: string;
          fencing_token: number;
          acquired_at: string;
          renewed_at: string | null;
          expires_at: string;
          released_at: string | null;
        }
      | undefined;

    const txQuery = mock(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT * FROM board_xo_leases WHERE id = 1')) {
        if (!row) {
          selected += 1;
          if (selected === 2) releaseSelects?.();
          await bothSelected;
          return { rows: [], rowCount: 0 };
        }
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO board_xo_leases')) {
        if (!row) {
          row = {
            id: 1,
            lease_id: params?.[0] as string,
            principal_id: params?.[1] as string,
            seat_id: params?.[2] as 'john' | 'general' | 'xo',
            holder_id: params?.[3] as string,
            holder_token_hash: params?.[4] as string,
            fencing_token: 1,
            acquired_at: params?.[5] as string,
            renewed_at: null,
            expires_at: params?.[6] as string,
            released_at: null,
          };
        }
        return { rows: [], rowCount: row.holder_id === params?.[3] ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    });
    const fakeDb = {
      dialect: 'sqlite',
      query: mock(async () => ({ rows: [{ now: '2026-01-01T00:00:00.000Z' }], rowCount: 1 })),
      withTransaction: mock(async (fn: (query: typeof txQuery) => Promise<unknown>) => fn(txQuery)),
      close: mock(async () => {}),
    };

    db = fakeDb as unknown as SqliteAdapter;
    try {
      const results = await Promise.all([
        acquireXoLease({ principal: XO, holder_id: 'holder-a', holder_token: 'token-a' }),
        acquireXoLease({ principal: GENERAL, holder_id: 'holder-b', holder_token: 'token-b' }),
      ]);

      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.filter(result => !result.ok).map(result => result.reason)).toEqual([
        'active_xo_lease_exists',
      ]);
    } finally {
      db = realDb;
    }
  });

  test('takeover increments fence and stale holder cannot renew or release', async () => {
    const first = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      lease_duration_ms: 1,
    });
    expect(first.lease?.fencing_token).toBe(1);

    await Bun.sleep(10);
    const second = await acquireXoLease({
      principal: GENERAL,
      holder_id: 'holder-b',
      holder_token: 'token-b',
    });
    expect(second.ok).toBe(true);
    expect(second.lease?.fencing_token).toBe(2);

    const staleRenew = await renewXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      fencing_token: 1,
    });
    const staleRelease = await releaseXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      fencing_token: 1,
    });
    expect(staleRenew.ok).toBe(false);
    expect(staleRelease.ok).toBe(false);
    expect((await getCurrentXoLease())?.principal_id).toBe('general-model');
  });

  test('board recipient defers when no unexpired XO lease exists', async () => {
    expect(await resolveBoardRecipient()).toEqual({ ok: false, reason: 'no_valid_xo_lease' });

    await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      lease_duration_ms: 1,
    });
    await Bun.sleep(10);

    expect(await resolveBoardRecipient()).toEqual({ ok: false, reason: 'no_valid_xo_lease' });
  });

  test('same principal sessions are distinct lease holders', async () => {
    const first = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
    });
    const second = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-b',
      holder_token: 'token-b',
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('active_xo_lease_exists');

    const renewed = await renewXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      fencing_token: first.lease?.fencing_token ?? 0,
    });
    const nonholderRenew = await renewXoLease({
      principal: XO,
      holder_id: 'holder-b',
      holder_token: 'token-b',
      fencing_token: first.lease?.fencing_token ?? 0,
    });
    const nonholderRelease = await releaseXoLease({
      principal: XO,
      holder_id: 'holder-b',
      holder_token: 'token-b',
      fencing_token: first.lease?.fencing_token ?? 0,
    });
    expect(renewed.ok).toBe(true);
    expect(nonholderRenew).toEqual({ ok: false, reason: 'stale_xo_lease_token' });
    expect(nonholderRelease).toEqual({ ok: false, reason: 'stale_xo_lease_token' });
  });

  test('injected principal resolver authenticates eligible principals only', async () => {
    const dependencies = {
      resolvePrincipal: mock(async ({ principal_token }: { principal_token?: string }) =>
        principal_token === 'good-token' ? XO : null
      ),
    };
    await expect(
      authenticateBoardPrincipal(
        { principal_token: 'good-token', holder_id: 'h1', holder_token: 's1' },
        dependencies
      )
    ).resolves.toEqual(XO);
    await expect(
      authenticateBoardPrincipal(
        { principal_token: 'bad-token', holder_id: 'h1', holder_token: 's1' },
        dependencies
      )
    ).rejects.toThrow('board_principal_auth_rejected');
  });

  test('board audit events are append-only', async () => {
    await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
    });
    const event = await db.query<{ id: string }>('SELECT id FROM board_audit_events LIMIT 1');
    await expect(
      db.query('UPDATE board_audit_events SET event_type = $1 WHERE id = $2', [
        'xo_lease_released',
        event.rows[0].id,
      ])
    ).rejects.toThrow('board_audit_events is append-only');
  });

  test('john directs handoff and the successor acquires the next fence', async () => {
    const held = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
    });
    const fencingToken = held.lease?.fencing_token ?? 0;
    const handoff = await directXoLeaseHandoff({
      principal: JOHN,
      expected_fencing_token: fencingToken,
      successor_principal_id: SUCCESSOR.principal_id,
      isEligibleSuccessor: eligibleSuccessor,
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.fencing_token).toBe(fencingToken);
    expect(await getCurrentXoLease()).toBeNull();
    const reservation = await getDirectedXoLeaseReservation();
    expect(reservation?.successor_principal_id).toBe(SUCCESSOR.principal_id);
    expect(reservation?.directed_by).toBe(JOHN.principal_id);

    const acquired = await acquireXoLease({
      principal: SUCCESSOR,
      holder_id: 'holder-s',
      holder_token: 'token-s',
    });
    expect(acquired.ok).toBe(true);
    expect(acquired.lease?.fencing_token).toBe(fencingToken + 1);
    expect(acquired.lease?.principal_id).toBe(SUCCESSOR.principal_id);
    expect(await getDirectedXoLeaseReservation()).toBeNull();

    const row = await leaseSnapshot();
    expect(row.handoff_successor_principal_id).toBeNull();
    expect(row.handoff_reserved_until).toBeNull();
    expect(row.handoff_directed_by).toBeNull();
    expect(row.released_at).toBeNull();

    const events = await db.query<{ event_type: string; details: string }>(
      'SELECT event_type, details FROM board_audit_events ORDER BY rowid'
    );
    expect(events.rows.map(event => event.event_type)).toEqual([
      'xo_lease_acquired',
      'xo_lease_handoff_directed',
      'xo_lease_acquired',
    ]);
    const serialized = JSON.stringify(events.rows);
    expect(serialized.includes('holder_token')).toBe(false);
    expect(serialized.includes('token-a')).toBe(false);
    expect(serialized.includes('token-s')).toBe(false);
    const directed = JSON.parse(events.rows[1]?.details ?? '{}') as Record<string, unknown>;
    expect(Object.keys(directed).sort()).toEqual([
      'from_principal_id',
      'reserved_until',
      'successor_principal_id',
    ]);
  });

  test('old holder renew and release after handoff report handed off', async () => {
    const held = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
    });
    const fencingToken = held.lease?.fencing_token ?? 0;
    const handoff = await directXoLeaseHandoff({
      principal: JOHN,
      expected_fencing_token: fencingToken,
      successor_principal_id: SUCCESSOR.principal_id,
      isEligibleSuccessor: eligibleSuccessor,
    });
    expect(handoff.ok).toBe(true);
    const before = await leaseSnapshot();

    const renewed = await renewXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      fencing_token: fencingToken,
    });
    const released = await releaseXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      fencing_token: fencingToken,
    });
    expect(renewed).toEqual({ ok: false, reason: 'xo_lease_handed_off' });
    expect(released).toEqual({ ok: false, reason: 'xo_lease_handed_off' });
    expect(await leaseSnapshot()).toEqual(before);
    expect(before.released_at).not.toBeNull();
    expect(before.fencing_token).toBe(fencingToken);
    expect(before.holder_id).toBe('holder-a');
  });

  test('reservation blocks other acquirers until it expires', async () => {
    const held = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
    });
    const fencingToken = held.lease?.fencing_token ?? 0;
    const handoff = await directXoLeaseHandoff({
      principal: JOHN,
      expected_fencing_token: fencingToken,
      successor_principal_id: SUCCESSOR.principal_id,
      reservation_ms: 60000,
      isEligibleSuccessor: eligibleSuccessor,
    });
    expect(handoff.ok).toBe(true);

    const blocked = await acquireXoLease({
      principal: OTHER_XO,
      holder_id: 'holder-b',
      holder_token: 'token-b',
    });
    expect(blocked).toEqual({ ok: false, reason: 'xo_lease_reserved_for_successor' });
    const rejected = await db.query<{ event_type: string; details: string }>(
      "SELECT event_type, details FROM board_audit_events WHERE event_type = 'xo_lease_acquire_rejected'"
    );
    expect(rejected.rows).toHaveLength(1);
    expect(JSON.parse(rejected.rows[0]?.details ?? '{}')).toEqual({
      reason: 'xo_lease_reserved_for_successor',
    });

    await db.query('UPDATE board_xo_leases SET handoff_reserved_until = $1 WHERE id = 1', [
      '2000-01-01T00:00:00.000Z',
    ]);
    const allowed = await acquireXoLease({
      principal: OTHER_XO,
      holder_id: 'holder-b',
      holder_token: 'token-b',
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.lease?.principal_id).toBe(OTHER_XO.principal_id);
    expect(allowed.lease?.fencing_token).toBe(fencingToken + 1);
    const row = await leaseSnapshot();
    expect(row.handoff_successor_principal_id).toBeNull();
  });

  test('stale fence, bad successors, and a missing lease are rejected without mutation', async () => {
    const held = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
    });
    const fencingToken = held.lease?.fencing_token ?? 0;
    const active = await leaseSnapshot();
    const auditsBefore = (await db.query('SELECT id FROM board_audit_events')).rowCount;

    const stale = await directXoLeaseHandoff({
      principal: JOHN,
      expected_fencing_token: fencingToken - 1,
      successor_principal_id: SUCCESSOR.principal_id,
      isEligibleSuccessor: eligibleSuccessor,
    });
    const missing = await directXoLeaseHandoff({
      principal: JOHN,
      expected_fencing_token: fencingToken,
      successor_principal_id: 'xo-missing',
      isEligibleSuccessor: eligibleSuccessor,
    });
    const disabled = await directXoLeaseHandoff({
      principal: JOHN,
      expected_fencing_token: fencingToken,
      successor_principal_id: 'xo-disabled',
      isEligibleSuccessor: eligibleSuccessor,
    });
    const johnSeat = await directXoLeaseHandoff({
      principal: JOHN,
      expected_fencing_token: fencingToken,
      successor_principal_id: 'john-seat-successor',
      isEligibleSuccessor: eligibleSuccessor,
    });
    const alreadyHolds = await directXoLeaseHandoff({
      principal: JOHN,
      expected_fencing_token: fencingToken,
      successor_principal_id: XO.principal_id,
      isEligibleSuccessor: eligibleSuccessor,
    });
    const invalidReservation = await directXoLeaseHandoff({
      principal: JOHN,
      expected_fencing_token: fencingToken,
      successor_principal_id: SUCCESSOR.principal_id,
      reservation_ms: 3_600_001,
      isEligibleSuccessor: eligibleSuccessor,
    });

    expect(stale).toEqual({ ok: false, reason: 'stale_xo_lease_token' });
    expect(missing).toEqual({ ok: false, reason: 'ineligible_successor_principal' });
    expect(disabled).toEqual({ ok: false, reason: 'ineligible_successor_principal' });
    expect(johnSeat).toEqual({ ok: false, reason: 'ineligible_successor_principal' });
    expect(alreadyHolds).toEqual({ ok: false, reason: 'successor_already_holds_lease' });
    expect(invalidReservation).toEqual({ ok: false, reason: 'invalid_reservation_ms' });
    expect(await leaseSnapshot()).toEqual(active);
    expect((await db.query('SELECT id FROM board_audit_events')).rowCount).toBe(auditsBefore);

    const nonJohn = await directXoLeaseHandoff({
      principal: GENERAL,
      expected_fencing_token: fencingToken,
      successor_principal_id: SUCCESSOR.principal_id,
      isEligibleSuccessor: eligibleSuccessor,
    });
    const sameSeat = await directXoLeaseHandoff({
      principal: XO,
      expected_fencing_token: fencingToken,
      successor_principal_id: SUCCESSOR.principal_id,
      isEligibleSuccessor: eligibleSuccessor,
    });
    expect(nonJohn).toEqual({ ok: false, reason: 'handoff_requires_john_seat' });
    expect(sameSeat).toEqual({ ok: false, reason: 'handoff_requires_john_seat' });
    expect(await leaseSnapshot()).toEqual(active);

    const released = await releaseXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      fencing_token: fencingToken,
    });
    expect(released.ok).toBe(true);
    const inactive = await leaseSnapshot();
    const auditsAfterRelease = (await db.query('SELECT id FROM board_audit_events')).rowCount;
    const noLease = await directXoLeaseHandoff({
      principal: JOHN,
      expected_fencing_token: fencingToken,
      successor_principal_id: SUCCESSOR.principal_id,
      isEligibleSuccessor: eligibleSuccessor,
    });
    expect(noLease).toEqual({ ok: false, reason: 'no_active_xo_lease' });
    expect(await leaseSnapshot()).toEqual(inactive);
    expect((await db.query('SELECT id FROM board_audit_events')).rowCount).toBe(auditsAfterRelease);
  });
});
