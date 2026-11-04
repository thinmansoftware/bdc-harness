/**
 * Real-SQLite proof for supersedeQueuedMessageByClaim
 * (WO-HARNESS-OVERSEER-RECHECK-DEDUPE-PER-HEAD-01): a queued row is retired as
 * cancelled + route_disposition 'superseded' with a readable reason in
 * result_body (never a bare cancel), it drops out of the queued worker read,
 * and a row that is no longer queued is never touched.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';

let db: SqliteAdapter;
let currentDbPath = '';

mock.module('./connection', () => ({
  getDatabase: () => db,
}));

const { getMessage, listMessages, supersedeQueuedMessageByClaim } = await import('./dispatch');

const REVIEW_RECIPIENT = 'overseer-reviewer';

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

async function insertRow(id: string, status: 'queued' | 'claimed', seq: number): Promise<void> {
  await db.query(
    `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, sender, recipient, body,
        status, created_at, priority, fencing_token, seq, lease_owner)
     VALUES ($1, $2, $3, 'run_review', 'overseer', $4, $5, $6, $7, 'normal', 0, $8, $9)`,
    [
      id,
      `pr-review:thinmansoftware/bdc-harness#1457@${'a'.repeat(40)}`,
      `pr-recheck:${id}`,
      REVIEW_RECIPIENT,
      JSON.stringify({
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: 1457,
        headSha: 'a'.repeat(40),
        baseRef: 'dev',
        author: 'contributor',
      }),
      status,
      new Date(Date.UTC(2026, 10, 3, 0, 0, seq)).toISOString(),
      seq,
      status === 'claimed' ? 'overseer-review-worker' : null,
    ]
  );
}

describe('supersedeQueuedMessageByClaim against real SQLite', () => {
  beforeEach(() => {
    process.env.BUN_ENV = 'test';
    currentDbPath = join(
      import.meta.dir,
      `.test-supersede-by-claim-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    delete process.env.BUN_ENV;
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('retires a queued row as superseded with the claim reason', async () => {
    await insertRow('claimed-row', 'claimed', 2);
    await insertRow('queued-dup', 'queued', 1);

    const retired = await supersedeQueuedMessageByClaim({
      id: 'queued-dup',
      claimed_id: 'claimed-row',
      reason: 'superseded_by_claim claimed-row',
    });

    expect(retired?.status).toBe('cancelled');
    expect(retired?.route_disposition).toBe('superseded');
    expect(retired?.completed_at).not.toBeNull();
    expect(JSON.parse(retired?.result_body ?? '{}')).toEqual({
      reason: 'superseded_by_claim claimed-row',
      superseded_by: 'claimed-row',
    });
    const queued = await listMessages({ recipient: REVIEW_RECIPIENT, status: 'queued' });
    expect(queued.map(row => row.id)).toEqual([]);
    // The claimed row is untouched.
    expect((await getMessage('claimed-row'))?.status).toBe('claimed');
  });

  test('never touches a row that is no longer queued, nor the claimed row itself', async () => {
    await insertRow('claimed-row', 'claimed', 1);
    await insertRow('raced', 'claimed', 2);

    expect(
      await supersedeQueuedMessageByClaim({
        id: 'raced',
        claimed_id: 'claimed-row',
        reason: 'superseded_by_claim claimed-row',
      })
    ).toBeNull();
    expect(
      await supersedeQueuedMessageByClaim({
        id: 'claimed-row',
        claimed_id: 'claimed-row',
        reason: 'superseded_by_claim claimed-row',
      })
    ).toBeNull();
    const raced = await getMessage('raced');
    expect(raced?.status).toBe('claimed');
    expect(raced?.route_disposition).toBeNull();
    expect(raced?.result_body).toBeNull();
  });
});
