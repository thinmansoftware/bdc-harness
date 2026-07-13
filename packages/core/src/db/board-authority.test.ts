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

    const renewed = await renewXoLease({
      principal: XO,
      holder_id: 'holder-a',
      holder_token: 'token-a',
      fencing_token: first.lease?.fencing_token ?? 0,
    });
    expect(renewed.ok).toBe(true);
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
