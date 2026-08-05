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
  acknowledgeMessage,
  addressMessage,
  cancelMessage,
  claimMessage,
  createMessage,
  evaluateWorkerStaleness,
  getMessage,
  heartbeatWorker,
  listMessages,
  listUnroutableQueuedMessages,
  listWorkers,
  postResult,
  registerWorker,
  renewMessageLease,
  resolveDispatchRecipient,
  assessDispatchRecipient,
} from './dispatch';

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

describe('dispatch db', () => {
  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('deduplicates repeated idempotency_key posts', async () => {
    const first = await createMessage({
      correlation_id: 'corr-1',
      idempotency_key: 'idem-1',
      task_type: 'agent_message',
      sender: 'claude',
      recipient: 'codex',
      body: 'Say hello',
    });
    const second = await createMessage({
      correlation_id: 'corr-2',
      idempotency_key: 'idem-1',
      task_type: 'agent_message',
      sender: 'claude',
      recipient: 'codex',
      body: 'This should not enqueue twice',
    });

    expect(second.id).toBe(first.id);
    expect(second.correlation_id).toBe('corr-1');
    const rows = await db.query('SELECT id FROM agent_dispatch_messages');
    expect(rows.rowCount).toBe(1);
  });

  test('assesses canonical recipients and rejects missing or inactive principals', async () => {
    await expect(assessDispatchRecipient(' Operator ')).resolves.toEqual({
      ok: true,
      canonical_principal: 'operator',
      delivery_mode: 'drain_on_start',
      reason: null,
    });
    await expect(assessDispatchRecipient(' john ')).resolves.toEqual({
      ok: false,
      canonical_principal: 'john',
      delivery_mode: 'notify_only',
      reason: 'inactive_principal',
    });
    await expect(assessDispatchRecipient(' Missing ')).resolves.toEqual({
      ok: false,
      canonical_principal: 'missing',
      delivery_mode: null,
      reason: 'missing_principal',
    });
  });

  test('guards new recipients while retaining idempotent creates and board metadata', async () => {
    const original = await createMessage({
      correlation_id: 'corr-idempotent-active',
      idempotency_key: 'idem-idempotent-active',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Original mailbox message.',
    });
    await db.query("UPDATE dispatch_principals SET active = 0 WHERE principal_id = 'operator'");

    const retry = await createMessage({
      correlation_id: 'corr-idempotent-inactive',
      idempotency_key: 'idem-idempotent-active',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Must return original before recipient assessment.',
    });
    expect(retry.id).toBe(original.id);
    await expect(
      createMessage({
        correlation_id: 'corr-inactive',
        idempotency_key: 'idem-inactive',
        task_type: 'agent_message',
        sender: 'xo',
        recipient: 'operator',
        body: 'New inactive recipient message.',
      })
    ).rejects.toThrow('inactive_principal');
    await expect(
      createMessage({
        correlation_id: 'corr-missing',
        idempotency_key: 'idem-missing',
        task_type: 'agent_message',
        sender: 'xo',
        recipient: 'missing',
        body: 'Unknown recipient message.',
      })
    ).rejects.toThrow('missing_principal');
    await expect(
      createMessage({
        correlation_id: 'corr-board-without-metadata',
        idempotency_key: 'idem-board-without-metadata',
        task_type: 'board_motion',
        sender: 'xo',
        recipient: ' Board ',
        body: 'Board message without alias metadata.',
      })
    ).rejects.toThrow('board_alias_metadata_required');
    const board = await createMessage({
      correlation_id: 'corr-board-with-metadata',
      idempotency_key: 'idem-board-with-metadata',
      task_type: 'board_motion',
      sender: 'xo',
      recipient: ' Board ',
      body: 'Board message with alias metadata.',
      recipient_alias: 'board',
    });
    expect(board.recipient).toBe('board');
  });

  test('keeps worker polling claimable and rejects mailbox delivery modes', async () => {
    await registerWorker({
      worker_id: 'worker-mode-guard',
      host: 'host',
      capabilities: {},
      max_concurrency: 1,
    });
    const workerMessage = await createMessage({
      correlation_id: 'corr-worker-mode',
      idempotency_key: 'idem-worker-mode',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'codex',
      body: 'Worker poll message.',
    });
    const mailboxMessage = await createMessage({
      correlation_id: 'corr-mailbox-mode',
      idempotency_key: 'idem-mailbox-mode',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'overseer',
      body: 'Notify-only mailbox message.',
    });

    expect(
      (await claimMessage({ id: workerMessage.id, worker_id: 'worker-mode-guard' }))?.status
    ).toBe('claimed');
    expect(
      await claimMessage({ id: mailboxMessage.id, worker_id: 'worker-mode-guard' })
    ).toBeNull();
  });

  test('acknowledges mailbox messages once without changing queue or address state', async () => {
    const message = await createMessage({
      correlation_id: 'corr-ack',
      idempotency_key: 'idem-ack',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Acknowledge me.',
      priority: 'blocker',
    });

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        acknowledgeMessage({ id: message.id, principal_id: 'operator' })
      )
    );
    expect(results.every(result => result.ok)).toBe(true);
    const stored = await getMessage(message.id);
    expect(stored).toMatchObject({
      status: 'queued',
      acknowledged_by: 'operator',
      addressed_at: null,
      addressed_by: null,
    });
    expect(stored?.acknowledged_at).not.toBeNull();
    expect((await acknowledgeMessage({ id: message.id, principal_id: 'operator' })).ok).toBe(true);
  });

  test('acknowledgement revalidates stale recipient state after a guarded update loses', async () => {
    const message = await createMessage({
      correlation_id: 'corr-ack-stale-recipient',
      idempotency_key: 'idem-ack-stale-recipient',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Stale recipient target.',
    });
    const staleMessage = { ...message, recipient: 'codex' };
    const originalDb = db;
    const updateSql: string[] = [];
    let readCount = 0;
    const query = async <T>(sql: string): Promise<{ rows: readonly T[]; rowCount: number }> => {
      if (sql.startsWith('SELECT * FROM agent_dispatch_messages')) {
        readCount += 1;
        const row = readCount === 1 ? message : staleMessage;
        return { rows: [row as T], rowCount: 1 };
      }
      if (sql.startsWith('SELECT principal_id, delivery_mode, active')) {
        return {
          rows: [{ principal_id: 'operator', delivery_mode: 'drain_on_start', active: 1 } as T],
          rowCount: 1,
        };
      }
      if (sql.startsWith('UPDATE agent_dispatch_messages')) {
        updateSql.push(sql);
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    db = {
      ...originalDb,
      query,
      withTransaction: async fn => fn(query),
    } as SqliteAdapter;

    try {
      await expect(
        acknowledgeMessage({ id: message.id, principal_id: 'operator' })
      ).resolves.toEqual({ ok: false, reason: 'wrong_recipient' });
      expect(updateSql[0]).toContain('LOWER(TRIM(COALESCE(resolved_recipient, recipient))) = $3');
      expect(updateSql[0]).toContain("delivery_mode IN ('drain_on_start', 'notify_only')");
    } finally {
      db = originalDb;
    }
  });

  test('concurrent acknowledgement through independent SQLite connections is idempotent', async () => {
    const message = await createMessage({
      correlation_id: 'corr-ack-independent-connections',
      idempotency_key: 'idem-ack-independent-connections',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Independent connection target.',
    });
    const primaryDb = db;
    const independentDb = new SqliteAdapter(currentDbPath);
    try {
      db = primaryDb;
      const first = acknowledgeMessage({ id: message.id, principal_id: 'operator' });
      db = independentDb;
      const second = acknowledgeMessage({ id: message.id, principal_id: 'operator' });
      const results = await Promise.all([first, second]);

      expect(results.every(result => result.ok)).toBe(true);
    } finally {
      db = primaryDb;
      await independentDb.close();
    }
  });

  test('returns every acknowledgement conflict outcome', async () => {
    const mailbox = await createMessage({
      correlation_id: 'corr-ack-conflicts',
      idempotency_key: 'idem-ack-conflicts',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'xo',
      body: 'Mailbox conflict target.',
    });
    const worker = await createMessage({
      correlation_id: 'corr-ack-worker',
      idempotency_key: 'idem-ack-worker',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'codex',
      body: 'Worker conflict target.',
    });
    const nonQueued = await createMessage({
      correlation_id: 'corr-ack-nonqueued',
      idempotency_key: 'idem-ack-nonqueued',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Non-queued conflict target.',
    });
    await db.query("UPDATE agent_dispatch_messages SET status = 'done' WHERE id = $1", [
      nonQueued.id,
    ]);

    await expect(acknowledgeMessage({ id: 'missing', principal_id: 'operator' })).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
    await expect(acknowledgeMessage({ id: mailbox.id, principal_id: 'operator' })).resolves.toEqual(
      {
        ok: false,
        reason: 'wrong_recipient',
      }
    );
    await expect(acknowledgeMessage({ id: worker.id, principal_id: 'codex' })).resolves.toEqual({
      ok: false,
      reason: 'wrong_mode',
    });
    await expect(
      acknowledgeMessage({ id: nonQueued.id, principal_id: 'operator' })
    ).resolves.toEqual({
      ok: false,
      reason: 'not_queued',
    });
    expect((await acknowledgeMessage({ id: mailbox.id, principal_id: 'xo' })).ok).toBe(true);
    await expect(acknowledgeMessage({ id: mailbox.id, principal_id: 'xo-fable' })).resolves.toEqual(
      {
        ok: false,
        reason: 'wrong_recipient',
      }
    );
  });

  test('addresses only acknowledged mail by its acknowledger and is idempotent', async () => {
    const message = await createMessage({
      correlation_id: 'corr-address',
      idempotency_key: 'idem-address',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Address me.',
    });
    await expect(addressMessage({ id: message.id, principal_id: 'operator' })).resolves.toEqual({
      ok: false,
      reason: 'address_before_ack',
    });
    expect((await acknowledgeMessage({ id: message.id, principal_id: 'operator' })).ok).toBe(true);
    await expect(addressMessage({ id: message.id, principal_id: 'xo' })).resolves.toEqual({
      ok: false,
      reason: 'wrong_recipient',
    });
    await expect(
      addressMessage({ id: message.id, principal_id: 'operator' })
    ).resolves.toMatchObject({
      ok: true,
    });
    const repeats = await Promise.all(
      Array.from({ length: 3 }, () => addressMessage({ id: message.id, principal_id: 'operator' }))
    );
    expect(repeats.every(result => result.ok)).toBe(true);
    const stored = await getMessage(message.id);
    expect(stored).toMatchObject({
      status: 'queued',
      acknowledged_by: 'operator',
      addressed_by: 'operator',
    });
    expect(stored?.addressed_at).not.toBeNull();
  });

  test('addressing revalidates final status when a guarded update loses to cancellation', async () => {
    const message = await createMessage({
      correlation_id: 'corr-address-stale-status',
      idempotency_key: 'idem-address-stale-status',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Stale status target.',
    });
    const acknowledged = {
      ...message,
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: 'operator',
    };
    const cancelled = { ...acknowledged, status: 'cancelled' as const };
    const originalDb = db;
    const updateSql: string[] = [];
    let readCount = 0;
    const query = async <T>(sql: string): Promise<{ rows: readonly T[]; rowCount: number }> => {
      if (sql.startsWith('SELECT * FROM agent_dispatch_messages')) {
        readCount += 1;
        const row = readCount === 1 ? acknowledged : cancelled;
        return { rows: [row as T], rowCount: 1 };
      }
      if (sql.startsWith('SELECT principal_id, delivery_mode, active')) {
        return {
          rows: [{ principal_id: 'operator', delivery_mode: 'drain_on_start', active: 1 } as T],
          rowCount: 1,
        };
      }
      if (sql.startsWith('UPDATE agent_dispatch_messages')) {
        updateSql.push(sql);
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    db = {
      ...originalDb,
      query,
      withTransaction: async fn => fn(query),
    } as SqliteAdapter;

    try {
      await expect(addressMessage({ id: message.id, principal_id: 'operator' })).resolves.toEqual({
        ok: false,
        reason: 'not_queued',
      });
      expect(updateSql[0]).toContain('LOWER(TRIM(COALESCE(resolved_recipient, recipient))) = $3');
      expect(updateSql[0]).toContain("delivery_mode IN ('drain_on_start', 'notify_only')");
    } finally {
      db = originalDb;
    }
  });

  test('returns address actor, mode, state, and existence conflict outcomes', async () => {
    const mailbox = await createMessage({
      correlation_id: 'corr-address-conflicts',
      idempotency_key: 'idem-address-conflicts',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Address conflict target.',
    });
    const worker = await createMessage({
      correlation_id: 'corr-address-worker',
      idempotency_key: 'idem-address-worker',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'codex',
      body: 'Address worker target.',
    });
    const nonQueued = await createMessage({
      correlation_id: 'corr-address-nonqueued',
      idempotency_key: 'idem-address-nonqueued',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Address non-queued target.',
    });
    await db.query("UPDATE agent_dispatch_messages SET status = 'done' WHERE id = $1", [
      nonQueued.id,
    ]);
    expect((await acknowledgeMessage({ id: mailbox.id, principal_id: 'operator' })).ok).toBe(true);

    await expect(addressMessage({ id: 'missing', principal_id: 'operator' })).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
    await expect(addressMessage({ id: worker.id, principal_id: 'codex' })).resolves.toEqual({
      ok: false,
      reason: 'wrong_mode',
    });
    await expect(addressMessage({ id: nonQueued.id, principal_id: 'operator' })).resolves.toEqual({
      ok: false,
      reason: 'not_queued',
    });
    await expect(addressMessage({ id: mailbox.id, principal_id: 'xo' })).resolves.toEqual({
      ok: false,
      reason: 'wrong_recipient',
    });
    await db.query("UPDATE agent_dispatch_messages SET acknowledged_by = 'xo' WHERE id = $1", [
      mailbox.id,
    ]);
    await expect(addressMessage({ id: mailbox.id, principal_id: 'operator' })).resolves.toEqual({
      ok: false,
      reason: 'actor_mismatch',
    });
  });

  test('lists only due unaddressed queued work by priority while retaining historical queries', async () => {
    const blocker = await createMessage({
      correlation_id: 'corr-list-blocker',
      idempotency_key: 'idem-list-blocker',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Blocker.',
      priority: 'blocker',
    });
    const normal = await createMessage({
      correlation_id: 'corr-list-normal',
      idempotency_key: 'idem-list-normal',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Normal.',
      priority: 'normal',
    });
    const heartbeat = await createMessage({
      correlation_id: 'corr-list-heartbeat',
      idempotency_key: 'idem-list-heartbeat',
      task_type: 'run_report',
      sender: 'xo',
      recipient: 'operator',
      body: 'Heartbeat.',
      priority: 'heartbeat',
    });
    const future = await createMessage({
      correlation_id: 'corr-list-future',
      idempotency_key: 'idem-list-future',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Future.',
      not_before: new Date(Date.now() + 60_000).toISOString(),
      priority: 'blocker',
    });
    const addressed = await createMessage({
      correlation_id: 'corr-list-addressed',
      idempotency_key: 'idem-list-addressed',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Addressed.',
      priority: 'blocker',
    });
    await acknowledgeMessage({ id: addressed.id, principal_id: 'operator' });
    await addressMessage({ id: addressed.id, principal_id: 'operator' });
    await acknowledgeMessage({ id: blocker.id, principal_id: 'operator' });
    const historical = await createMessage({
      correlation_id: 'corr-list-historical',
      idempotency_key: 'idem-list-historical',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Historical.',
    });
    await db.query("UPDATE agent_dispatch_messages SET status = 'done' WHERE id = $1", [
      historical.id,
    ]);

    const queued = await listMessages({ recipient: 'operator', status: 'queued' });
    expect(queued.map(message => message.id)).toEqual([blocker.id, normal.id, heartbeat.id]);
    expect(queued.map(message => message.id)).not.toContain(future.id);
    expect(queued.map(message => message.id)).not.toContain(addressed.id);
    expect(
      (await listMessages({ recipient: 'operator', status: 'done' })).map(message => message.id)
    ).toContain(historical.id);
  });

  test('reports only queued concrete recipients that are missing or inactive without mutation', async () => {
    const inactive = await createMessage({
      correlation_id: 'corr-unroutable-inactive',
      idempotency_key: 'idem-unroutable-inactive',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'operator',
      body: 'Become inactive after enqueue.',
      priority: 'blocker',
    });
    await db.query("UPDATE dispatch_principals SET active = 0 WHERE principal_id = 'operator'");
    await db.query(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, priority, created_at, fencing_token)
       VALUES ('missing-recipient', 'corr-unroutable-missing', 'idem-unroutable-missing', 'agent_message', 'xo', 'missing', 'No body in report.', 'queued', 'normal', $1, 0)`,
      [new Date().toISOString()]
    );
    const writes: string[] = [];
    const query = async <T>(sql: string, params?: unknown[]) => {
      writes.push(sql);
      return db.query<T>(sql, params);
    };

    const rows = await listUnroutableQueuedMessages(query);

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: inactive.id, recipient: 'operator', priority: 'blocker' }),
        expect.objectContaining({
          id: 'missing-recipient',
          recipient: 'missing',
          priority: 'normal',
        }),
      ])
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toStartWith('SELECT');
  });

  test('uses a PostgreSQL-compatible inactive-principal predicate for unroutable reporting', async () => {
    const queries: string[] = [];
    const rows = await listUnroutableQueuedMessages(async <T>(sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 } as { rows: readonly T[]; rowCount: number };
    });

    expect(rows).toEqual([]);
    expect(queries[0]).toContain("CAST(principal.active AS TEXT) IN ('0', 'false')");
  });

  test('rejects stale fencing token result after lease expiry and reclaim', async () => {
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host-a',
      capabilities: { providers: ['codex'] },
      max_concurrency: 1,
    });
    await registerWorker({
      worker_id: 'worker-b',
      host: 'host-b',
      capabilities: { providers: ['codex'] },
      max_concurrency: 1,
    });
    const message = await createMessage({
      correlation_id: 'corr-lease',
      idempotency_key: 'idem-lease',
      task_type: 'agent_message',
      sender: 'claude',
      recipient: 'codex',
      body: 'Review this.',
    });

    const firstClaim = await claimMessage({
      id: message.id,
      worker_id: 'worker-a',
      leaseDurationMs: 1,
    });
    expect(firstClaim?.fencing_token).toBe(1);

    await Bun.sleep(10);
    const secondClaim = await claimMessage({
      id: message.id,
      worker_id: 'worker-b',
      leaseDurationMs: 60_000,
    });
    expect(secondClaim?.fencing_token).toBe(2);

    const staleResult = await postResult({
      id: message.id,
      worker_id: 'worker-a',
      fencing_token: 1,
      result_body: 'late',
    });
    expect(staleResult).toBeNull();
  });

  test('renewMessageLease keeps a long run claimed past its original lease', async () => {
    // WO-HARNESS-ACP-DISPATCH-SLICE-01 / M-118 order 4. Regression target: an
    // agent leg running longer than lease_duration_ms used to become silently
    // reclaimable by another worker mid-run.
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host-a',
      capabilities: { providers: ['grok'] },
      max_concurrency: 1,
    });
    await registerWorker({
      worker_id: 'worker-b',
      host: 'host-b',
      capabilities: { providers: ['grok'] },
      max_concurrency: 1,
    });
    const message = await createMessage({
      correlation_id: 'corr-renew',
      idempotency_key: 'idem-renew',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'grok',
      body: 'Long ACP run.',
    });

    const claim = await claimMessage({
      id: message.id,
      worker_id: 'worker-a',
      leaseDurationMs: 30,
    });
    expect(claim?.fencing_token).toBe(1);

    const renewed = await renewMessageLease({
      id: message.id,
      worker_id: 'worker-a',
      fencing_token: claim?.fencing_token ?? 0,
      leaseDurationMs: 60_000,
    });
    // Renewal must NOT bump the token -- it is not a new claim.
    expect(renewed?.fencing_token).toBe(1);
    expect(renewed?.status).toBe('claimed');

    await Bun.sleep(50);
    // Past the ORIGINAL 30ms lease: without renewal worker-b would steal it.
    const steal = await claimMessage({
      id: message.id,
      worker_id: 'worker-b',
      leaseDurationMs: 60_000,
    });
    expect(steal).toBeNull();

    // The original owner still completes with its original token.
    const done = await postResult({
      id: message.id,
      worker_id: 'worker-a',
      fencing_token: 1,
      result_body: 'finished after renewal',
    });
    expect(done?.status).toBe('done');
  });

  test('renewMessageLease rejects non-owner, stale token, and unclaimed messages', async () => {
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host-a',
      capabilities: { providers: ['grok'] },
      max_concurrency: 1,
    });
    const message = await createMessage({
      correlation_id: 'corr-renew-guard',
      idempotency_key: 'idem-renew-guard',
      task_type: 'agent_message',
      sender: 'xo',
      recipient: 'grok',
      body: 'Guarded.',
    });

    // Not claimed yet -> nothing to renew.
    expect(
      await renewMessageLease({ id: message.id, worker_id: 'worker-a', fencing_token: 1 })
    ).toBeNull();

    const claim = await claimMessage({ id: message.id, worker_id: 'worker-a' });
    expect(claim?.status).toBe('claimed');

    // Wrong owner.
    expect(
      await renewMessageLease({ id: message.id, worker_id: 'worker-b', fencing_token: 1 })
    ).toBeNull();
    // Stale token.
    expect(
      await renewMessageLease({ id: message.id, worker_id: 'worker-a', fencing_token: 99 })
    ).toBeNull();

    // Cancelled message is no longer renewable.
    await cancelMessage(message.id);
    expect(
      await renewMessageLease({ id: message.id, worker_id: 'worker-a', fencing_token: 1 })
    ).toBeNull();
  });

  test('cancel wins over late claimant result', async () => {
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host-a',
      capabilities: { providers: ['codex'] },
      max_concurrency: 1,
    });
    const message = await createMessage({
      correlation_id: 'corr-cancel',
      idempotency_key: 'idem-cancel',
      task_type: 'agent_message',
      sender: 'claude',
      recipient: 'codex',
      body: 'Summarize.',
    });
    const claim = await claimMessage({ id: message.id, worker_id: 'worker-a' });
    expect(claim?.status).toBe('claimed');

    const cancelled = await cancelMessage(message.id);
    expect(cancelled?.status).toBe('cancelled');
    const late = await postResult({
      id: message.id,
      worker_id: 'worker-a',
      fencing_token: claim?.fencing_token ?? 0,
      result_body: 'too late',
    });
    expect(late).toBeNull();
  });

  test('offline worker cannot claim until heartbeat/register makes it available again', async () => {
    await registerWorker({
      worker_id: 'worker-offline',
      host: 'host',
      capabilities: { providers: ['codex'] },
      max_concurrency: 1,
    });
    await db.query(
      `UPDATE agent_dispatch_workers
       SET last_heartbeat_at = $2
       WHERE worker_id = $1`,
      ['worker-offline', new Date(Date.now() - 10_000).toISOString()]
    );
    await evaluateWorkerStaleness(1_000);
    const message = await createMessage({
      correlation_id: 'corr-offline',
      idempotency_key: 'idem-offline',
      task_type: 'agent_message',
      sender: 'claude',
      recipient: 'codex',
      body: 'Queued while offline.',
    });

    const offlineClaim = await claimMessage({
      id: message.id,
      worker_id: 'worker-offline',
      workerStaleAfterMs: 1_000,
    });
    expect(offlineClaim).toBeNull();

    const heartbeat = await heartbeatWorker({ worker_id: 'worker-offline' });
    expect(heartbeat?.status).toBe('available');
    const onlineClaim = await claimMessage({
      id: message.id,
      worker_id: 'worker-offline',
      workerStaleAfterMs: 1_000,
    });
    expect(onlineClaim?.status).toBe('claimed');
  });

  test('listWorkers expires stale available rows before reporting health', async () => {
    await registerWorker({
      worker_id: 'worker-stale',
      host: 'host-stale',
      capabilities: { providers: ['codex'] },
      max_concurrency: 1,
    });
    await registerWorker({
      worker_id: 'worker-fresh',
      host: 'host-fresh',
      capabilities: { providers: ['claude'] },
      max_concurrency: 1,
    });
    await db.query(
      `UPDATE agent_dispatch_workers
       SET last_heartbeat_at = $2
       WHERE worker_id = $1`,
      ['worker-stale', new Date(Date.now() - 10_000).toISOString()]
    );

    const workers = await listWorkers(1_000);

    expect(workers.find(worker => worker.worker_id === 'worker-stale')?.status).toBe('unavailable');
    expect(workers.find(worker => worker.worker_id === 'worker-fresh')?.status).toBe('available');
  });

  test('resolveDispatchRecipient preserves concrete recipients', async () => {
    await expect(resolveDispatchRecipient('codex')).resolves.toEqual({
      ok: true,
      recipient: 'codex',
      recipient_alias: null,
      resolved_xo_lease_id: null,
      resolved_xo_fencing_token: null,
    });
  });

  test('board alias resolves only with a current XO lease', async () => {
    await expect(resolveDispatchRecipient('board')).resolves.toEqual({
      ok: false,
      reason: 'no_valid_xo_lease',
    });
    const now = new Date();
    await db.query(
      `INSERT INTO board_xo_leases (
         id, lease_id, principal_id, seat_id, holder_id, holder_token_hash,
         fencing_token, acquired_at, renewed_at, expires_at, released_at
       )
       VALUES (1, $1, 'claude', 'xo', 'holder', $2, 7, $3, NULL, $4, NULL)`,
      ['lease-1', 'a'.repeat(64), now.toISOString(), new Date(now.getTime() + 60_000).toISOString()]
    );

    await expect(resolveDispatchRecipient('board')).resolves.toEqual({
      ok: true,
      recipient: 'claude',
      recipient_alias: 'board',
      resolved_xo_lease_id: 'lease-1',
      resolved_xo_fencing_token: 7,
    });
  });

  test('board alias list and claim bind the current XO lease', async () => {
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host',
      capabilities: { providers: ['claude'] },
      max_concurrency: 1,
    });
    const now = new Date();
    await db.query(
      `INSERT INTO board_xo_leases (
         id, lease_id, principal_id, seat_id, holder_id, holder_token_hash,
         fencing_token, acquired_at, renewed_at, expires_at, released_at
       )
       VALUES (1, $1, 'claude', 'xo', 'holder', $2, 11, $3, NULL, $4, NULL)`,
      [
        'lease-claim',
        'b'.repeat(64),
        now.toISOString(),
        new Date(now.getTime() + 60_000).toISOString(),
      ]
    );
    const message = await createMessage({
      correlation_id: 'corr-board',
      idempotency_key: 'board-motion:M-27:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:board',
      task_type: 'board_motion',
      sender: 'gpt',
      recipient: 'board',
      body: '{"motion_id":"M-27","title":"T","file_path":"docs/board/motions/M.md"}',
      recipient_alias: 'board',
      motion_id: 'M-27',
      motion_revision_sha: 'a'.repeat(40),
    });

    const listed = await import('./dispatch').then(module =>
      module.listMessages({ recipient: 'claude', status: 'queued', allowBoardAlias: true })
    );
    expect(listed.map(item => item.id)).toContain(message.id);

    const stalePrincipalClaim = await claimMessage({
      id: message.id,
      worker_id: 'worker-a',
      delivery_principal: 'gpt',
    });
    expect(stalePrincipalClaim).toBeNull();

    const claim = await claimMessage({
      id: message.id,
      worker_id: 'worker-a',
      delivery_principal: 'claude',
    });
    expect(claim?.resolved_recipient).toBe('claude');
    expect(claim?.resolved_xo_lease_id).toBe('lease-claim');
    expect(claim?.resolved_xo_fencing_token).toBe(11);
  });
});
