/**
 * Real-SQLite proof for the supersede-at-claim boundary
 * (WO-HARNESS-OVERSEER-RECHECK-DEDUPE-PER-HEAD-01):
 *
 * - claimMessage returns claimBoundarySeq = MAX(seq) taken inside the claim
 *   transaction, and a row inserted after the claim through the real insert
 *   path gets seq > that boundary -- even when its created_at is earlier.
 * - supersedeQueuedMessageByClaim retires a queued row as cancelled +
 *   route_disposition 'superseded' with a readable reason in result_body
 *   (never a bare cancel), only when its own seq is set and <= the boundary.
 *   A NULL-seq row, a row above the boundary and a row that is no longer
 *   queued are never touched.
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

const {
  claimMessage,
  createAuthenticatedMessage,
  getMessage,
  listMessages,
  listMessagesBySeqCursor,
  registerWorker,
  supersedeQueuedMessageByClaim,
} = await import('./dispatch');

const REVIEW_RECIPIENT = 'overseer-reviewer';
const WORKER = 'overseer-review-worker';

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

/** Raw insert with an explicit seq (or NULL, like a legacy/import row). */
async function insertRow(
  id: string,
  status: 'queued' | 'claimed',
  seq: number | null,
  second = 0
): Promise<void> {
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
      new Date(Date.UTC(2026, 10, 3, 0, 0, second)).toISOString(),
      seq,
      status === 'claimed' ? WORKER : null,
    ]
  );
}

async function seqOf(id: string): Promise<number | null> {
  const row = (
    await db.query<{ seq: unknown }>('SELECT seq FROM agent_dispatch_messages WHERE id = $1', [id])
  ).rows[0];
  return row?.seq === null || row?.seq === undefined ? null : Number(row.seq);
}

describe('supersede-at-claim boundary against real SQLite', () => {
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

  test('claim boundary is taken atomically with the claim; a later insert lands above it', async () => {
    await registerWorker({ worker_id: WORKER, host: 'test', capabilities: {}, max_concurrency: 1 });
    await insertRow('dup-before', 'queued', 1, 1);
    await insertRow('to-claim', 'queued', 2, 2);
    // A legacy NULL-seq row: not counted in the boundary.
    await insertRow('legacy', 'queued', null, 3);

    const claimed = await claimMessage({ id: 'to-claim', worker_id: WORKER });
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.claimBoundarySeq).toBe(2);

    // Another writer inserts right after the claim, through the real insert
    // path, with a clock that is behind (its created_at is earlier than the
    // claim). The database still orders it after the claim.
    const later = await createAuthenticatedMessage(
      { kind: 'system', sender: 'overseer' },
      {
        correlation_id: 'corr-later',
        idempotency_key: 'idem-later',
        task_type: 'run_review',
        recipient: REVIEW_RECIPIENT,
        body: 'Inserted after the claim.',
      }
    );
    await db.query('UPDATE agent_dispatch_messages SET created_at = $2 WHERE id = $1', [
      later.id,
      new Date(Date.UTC(2020, 0, 1)).toISOString(),
    ]);
    const laterSeq = await seqOf(later.id);
    expect(laterSeq).not.toBeNull();
    expect(laterSeq ?? 0).toBeGreaterThan(claimed?.claimBoundarySeq ?? Infinity);
    expect(Date.parse((await getMessage(later.id))?.created_at ?? '')).toBeLessThan(
      Date.parse(claimed?.claimed_at ?? '')
    );

    // The keyset reader exposes each row's own seq (NULL stays NULL).
    const page = await listMessagesBySeqCursor({
      recipient: REVIEW_RECIPIENT,
      task_type: 'run_review',
      status: 'queued',
      limit: 50,
    });
    expect(page.map(row => [row.id, row.seq])).toEqual([
      ['dup-before', 1],
      ['legacy', null],
      [later.id, laterSeq],
    ]);
  });

  test('retires a queued row at or below the boundary as superseded with the claim reason', async () => {
    await insertRow('queued-dup', 'queued', 1);
    await insertRow('claimed-row', 'claimed', 2);

    const retired = await supersedeQueuedMessageByClaim({
      id: 'queued-dup',
      claimed_id: 'claimed-row',
      boundary_seq: 2,
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
    expect((await getMessage('claimed-row'))?.status).toBe('claimed');
  });

  test('never supersedes a NULL-seq row or a row above the boundary', async () => {
    await insertRow('claimed-row', 'claimed', 2);
    await insertRow('legacy', 'queued', null);
    await insertRow('after-claim', 'queued', 3);

    for (const id of ['legacy', 'after-claim']) {
      expect(
        await supersedeQueuedMessageByClaim({
          id,
          claimed_id: 'claimed-row',
          boundary_seq: 2,
          reason: 'superseded_by_claim claimed-row',
        })
      ).toBeNull();
      const row = await getMessage(id);
      expect(row?.status).toBe('queued');
      expect(row?.route_disposition).toBeNull();
      expect(row?.result_body).toBeNull();
    }
  });

  test('never touches a row that is no longer queued, nor the claimed row itself', async () => {
    await insertRow('claimed-row', 'claimed', 1);
    await insertRow('raced', 'claimed', 2);

    expect(
      await supersedeQueuedMessageByClaim({
        id: 'raced',
        claimed_id: 'claimed-row',
        boundary_seq: 5,
        reason: 'superseded_by_claim claimed-row',
      })
    ).toBeNull();
    expect(
      await supersedeQueuedMessageByClaim({
        id: 'claimed-row',
        claimed_id: 'claimed-row',
        boundary_seq: 5,
        reason: 'superseded_by_claim claimed-row',
      })
    ).toBeNull();
    const raced = await getMessage('raced');
    expect(raced?.status).toBe('claimed');
    expect(raced?.route_disposition).toBeNull();
    expect(raced?.result_body).toBeNull();
  });
});
