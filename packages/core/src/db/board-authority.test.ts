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
  getCurrentXoLease,
  releaseXoLease,
  renewXoLease,
  resolveBoardRecipient,
  type BoardPrincipal,
} from './board-authority';

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

  // The XO lease client (bdc-xo scripts/xo-lease/xo-lease.ps1) verifies its holder proof on every
  // ensure by calling acquire with the same holder_id and token. That is only safe because the
  // server treats it as a read: same holder_id + token hash on an ACTIVE lease returns the existing
  // lease with no UPDATE and no audit row (acquireXoLease, the early return before any write).
  test('re-acquire by the same holder and token on an active lease changes nothing and writes no audit row', async () => {
    const first = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      lease_duration_ms: 60_000,
    });
    expect(first.ok).toBe(true);
    const leaseBefore = await db.query('SELECT * FROM board_xo_leases WHERE id = 1');
    const auditBefore = await db.query('SELECT * FROM board_audit_events ORDER BY created_at, id');
    expect(auditBefore.rows).toHaveLength(1);

    // a different (longer) duration must not extend an existing lease either
    const again = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      lease_duration_ms: 3_600_000,
    });

    expect(again.ok).toBe(true);
    expect(again.lease).toEqual(first.lease);
    expect((await db.query('SELECT * FROM board_xo_leases WHERE id = 1')).rows).toEqual(
      leaseBefore.rows
    );
    expect(
      (await db.query('SELECT * FROM board_audit_events ORDER BY created_at, id')).rows
    ).toEqual(auditBefore.rows);
  });

  test('re-acquire with the right holder_id but a wrong token is rejected and only adds the rejection audit row', async () => {
    const first = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      lease_duration_ms: 60_000,
    });
    expect(first.ok).toBe(true);
    const leaseBefore = await db.query('SELECT * FROM board_xo_leases WHERE id = 1');

    const wrong = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-WRONG',
    });

    expect(wrong).toEqual({ ok: false, reason: 'active_xo_lease_exists' });
    expect((await db.query('SELECT * FROM board_xo_leases WHERE id = 1')).rows).toEqual(
      leaseBefore.rows
    );
    // Insertion order is the rowid. created_at has millisecond resolution and the two rows can share a
    // millisecond; ordering the tie by the random uuid id made this test order-flaky.
    const events = await db.query<{ event_type: string }>(
      'SELECT event_type FROM board_audit_events ORDER BY created_at, rowid'
    );
    expect(events.rows.map(row => row.event_type)).toEqual([
      'xo_lease_acquired',
      'xo_lease_acquire_rejected',
    ]);
  });

  test('audit rows that share a millisecond read back in insertion order with the rowid tiebreak, not the random id', async () => {
    // Reproduces the order flake deterministically: identical created_at, ids in REVERSE insertion order.
    const at = '2026-11-09T17:00:00.000Z';
    for (const [id, eventType] of [
      ['zzzzzzzz-first', 'xo_lease_acquired'],
      ['aaaaaaaa-second', 'xo_lease_acquire_rejected'],
    ] as const) {
      await db.query(
        'INSERT INTO board_audit_events (id, event_type, created_at) VALUES ($1, $2, $3)',
        [id, eventType, at]
      );
    }
    const byId = await db.query<{ event_type: string }>(
      'SELECT event_type FROM board_audit_events WHERE created_at = $1 ORDER BY created_at, id',
      [at]
    );
    const byRowid = await db.query<{ event_type: string }>(
      'SELECT event_type FROM board_audit_events WHERE created_at = $1 ORDER BY created_at, rowid',
      [at]
    );
    // the id tiebreak misorders a same-millisecond pair; the rowid tiebreak is insertion order
    expect(byId.rows.map(row => row.event_type)).toEqual([
      'xo_lease_acquire_rejected',
      'xo_lease_acquired',
    ]);
    expect(byRowid.rows.map(row => row.event_type)).toEqual([
      'xo_lease_acquired',
      'xo_lease_acquire_rejected',
    ]);
  });

  test('the same holder re-acquiring an EXPIRED lease takes it over with fence plus one and a new lease id', async () => {
    const first = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      lease_duration_ms: 1,
    });
    expect(first.lease?.fencing_token).toBe(1);

    await Bun.sleep(10);
    const second = await acquireXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      lease_duration_ms: 60_000,
    });

    expect(second.ok).toBe(true);
    expect(second.lease?.fencing_token).toBe(2);
    expect(second.lease?.lease_id).not.toBe(first.lease?.lease_id);
    expect(second.lease?.holder_id).toBe('holder-a');
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
});
