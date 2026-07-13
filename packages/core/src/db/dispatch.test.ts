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
  cancelMessage,
  claimMessage,
  createMessage,
  evaluateWorkerStaleness,
  heartbeatWorker,
  listMessages,
  postResult,
  registerWorker,
  resolveDispatchRecipient,
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

  test('board alias list records one deferral while no XO lease exists', async () => {
    await createMessage({
      correlation_id: 'corr-board-deferral',
      idempotency_key: 'board-motion:M-28:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:board',
      task_type: 'board_motion',
      sender: 'gpt',
      recipient: 'board',
      body: '{"motion_id":"M-28","title":"T","file_path":"docs/board/motions/M.md"}',
      recipient_alias: 'board',
      motion_id: 'M-28',
      motion_revision_sha: 'a'.repeat(40),
    });

    await listMessages({ recipient: 'claude', status: 'queued', allowBoardAlias: true });
    await listMessages({ recipient: 'claude', status: 'queued', allowBoardAlias: true });

    const events = await db.query<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM board_audit_events
       WHERE event_type = 'board_recipient_deferred'`
    );
    expect(Number(events.rows[0]?.count ?? 0)).toBe(1);
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

    const listed = await listMessages({
      recipient: 'claude',
      status: 'queued',
      allowBoardAlias: true,
    });
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
