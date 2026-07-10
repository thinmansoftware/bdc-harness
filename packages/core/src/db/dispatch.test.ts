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
  postResult,
  registerWorker,
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
});
